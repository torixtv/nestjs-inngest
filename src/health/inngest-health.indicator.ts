import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { InngestService } from '../services/inngest.service';

/**
 * Inngest health indicator for @nestjs/terminus integration
 *
 * This indicator uses HealthIndicatorService.check() for better error handling
 * and simpler implementation without throwing exceptions.
 *
 * Works with both serve mode (HTTP webhooks) and connect mode (WebSocket).
 *
 * @example
 * ```typescript
 * // In your health module
 * import { InngestHealthIndicator } from '@torixtv/nestjs-inngest';
 *
 * @Module({
 *   imports: [TerminusModule],
 *   providers: [InngestHealthIndicator],
 * })
 * export class HealthModule {}
 *
 * // In your health controller
 * @Controller('health')
 * export class HealthController {
 *   constructor(
 *     private health: HealthCheckService,
 *     private inngest: InngestHealthIndicator,
 *   ) {}
 *
 *   @Get('readiness')
 *   @HealthCheck()
 *   readiness(): Promise<HealthCheckResult> {
 *     return this.health.check([
 *       () => this.inngest.isHealthy('inngest'),
 *     ]);
 *   }
 * }
 * ```
 */
@Injectable()
export class InngestHealthIndicator {
  private readonly logger = new Logger(InngestHealthIndicator.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  /**
   * Check if Inngest integration is healthy
   *
   * For serve mode: verifies the client is initialized
   * For connect mode: verifies WebSocket connection is ACTIVE
   *
   * @param key - The key to use for the health indicator result (e.g., 'inngest')
   * @returns Health indicator result compatible with @nestjs/terminus
   */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);

    try {
      // Check if InngestService is available
      if (!this.inngestService) {
        this.logger.warn('InngestService not injected - health check will fail');
        return check.down({ message: 'InngestService not available' });
      }

      // Check if Inngest client is properly initialized
      const client = this.inngestService.getClient();
      if (!client) {
        this.logger.warn('Inngest client is not initialized');
        return check.down({ message: 'Inngest client is not initialized' });
      }

      const options = this.inngestService.getOptions();
      const mode = options.mode || 'serve';

      // For connect mode, use getConnectionHealth() for accurate status
      // This inspects SDK internals (WebSocket state, heartbeats) to detect
      // stale connections that the SDK's public state property might miss
      if (mode === 'connect') {
        const health = this.inngestService.getConnectionHealth();

        if (health.isHealthy) {
          return check.up({
            message: health.reason,
            mode: 'connect',
            connectionState: health.sdkState,
            connectionId: health.connectionId,
            wsReadyState: health.wsStateName,
            pendingHeartbeats: health.pendingHeartbeats,
            usingInternalCheck: health.usingInternalCheck,
            ...this.watchdogDetails(),
          });
        } else {
          this.logger.warn(`Inngest connection unhealthy: ${health.reason}`, {
            sdkState: health.sdkState,
            wsReadyState: health.wsReadyState,
            wsStateName: health.wsStateName,
            pendingHeartbeats: health.pendingHeartbeats,
            connectionId: health.connectionId,
            usingInternalCheck: health.usingInternalCheck,
          });
          return check.down({
            message: health.reason,
            mode: 'connect',
            connectionState: health.sdkState,
            connectionId: health.connectionId,
            wsReadyState: health.wsStateName,
            pendingHeartbeats: health.pendingHeartbeats,
            usingInternalCheck: health.usingInternalCheck,
            ...this.watchdogDetails(),
          });
        }
      }

      // For serve mode, client initialization is sufficient
      return check.up({
        message: 'Inngest client is healthy',
        mode: 'serve',
      });
    } catch (error) {
      this.logger.warn(`Inngest health check failed: ${error.message}`);
      return check.down({
        message: error instanceof Error ? error.message : 'Unknown Inngest error',
      });
    }
  }

  /**
   * Liveness check for connect mode, backed by the connection watchdog.
   *
   * Reports down only when a TRANSPORT problem (SDK not ACTIVE, or no gateway heartbeat)
   * has persisted past `connect.watchdog.livenessFailAfterMs` (default 10 min) despite the
   * watchdog's forced reconnects - i.e. when restarting the pod is the remaining remedy.
   * Brief reconnects and Inngest-side dispatch stalls never fail it, so wiring it into a
   * Kubernetes liveness probe cannot turn an Inngest outage into a restart storm.
   *
   * Prefer this over `isHealthy()` for liveness: `isHealthy()` goes down on any momentary
   * non-ACTIVE state and is meant for readiness/diagnostics.
   *
   * Always up in serve mode or when the watchdog is disabled.
   */
  async isLive(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);
    try {
      const status = this.inngestService.getWatchdogStatus?.() ?? null;
      if (!status || status.live) {
        return check.up({
          message: status
            ? status.transportHealthy
              ? 'Inngest worker connection is live'
              : `Inngest worker connection recovering: ${status.unhealthyReason}`
            : 'Inngest watchdog not active',
          ...this.watchdogDetails(),
        });
      }
      this.logger.error(
        `Inngest worker connection failed liveness: ${status.unhealthyReason} for ${Math.round(status.unhealthyForMs / 1000)}s after ${status.reconnectAttempts} reconnect attempt(s)`,
      );
      return check.down({
        message: `Inngest worker connection unhealthy for ${Math.round(status.unhealthyForMs / 1000)}s: ${status.unhealthyReason}`,
        ...this.watchdogDetails(),
      });
    } catch (error) {
      // A bug in the liveness check must never restart pods.
      return check.up({
        message: `Inngest liveness check errored (treated as live): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private watchdogDetails(): Record<string, unknown> {
    const status = this.inngestService.getWatchdogStatus?.() ?? null;
    if (!status) return {};
    return {
      watchdog: {
        transportHealthy: status.transportHealthy,
        unhealthyReason: status.unhealthyReason,
        unhealthyForMs: status.unhealthyForMs,
        live: status.live,
        msSinceLastExecution: status.msSinceLastExecution,
        idle: status.idle,
        reconnectAttempts: status.reconnectAttempts,
        lastReconnectError: status.lastReconnectError,
      },
    };
  }

  /**
   * Check Inngest readiness (more comprehensive than isHealthy)
   *
   * Verifies:
   * - Client is initialized
   * - Functions are registered
   * - Connection is active (for connect mode)
   *
   * @param key - The key to use for the health indicator result
   * @returns Health indicator result
   */
  async isReady(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);

    try {
      if (!this.inngestService) {
        return check.down({ message: 'InngestService not available' });
      }

      const client = this.inngestService.getClient();
      if (!client) {
        return check.down({ message: 'Inngest client is not initialized' });
      }

      const functions = this.inngestService.getFunctions();
      const options = this.inngestService.getOptions();
      const mode = options.mode || 'serve';

      // Check connection state for connect mode
      if (mode === 'connect') {
        const connectionState = this.inngestService.getConnectionState();
        if (connectionState !== 'ACTIVE') {
          return check.down({
            message: `Worker not ready: ${connectionState}`,
            mode: 'connect',
            connectionState,
            functionsRegistered: functions.length,
          });
        }
      }

      return check.up({
        message: 'Inngest is ready',
        mode,
        functionsRegistered: functions.length,
        ...(mode === 'connect' && {
          connectionState: this.inngestService.getConnectionState(),
        }),
      });
    } catch (error) {
      return check.down({
        message: error instanceof Error ? error.message : 'Unknown Inngest error',
      });
    }
  }
}
