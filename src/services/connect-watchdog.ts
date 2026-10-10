import { Logger } from '@nestjs/common';
import {
  ConnectWatchdogStatus,
  InngestConnectWatchdogOptions,
} from '../interfaces/inngest-module.interface';

/** Subset of the SDK's `ConnectDebugState` the watchdog reads. */
export interface WatchdogDebugState {
  lastHeartbeatReceivedAt?: number;
  lastMessageReceivedAt?: number;
}

export interface ConnectWatchdogDeps {
  /** SDK connection state, or null when no worker connection exists. */
  getState: () => string | null;
  /** SDK `getDebugState()` snapshot, when the SDK exposes it. */
  getDebugState: () => WatchdogDebugState | null;
  /** Whether the host is shutting down (watchdog must not interfere). */
  isShuttingDown: () => boolean;
  /** Close the current worker connection and open a new one. */
  reconnect: (reason: string) => Promise<void>;
  now?: () => number;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export const DEFAULT_WATCHDOG_OPTIONS: Required<
  Omit<InngestConnectWatchdogOptions, 'idleWarnAfterMs'>
> & { idleWarnAfterMs?: number } = {
  enabled: true,
  checkIntervalMs: 15_000,
  heartbeatStaleMs: 60_000,
  reconnectAfterMs: 120_000,
  minReconnectIntervalMs: 300_000,
  livenessFailAfterMs: 600_000,
  idleWarnAfterMs: undefined,
};

const ACTIVE = 'ACTIVE';

/**
 * Watches an Inngest connect-mode worker and repairs it from the client side.
 *
 * Two different failures look identical from the outside ("functions stop running"),
 * and only one of them is fixable by this process:
 *
 * 1. TRANSPORT FAILURE (client-fixable). The SDK is not ACTIVE, or it claims ACTIVE but
 *    the gateway's heartbeat replies stopped arriving (e.g. a wedged worker thread whose
 *    cached state froze at ACTIVE, or the SDK gave up after repeated worker crashes).
 *    The watchdog forces a reconnect after `reconnectAfterMs`, and reports not-live after
 *    `livenessFailAfterMs` so a liveness probe can restart the pod as a last resort.
 *
 * 2. DISPATCH STALL (not client-fixable). Transport is healthy - heartbeats flow - but
 *    Inngest is not dispatching runs to the worker. This is what happened on 2026-10-09
 *    and 2026-10-10: runs sat Queued in Inngest Cloud for 30-45 min, in production and
 *    staging at once, and resumed on the SAME connections without any client action.
 *    Restarting pods cannot fix this, so it never fails liveness (that would only turn a
 *    vendor outage into a restart storm). It is surfaced instead: `idle` in the status,
 *    plus one warn log per episode, when `idleWarnAfterMs` is configured. Paging on it is
 *    the job of a cross-service alert, not of this process.
 */
export class ConnectWatchdog {
  private readonly options: typeof DEFAULT_WATCHDOG_OPTIONS;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private reconnecting: Promise<void> | null = null;

  private readonly startedAt: number;
  private unhealthySince: number | null = null;
  private unhealthyReason: string | null = null;
  private lastExecutionAt: number | null = null;
  private idleEpisodeLogged = false;
  private reconnectAttempts = 0;
  private lastReconnectAt: number | null = null;
  private lastReconnectError: string | null = null;

