import { Logger } from '@nestjs/common';
import {
  ConnectWatchdogStatus,
  InngestConnectWatchdogOptions,
} from '../interfaces/inngest-module.interface';

/** Subset of the SDK's `ConnectDebugState` the watchdog reads. */
export interface WatchdogDebugState {
  lastHeartbeatReceivedAt?: number;
}

export interface ConnectWatchdogDeps {
  /** SDK connection state, or null when no worker connection exists. */
  getState: () => string | null;
  /** SDK `getDebugState()` snapshot, or null when the SDK does not expose it. */
  getDebugState: () => WatchdogDebugState | null;
  /** Whether the host is shutting down (the watchdog must not interfere). */
  isShuttingDown: () => boolean;
  /**
   * Close the current worker connection and open a new one. Resolves true when it did,
   * false when it skipped (a connect() is still pending, or the host is shutting down).
   */
  reconnect: (reason: string) => Promise<boolean>;
  now?: () => number;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export const DEFAULT_WATCHDOG_OPTIONS: Required<InngestConnectWatchdogOptions> = {
  enabled: true,
  checkIntervalMs: 15_000,
  heartbeatStaleMs: 60_000,
  reconnectAfterMs: 120_000,
  minReconnectIntervalMs: 300_000,
  errorAfterMs: 300_000,
  errorRepeatMs: 60_000,
};

/**
 * Stable prefix of the error the watchdog logs while a worker has no working connection.
 * Log-based alerts match on it, so changing it breaks them.
 */
export const NO_CONNECTION_ERROR_PREFIX = 'Inngest worker has no working connection';

/** Forced reconnects within FLAP_WINDOW_MS that mean "the connection keeps failing". */
const FLAP_RECONNECTS = 3;
const FLAP_WINDOW_MS = 30 * 60_000;
/**
 * Consecutive failed reconnects after which the watchdog stops trying. A connect() that
 * throws leaves its worker thread (and with default options its signal listeners) behind,
 * and the SDK gives the caller no handle to close them, so retrying forever would leak a
 * thread per attempt. Past this point only a pod restart cleans up.
 */
const MAX_CONSECUTIVE_FAILED_RECONNECTS = 3;
/**
 * Retry delay after a skipped reconnect. A skip did nothing, so it starts no cooldown: the
 * pending first connect() it waited for may throw right after. But not every check, so a
 * connect() that stays pending for an hour does not log every 15 s.
 */
const SKIPPED_RETRY_MS = 60_000;

const ACTIVE = 'ACTIVE';
/** States the SDK enters only when something called close(): shutdown, never a failure. */
const CLOSED_ON_PURPOSE = new Set(['CLOSING', 'CLOSED']);

/**
 * Watches an Inngest connect-mode worker and repairs it from inside the process.
 *
 * It only ever reconnects. Draining or restarting the pod is deliberately not an option:
 * from inside one pod, a worker broken for good looks exactly like Inngest being down for
 * everyone, and acting on every pod at once during an Inngest outage takes the HTTP API
 * down with it (2026-10-30). A reconnect fixes the first case and costs nothing in the
 * second, so it needs no knowledge of the other pods.
 *
 * An episode of trouble ends only after the connection has stayed healthy for
 * `reconnectAfterMs`. Ending it on the first healthy check would let a worker that breaks
 * again shortly after every reconnect stay silent forever: each episode would end before
 * it reached `errorAfterMs`, and the error the alert matches would never be logged.
 *
 * A healthy transport that Inngest has stopped dispatching to (2026-10-09/10) is out of
 * scope: no client action fixes it, and the cross-service alert covers it.
 */
export class ConnectWatchdog {
  private readonly options: Required<InngestConnectWatchdogOptions>;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private reconnecting: Promise<void> | null = null;

  private unhealthySince: number | null = null;
  /** The latest problem seen; it can change during an episode (RECONNECTING, then CONNECTING). */
  private unhealthyReason: string | null = null;
  /** The problem that opened the current episode, for the recovery line. */
  private episodeCause: string | null = null;
  /** Start of the current healthy streak inside an open episode. */
  private healthySince: number | null = null;
  /** When the watchdog first saw the current connection ACTIVE. */
  private activeSince: number | null = null;
  private lastErrorLoggedAt: number | null = null;
  private warnedHeartbeatUnavailable = false;

  private reconnectAttempts = 0;
  private recentReconnects: number[] = [];
  private consecutiveFailedReconnects = 0;
  /** Earliest time the next forced reconnect may start. */
  private nextReconnectAt: number | null = null;
  private lastReconnectAt: number | null = null;
  private lastReconnectError: string | null = null;

