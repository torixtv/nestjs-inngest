import { Injectable, Logger, Inject } from '@nestjs/common';
import { InngestService } from '../services/inngest.service';
import { INNGEST_MODULE_OPTIONS } from '../constants';
import { InngestModuleOptions } from '../interfaces';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message: string;
  details?: Record<string, any>;
  timestamp: string;
  responseTime?: number;
}

// Simple health status for easy integration
export interface InngestHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message: string;
  functions: {
    total: number;
    registered: number;
  };
  connectivity: boolean;
  uptime: number;
  timestamp: string;
}

export interface SystemHealth {
  overall: 'healthy' | 'unhealthy' | 'degraded';
  checks: {
    inngest: HealthCheckResult;
    functions: HealthCheckResult;
    memory: HealthCheckResult;
    database?: HealthCheckResult;
    external?: HealthCheckResult[];
  };
  metadata: {
    version: string;
    environment: string;
    uptime: number;
    timestamp: string;
  };
}

@Injectable()
export class InngestHealthService {
  private readonly logger = new Logger(InngestHealthService.name);
  private readonly startTime = Date.now();
  private lastHealthCheck: SystemHealth | null = null;
  private healthCheckInProgress = false;

  constructor(
    private readonly inngestService: InngestService,
    @Inject(INNGEST_MODULE_OPTIONS)
    private readonly options: InngestModuleOptions,
  ) {}