  constructor(
    options: InngestConnectWatchdogOptions | undefined,
    private readonly deps: ConnectWatchdogDeps,
  ) {
    this.options = { ...DEFAULT_WATCHDOG_OPTIONS, ...stripUndefined(options ?? {}) };
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? new Logger(ConnectWatchdog.name);
    this.startedAt = this.now();
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

  /** Called by the function wrapper on every execution handled by this process. */
  recordExecution(at: number = this.now()): void {
    this.lastExecutionAt = at;
    if (this.idleEpisodeLogged) {
      this.idleEpisodeLogged = false;
      this.logger.log('Inngest function executions resumed after an idle period');
    }
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
    const now = this.now();
    const unhealthyForMs = this.unhealthySince === null ? 0 : now - this.unhealthySince;
    const idleReference = this.lastExecutionAt ?? this.startedAt;
    const idleForMs = now - idleReference;
    const idle =
      this.options.idleWarnAfterMs !== undefined && idleForMs >= this.options.idleWarnAfterMs;

    return {
      enabled: this.options.enabled,
      transportHealthy: this.unhealthySince === null,
      unhealthyReason: this.unhealthyReason,
      unhealthySince: this.unhealthySince,
      unhealthyForMs,
      live: !this.options.enabled || unhealthyForMs < this.options.livenessFailAfterMs,
      lastExecutionAt: this.lastExecutionAt,
      msSinceLastExecution: this.lastExecutionAt === null ? null : now - this.lastExecutionAt,
      idle,
      reconnectAttempts: this.reconnectAttempts,
      lastReconnectAt: this.lastReconnectAt,
      lastReconnectError: this.lastReconnectError,
    };
  }

  private async evaluate(): Promise<void> {
    if (!this.options.enabled || this.deps.isShuttingDown()) return;

    const now = this.now();
    const problem = this.detectTransportProblem(now);

    if (problem === null) {
      if (this.unhealthySince !== null) {
        this.logger.log(
          `Inngest worker connection recovered after ${Math.round((now - this.unhealthySince) / 1000)}s (${this.unhealthyReason})`,
        );
      }
      this.unhealthySince = null;
      this.unhealthyReason = null;
    } else {
      if (this.unhealthySince === null) {
        this.unhealthySince = now;
        this.logger.warn(`Inngest worker connection unhealthy: ${problem}`);
      }
      this.unhealthyReason = problem;
      await this.maybeReconnect(now);
    }

    this.checkIdle(now);
  }

  private detectTransportProblem(now: number): string | null {
    const state = this.deps.getState();
    if (state === null) return 'no worker connection';
    if (state !== ACTIVE) return `SDK state is ${state}`;

    let debug: WatchdogDebugState | null = null;
    try {
      debug = this.deps.getDebugState();
    } catch {
      debug = null;
    }
    // Only judge heartbeats once the SDK has reported one. Older SDKs and the first seconds
    // of a worker-thread connection report `undefined`, which must not look like a failure.
    const lastHeartbeat = debug?.lastHeartbeatReceivedAt;
    if (typeof lastHeartbeat === 'number') {
      const age = now - lastHeartbeat;
      if (age > this.options.heartbeatStaleMs) {
        return `SDK reports ACTIVE but no gateway heartbeat for ${Math.round(age / 1000)}s`;
      }
    }
    return null;
  }

  private async maybeReconnect(now: number): Promise<void> {
    if (this.unhealthySince === null || this.reconnecting) return;
    if (now - this.unhealthySince < this.options.reconnectAfterMs) return;
    if (
      this.lastReconnectAt !== null &&
      now - this.lastReconnectAt < this.options.minReconnectIntervalMs
    ) {
      return;
    }

    this.lastReconnectAt = now;
    this.reconnectAttempts += 1;
    const reason = this.unhealthyReason ?? 'unknown';
    this.logger.warn(
      `Inngest watchdog forcing reconnect (attempt ${this.reconnectAttempts}): ${reason}`,
    );
    // Not awaited: a reconnect can take as long as the gateway is unreachable, and the
    // watchdog must keep evaluating (status, liveness, idle) meanwhile.
    this.reconnecting = Promise.resolve()
      .then(() => this.deps.reconnect(reason))
      .then(
        () => {
          this.lastReconnectError = null;
        },
        (error) => {
          this.lastReconnectError = error instanceof Error ? error.message : String(error);
          this.logger.error(`Inngest watchdog reconnect failed: ${this.lastReconnectError}`);
        },
      )
      .finally(() => {
        this.reconnecting = null;
      });
  }

  private checkIdle(now: number): void {
    const threshold = this.options.idleWarnAfterMs;
    if (threshold === undefined || this.idleEpisodeLogged) return;
    // Idle is only meaningful while transport is healthy - otherwise the transport
    // warning above already explains why nothing runs.
    if (this.unhealthySince !== null) return;
    const reference = this.lastExecutionAt ?? this.startedAt;
    const idleForMs = now - reference;
    if (idleForMs < threshold) return;
    this.idleEpisodeLogged = true;
    this.logger.warn(
      `Inngest worker idle: no function executions for ${formatDuration(idleForMs)} while the connection is ACTIVE. ` +
        'If other services are idle too, Inngest is not dispatching runs (check Inngest Cloud for Queued runs); a restart will not help.',
    );
  }
}

function formatDuration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