  constructor(
    options: InngestConnectWatchdogOptions | undefined,
    private readonly deps: ConnectWatchdogDeps,
  ) {
    this.options = { ...DEFAULT_WATCHDOG_OPTIONS, ...stripUndefined(options ?? {}) };
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? new Logger(ConnectWatchdog.name);
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.checkIntervalMs);
    // Never keep the process alive just for the watchdog.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The host replaced its worker connection; heartbeat ages restart from it. */
  onConnectionReplaced(): void {
    this.activeSince = null;
  }

  /** Resolves when any reconnect started by the watchdog has settled (tests, shutdown). */
  async settled(): Promise<void> {
    await this.ticking;
    await this.reconnecting;
  }

  /** One evaluation. Public for tests; concurrent calls share the in-flight tick. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.evaluate().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  status(): ConnectWatchdogStatus {
    const unhealthyForMs = this.unhealthySince === null ? 0 : this.now() - this.unhealthySince;
    return {
      enabled: this.options.enabled,
      transportHealthy: this.unhealthySince === null,
      unhealthyReason: this.unhealthyReason,
      unhealthySince: this.unhealthySince,
      unhealthyForMs,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveFailedReconnects: this.consecutiveFailedReconnects,
      reconnectsStopped: this.consecutiveFailedReconnects >= MAX_CONSECUTIVE_FAILED_RECONNECTS,
      lastReconnectAt: this.lastReconnectAt,
      lastReconnectError: this.lastReconnectError,
    };
  }

  private async evaluate(): Promise<void> {
    if (!this.options.enabled || this.deps.isShuttingDown()) return;
    // Nothing below should throw, but this runs from a timer: an escape would be an
    // unhandled rejection, and a silently dead check is the one failure this must not have.
    try {
      const now = this.now();
      const problem = this.detectTransportProblem(now);
      if (problem === null) {
        this.onHealthy(now);
      } else {
        this.onUnhealthy(now, problem);
      }
    } catch (error) {
      this.logger.error(
        `Inngest watchdog check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private onHealthy(now: number): void {
    if (this.unhealthySince === null) return;
    if (this.healthySince === null) this.healthySince = now;
    if (now - this.healthySince < this.options.reconnectAfterMs) return;

    // Name the cause as a cause: printed bare after "recovered", a stale "SDK state is
    // RECONNECTING" reads as the state right now, which is ACTIVE.
    this.logger.log(
      `Inngest worker connection recovered after ${formatDuration(this.healthySince - this.unhealthySince)}; the outage started with: ${this.episodeCause}`,
    );
    this.unhealthySince = null;
    this.unhealthyReason = null;
    this.episodeCause = null;
    this.healthySince = null;
    this.lastErrorLoggedAt = null;
    this.consecutiveFailedReconnects = 0;
  }

  private onUnhealthy(now: number, problem: string): void {
    this.healthySince = null;
    if (this.unhealthySince === null) {
      this.unhealthySince = now;
      this.episodeCause = problem;
      this.logger.warn(`Inngest worker connection unhealthy: ${problem}`);
    }
    this.unhealthyReason = problem;
    this.maybeLogError(now);
    this.maybeReconnect(now);
  }

  private detectTransportProblem(now: number): string | null {
    const state = this.deps.getState();
    if (state === null) {
      this.activeSince = null;
      return 'no worker connection';
    }
    if (CLOSED_ON_PURPOSE.has(state)) {
      // The SDK closes only on request (its own SIGINT/SIGTERM handler, or a close() call).
      // Reconnecting here would reopen a worker in a pod that is shutting down.
      this.activeSince = null;
      return null;
    }
    if (state !== ACTIVE) {
      this.activeSince = null;
      return `SDK state is ${state}`;
    }

    if (this.activeSince === null) this.activeSince = now;

    let debug: WatchdogDebugState | null;
    try {
      debug = this.deps.getDebugState();
    } catch (error) {
      this.warnHeartbeatUnavailable(
        `getDebugState() threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (debug === null) {
      this.warnHeartbeatUnavailable('the SDK has no getDebugState() (inngest < 4.2)');
      return null;
    }

    // Measure from the later of the last heartbeat and this ACTIVE run. A connection that
    // never got a heartbeat is stale once it has been ACTIVE that long; and the SDK keeps
    // the pre-outage heartbeat time across its own reconnect, which must not read as stale.
    const lastHeartbeat = debug.lastHeartbeatReceivedAt;
    const heard = typeof lastHeartbeat === 'number' && lastHeartbeat >= this.activeSince;
    const reference = heard ? (lastHeartbeat as number) : this.activeSince;
    const age = now - reference;
    if (age <= this.options.heartbeatStaleMs) return null;
    return heard
      ? `SDK reports ACTIVE but no gateway heartbeat for ${formatDuration(age)}`
      : `SDK reports ACTIVE for ${formatDuration(age)} without a gateway heartbeat`;
  }

  private warnHeartbeatUnavailable(why: string): void {
    if (this.warnedHeartbeatUnavailable) return;
    this.warnedHeartbeatUnavailable = true;
    this.logger.warn(
      `Inngest watchdog cannot check gateway heartbeats (${why}); a worker that reports ACTIVE but stopped answering will not be detected`,
    );
  }

  private maybeLogError(now: number): void {
    if (this.unhealthySince === null) return;
    this.pruneRecentReconnects(now);
    const longEpisode = now - this.unhealthySince >= this.options.errorAfterMs;
    const flapping = this.recentReconnects.length >= FLAP_RECONNECTS;
    if (!longEpisode && !flapping) return;
    if (
      this.lastErrorLoggedAt !== null &&
      now - this.lastErrorLoggedAt < this.options.errorRepeatMs
    ) {
      return;
    }
    this.lastErrorLoggedAt = now;

    const parts = [
      `${NO_CONNECTION_ERROR_PREFIX} for ${formatDuration(now - this.unhealthySince)}: ${this.unhealthyReason}.`,
      `Forced reconnects in the last ${formatDuration(FLAP_WINDOW_MS)}: ${this.recentReconnects.length}.`,
    ];
    if (this.consecutiveFailedReconnects >= MAX_CONSECUTIVE_FAILED_RECONNECTS) {
      parts.push(
        `The watchdog stopped reconnecting after ${this.consecutiveFailedReconnects} failed attempts in a row; restart this pod.`,
      );
    }
    parts.push('If most pods report this, Inngest is down and a restart will not help.');
    this.logger.error(parts.join(' '));
  }

  private maybeReconnect(now: number): void {
    if (this.unhealthySince === null || this.reconnecting) return;
    if (this.consecutiveFailedReconnects >= MAX_CONSECUTIVE_FAILED_RECONNECTS) return;
    if (now - this.unhealthySince < this.options.reconnectAfterMs) return;
    if (this.nextReconnectAt !== null && now < this.nextReconnectAt) return;

    const previousNextReconnectAt = this.nextReconnectAt;
    this.nextReconnectAt = now + this.options.minReconnectIntervalMs;
    this.reconnectAttempts += 1;
    this.recentReconnects.push(now);
    const attempt = this.reconnectAttempts;
    const reason = this.unhealthyReason ?? 'unknown';
    // The host logs the start of a real reconnect (with this reason); a skip logs nothing
    // here, so a long-pending first connect() does not fill the log.
    // Not awaited: a reconnect can take as long as the gateway is unreachable, and the
    // watchdog must keep evaluating (status, error log) meanwhile.
    this.reconnecting = Promise.resolve()
      .then(() => this.deps.reconnect(reason))
      .then(
        (acted) => {
          if (acted === false) {
            // Skipped: nothing was torn down or opened, so it is not an attempt and starts
            // no cooldown.
            this.reconnectAttempts -= 1;
            this.recentReconnects = this.recentReconnects.filter((t) => t !== now);
            this.nextReconnectAt = Math.max(previousNextReconnectAt ?? 0, now + SKIPPED_RETRY_MS);
            return;
          }
          this.lastReconnectAt = now;
          this.lastReconnectError = null;
          this.consecutiveFailedReconnects = 0;
          this.logger.log(
            `Inngest watchdog reconnected the worker (attempt ${attempt}); triggered by: ${reason}`,
          );
        },
        (error) => {
          this.lastReconnectAt = now;
          this.lastReconnectError = error instanceof Error ? error.message : String(error);
          this.consecutiveFailedReconnects += 1;
          this.logger.error(`Inngest watchdog reconnect failed: ${this.lastReconnectError}`);
          if (this.consecutiveFailedReconnects >= MAX_CONSECUTIVE_FAILED_RECONNECTS) {
            this.logger.error(
              `Inngest watchdog stopped reconnecting after ${this.consecutiveFailedReconnects} failed attempts in a row: ` +
                'each failed connect() can leave an SDK worker thread behind, and only a pod restart cleans them up.',
            );
          }
        },
      )
      .finally(() => {
        this.reconnecting = null;
      });
  }

  private pruneRecentReconnects(now: number): void {
    this.recentReconnects = this.recentReconnects.filter((t) => now - t < FLAP_WINDOW_MS);
  }
}

function formatDuration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