  /**
   * Perform a comprehensive health check
   */
  async checkHealth(_includeDetails = true): Promise<SystemHealth> {
    if (this.healthCheckInProgress) {
      // Return cached result if health check is in progress
      return this.lastHealthCheck || this.createUnhealthyResponse('Health check in progress');
    }

    this.healthCheckInProgress = true;
    const startTime = Date.now();

    try {
      const checks = await Promise.allSettled([
        this.checkInngestConnectivity(),
        this.checkFunctionRegistration(),
        this.checkMemoryUsage(),
      ]);

      const inngestCheck = this.getCheckResult(checks[0], 'Inngest connectivity check failed');
      const functionsCheck = this.getCheckResult(checks[1], 'Functions check failed');
      const memoryCheck = this.getCheckResult(checks[2], 'Memory check failed');

      // Determine overall health status
      const allChecks = [inngestCheck, functionsCheck, memoryCheck];
      const unhealthyChecks = allChecks.filter((check) => check.status === 'unhealthy');
      const degradedChecks = allChecks.filter((check) => check.status === 'degraded');

      let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
      if (unhealthyChecks.length > 0) {
        overallStatus = 'unhealthy';
      } else if (degradedChecks.length > 0) {
        overallStatus = 'degraded';
      }

      const health: SystemHealth = {
        overall: overallStatus,
        checks: {
          inngest: inngestCheck,
          functions: functionsCheck,
          memory: memoryCheck,
        },
        metadata: {
          version: this.getVersion(),
          environment: this.options.environment || 'development',
          uptime: Date.now() - this.startTime,
          timestamp: new Date().toISOString(),
        },
      };

      this.lastHealthCheck = health;

      const responseTime = Date.now() - startTime;
      this.logger.debug(
        `Health check completed in ${responseTime}ms with status: ${overallStatus}`,
      );

      return health;
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`, error.stack);
      return this.createUnhealthyResponse(`Health check failed: ${error.message}`);
    } finally {
      this.healthCheckInProgress = false;
    }
  }

  /**
   * Get connection health for connect mode
   * Useful for monitoring WebSocket connection state
   */
  async getConnectionHealth(): Promise<HealthCheckResult> {
    const options = this.inngestService.getOptions();

    if (options.mode !== 'connect') {
      return {
        status: 'healthy',
        message: 'Serve mode - HTTP endpoint ready',
        details: { mode: 'serve' },
        timestamp: new Date().toISOString(),
      };
    }

    const state = this.inngestService.getConnectionState();

    switch (state) {
      case 'ACTIVE':
        return {
          status: 'healthy',
          message: 'WebSocket connection active',
          details: { mode: 'connect', state },
          timestamp: new Date().toISOString(),
        };
      case 'CONNECTING':
      case 'RECONNECTING':
      case 'PAUSED':
        return {
          status: 'degraded',
          message: `Connection state: ${state}`,
          details: { mode: 'connect', state },
          timestamp: new Date().toISOString(),
        };
      default:
        return {
          status: 'unhealthy',
          message: 'Connection not active',
          details: { mode: 'connect', state },
          timestamp: new Date().toISOString(),
        };
    }
  }

  /**
   * Quick liveness check
   */
  async liveness(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Basic check to ensure the service is responsive
      const uptime = Date.now() - this.startTime;
      const responseTime = Date.now() - startTime;

      return {
        status: 'healthy',
        message: 'Service is alive',
        details: {
          uptime,
          responseTime,
        },
        timestamp: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Liveness check failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Readiness check for deployments
   * For connect mode, also verifies WebSocket connection is active
   */
  async readiness(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Check if the service is ready to handle requests
      const functions = this.inngestService.getFunctions();
      const client = this.inngestService.getClient();
      const options = this.inngestService.getOptions();

      if (!client) {
        return {
          status: 'unhealthy',
          message: 'Inngest client not initialized',
          timestamp: new Date().toISOString(),
        };
      }

      // For connect mode, verify the WebSocket connection is active
      if (options.mode === 'connect') {
        const connectionState = this.inngestService.getConnectionState();
        if (connectionState !== 'ACTIVE') {
          return {
            status: 'unhealthy',
            message: `Worker not ready: connection state is ${connectionState}`,
            details: {
              mode: 'connect',
              connectionState,
              functionsRegistered: functions.length,
            },
            timestamp: new Date().toISOString(),
          };
        }
      }

      const responseTime = Date.now() - startTime;

      return {
        status: 'healthy',
        message: 'Service is ready',
        details: {
          mode: options.mode || 'serve',
          functionsRegistered: functions.length,
          clientInitialized: !!client,
          ...(options.mode === 'connect' && {
            connectionState: this.inngestService.getConnectionState(),
          }),
          responseTime,
        },
        timestamp: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Readiness check failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get basic metrics for monitoring
   */
  getMetrics(): Record<string, any> {
    const functions = this.inngestService.getFunctions();
    const memoryUsage = process.memoryUsage();

    return {
      functions: {
        registered: functions.length,
        list: functions.map((fn) => {
          const functionId = typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown';
          return {
            id: functionId,
            name: fn.name || functionId,
          };
        }),
      },
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memoryUsage.external / 1024 / 1024), // MB
      },
      system: {
        uptime: Date.now() - this.startTime,
        environment: this.options.environment || 'development',
        nodeVersion: process.version,
        pid: process.pid,
      },
    };
  }

  /**
   * Get simple health status for easy integration into consuming app's health endpoint
   * Usage: const inngestHealth = await this.inngestHealthService.getHealthStatus();
   */
  async getHealthStatus(): Promise<InngestHealthStatus> {
    try {
      const functions = this.inngestService.getFunctions();
      const client = this.inngestService.getClient();
      const options = this.inngestService.getOptions();
      const connectivity = !!client;

      let status: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
      let message = 'Inngest integration is healthy';

      if (!connectivity) {
        status = 'unhealthy';
        message = 'Inngest client not available';
      } else if (functions.length === 0) {
        status = 'degraded';
        message = 'No functions registered';
      } else if (options.mode === 'connect') {
        // For connect mode, also check connection state
        const connectionState = this.inngestService.getConnectionState();
        if (connectionState !== 'ACTIVE') {
          if (
            connectionState === 'CONNECTING' ||
            connectionState === 'RECONNECTING' ||
            connectionState === 'PAUSED'
          ) {
            status = 'degraded';
            message = `Connection state: ${connectionState}`;
          } else {
            status = 'unhealthy';
            message = `Connection not active: ${connectionState}`;
          }
        }
      }

      return {
        status,
        message,
        functions: {
          total: functions.length,
          registered: functions.length,
        },
        connectivity,
        uptime: Date.now() - this.startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Health check failed: ${error.message}`,
        functions: {
          total: 0,
          registered: 0,
        },
        connectivity: false,
        uptime: Date.now() - this.startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Simple boolean health check for quick status verification
   * Usage: const isHealthy = await this.inngestHealthService.isHealthy();
   */
  async isHealthy(): Promise<boolean> {
    try {
      const status = await this.getHealthStatus();
      return status.status === 'healthy';
    } catch {
      return false;
    }
  }

  private async checkInngestConnectivity(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const client = this.inngestService.getClient();
      if (!client) {
        return {
          status: 'unhealthy',
          message: 'Inngest client not available',
          timestamp: new Date().toISOString(),
        };
      }

      // Actually test connectivity by sending a health check event
      // This will validate that we can communicate with the Inngest server
      let connectivityStatus = 'unknown';
      let connectivityError = null;

      try {
        await client.send({
          name: 'health.check',
          data: {
            timestamp: new Date().toISOString(),
            source: 'inngest-health-service',
            check: 'connectivity',
          },
        });
        connectivityStatus = 'connected';
      } catch (error) {
        connectivityStatus = 'disconnected';
        connectivityError = error.message;

        // If we can't connect to Inngest server, mark as unhealthy
        return {
          status: 'unhealthy',
          message: 'Cannot connect to Inngest server',
          details: {
            clientId: client.id,
            baseUrl: this.options.baseUrl,
            error: connectivityError,
            connectivityStatus,
          },
          timestamp: new Date().toISOString(),
        };
      }

      const responseTime = Date.now() - startTime;

      return {
        status: 'healthy',
        message: 'Inngest connectivity is healthy',
        details: {
          clientId: client.id,
          baseUrl: this.options.baseUrl,
          hasEventKey: !!this.options.eventKey,
          hasSigningKey: !!this.options.signingKey,
          connectivityStatus,
          responseTime,
        },
        timestamp: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Inngest connectivity check failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async checkFunctionRegistration(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const functions = this.inngestService.getFunctions();
      const responseTime = Date.now() - startTime;

      if (functions.length === 0) {
        return {
          status: 'degraded',
          message: 'No functions registered',
          details: {
            registeredFunctions: 0,
            responseTime,
          },
          timestamp: new Date().toISOString(),
          responseTime,
        };
      }

      return {
        status: 'healthy',
        message: 'Functions are properly registered',
        details: {
          registeredFunctions: functions.length,
          functions: functions.map((fn) => {
            const functionId = typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown';
            return {
              id: functionId,
              name: fn.name || functionId,
            };
          }),
          responseTime,
        },
        timestamp: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Function registration check failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async checkMemoryUsage(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const memoryUsage = process.memoryUsage();
      const memoryLimitMB = this.options.performance?.memoryLimit || 512; // Default 512MB
      const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
      const heapTotalMB = memoryUsage.heapTotal / 1024 / 1024;
      const rssMB = memoryUsage.rss / 1024 / 1024;

      const responseTime = Date.now() - startTime;

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      let message = 'Memory usage is healthy';

      // Check if we're using too much memory
      if (rssMB > memoryLimitMB * 0.9) {
        status = 'unhealthy';
        message = 'Memory usage is critically high';
      } else if (rssMB > memoryLimitMB * 0.75) {
        status = 'degraded';
        message = 'Memory usage is elevated';
      }

      return {
        status,
        message,
        details: {
          rss: Math.round(rssMB),
          heapUsed: Math.round(heapUsedMB),
          heapTotal: Math.round(heapTotalMB),
          external: Math.round(memoryUsage.external / 1024 / 1024),
          limit: memoryLimitMB,
          utilization: Math.round((rssMB / memoryLimitMB) * 100),
          responseTime,
        },
        timestamp: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Memory check failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private getCheckResult(
    result: PromiseSettledResult<HealthCheckResult>,
    fallbackMessage: string,
  ): HealthCheckResult {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        status: 'unhealthy',
        message: fallbackMessage,
        details: { error: result.reason?.message || 'Unknown error' },
        timestamp: new Date().toISOString(),
      };
    }
  }

  private createUnhealthyResponse(_message: string): SystemHealth {
    return {
      overall: 'unhealthy',
      checks: {
        inngest: {
          status: 'unhealthy',
          message: 'Not checked',
          timestamp: new Date().toISOString(),
        },
        functions: {
          status: 'unhealthy',
          message: 'Not checked',
          timestamp: new Date().toISOString(),
        },
        memory: {
          status: 'unhealthy',
          message: 'Not checked',
          timestamp: new Date().toISOString(),
        },
      },
      metadata: {
        version: this.getVersion(),
        environment: this.options.environment || 'development',
        uptime: Date.now() - this.startTime,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private getVersion(): string {
    try {
      // In a real application, this would read from package.json
      return process.env.npm_package_version || '0.1.0';
    } catch {
      return '0.1.0';
    }
  }
}
