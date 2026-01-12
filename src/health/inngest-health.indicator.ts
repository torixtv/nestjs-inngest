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

      // For connect mode, verify the WebSocket connection is active
      if (mode === 'connect') {
        const connectionState = this.inngestService.getConnectionState();

        if (connectionState === 'ACTIVE') {
          return check.up({
            message: 'Inngest worker is connected',
            mode: 'connect',
            connectionState,
          });
        } else if (
          connectionState === 'CONNECTING' ||
          connectionState === 'RECONNECTING'
        ) {
          // Not ready yet, but not necessarily unhealthy
          this.logger.warn(`Inngest connection state: ${connectionState}`);
          return check.down({
            message: `Inngest connection state: ${connectionState}`,
            mode: 'connect',
            connectionState,
          });
        } else {
          this.logger.warn(`Inngest connection not active: ${connectionState}`);
          return check.down({
            message: `Inngest connection not active: ${connectionState}`,
            mode: 'connect',
            connectionState,
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
