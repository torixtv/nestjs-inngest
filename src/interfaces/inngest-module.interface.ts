import { InngestMiddleware, ClientOptions } from 'inngest';
import { ModuleMetadata, Type } from '@nestjs/common';

/**
 * Connection mode for Inngest
 * - 'serve': HTTP webhook-based (default, current behavior)
 * - 'connect': WebSocket worker-based persistent connection
 */
export type InngestConnectionMode = 'serve' | 'connect';

/**
 * Connect mode specific options
 */
export interface InngestConnectOptions {
  /**
   * Unique identifier for this worker instance.
   * In containerized environments, use pod/container ID.
   * Defaults to process.env.HOSTNAME or auto-detected platform ID.
   *
   * Common platform environment variables auto-detected:
   * - HOSTNAME (general containers)
   * - FLY_MACHINE_ID (Fly.io)
   * - RENDER_INSTANCE_ID (Render)
   * - K_REVISION (Knative/Cloud Run)
   */
  instanceId?: string;

  /**
   * Maximum number of concurrent requests the worker will handle.
   * If undefined, there is no limit on concurrent requests.
   * Useful for rate limiting and resource management.
   *
   * @since inngest v3.45.1
   */
  maxWorkerConcurrency?: number;

  /**
   * @deprecated Use `maxWorkerConcurrency` instead. This option will be removed in a future version.
   *
   * Maximum concurrent function steps this worker can handle.
   * Helps with load distribution and preventing worker overload.
   */
  maxConcurrency?: number;

  /**
   * List of shutdown signals to handle for graceful shutdown.
   * By default, handles SIGINT and SIGTERM.
   * Set to an empty array to disable automatic signal handling.
   * @default ['SIGINT', 'SIGTERM']
   * @example
   * ```typescript
   * // Disable automatic signal handling
   * handleShutdownSignals: []
   *
   * // Only handle SIGTERM
   * handleShutdownSignals: ['SIGTERM']
   * ```
   */
  handleShutdownSignals?: string[];

  /**
   * Custom function to rewrite the gateway endpoint URL.
   * Useful for self-hosted Inngest or custom network configurations.
   */
  rewriteGatewayEndpoint?: (url: string) => string;

  /**
   * Graceful shutdown timeout in milliseconds.
   * After this timeout, the connection will be forcibly closed.
   * @default 30000
   */
  shutdownTimeout?: number;
}

export interface InngestMonitoringConfig {
  enabled: boolean;
  collectMetrics: boolean;
  metricsInterval: number;
  healthCheckInterval: number;
  enableTracing: boolean;
  tracingConfig?: {
    serviceName?: string;
    spanProcessor: 'simple' | 'batch';
    exporterType: 'console' | 'jaeger' | 'zipkin' | 'otlp';
    exporterConfig?: Record<string, any>;
  };
}

export interface InngestHealthConfig {
  enabled: boolean;
  path: string;
  includeDetails: boolean;
  enableMetrics: boolean;
  enableLiveness: boolean;
  enableReadiness: boolean;
  checkInterval: number;
}

export interface InngestTracingConfig {
  /**
   * Enable tracing (automatically detected if OpenTelemetry is available)
   */
  enabled?: boolean;

  /**
   * Service name to use in traces (defaults to module ID if not specified)
   */
  serviceName?: string;

  /**
   * Format for span names (default: 'inngest.step.{type}.{id}')
   */
  spanNameFormat?: string;

  /**
   * Include event data in trace context (default: false for privacy)
   */
  includeEventData?: boolean;

  /**
   * Include step data in trace attributes (default: false for performance)
   */
  includeStepData?: boolean;

  /**
   * Custom attributes to add to all spans
   */
  defaultAttributes?: Record<string, string | number | boolean>;

  /**
   * Trace context injection settings
   */
  contextInjection?: {
    /**
     * Automatically inject trace context into sendEvent calls (default: true)
     */
    enabled?: boolean;

    /**
     * Location in event data to inject trace context (default: 'traceContext')
     */
    fieldName?: string;
  };
}

export interface InngestModuleOptions {
  /**
   * Inngest app ID
   */
  id: string;

  /**
   * Event key for the Inngest app
   */
  eventKey?: string;

  /**
   * Base URL for the Inngest server (defaults to Inngest Cloud)
   */
  baseUrl?: string;

  /**
   * Whether this module should be global
   */
  isGlobal?: boolean;

  /**
   * Middleware to apply to all functions
   */
  middleware?: InngestMiddleware<any>[];

  /**
   * Additional client options
   */
  clientOptions?: Partial<ClientOptions>;

  /**
   * Path where Inngest functions will be served (defaults to inngest)
   */
  path?: string;

  /**
   * The port where this application is running (for auto-registration)
   * Defaults to process.env.PORT or 3000
   */
  servePort?: number;

  /**
   * The host URL where this application is accessible (for auto-registration)
   * Defaults to 'localhost' in development
   */
  serveHost?: string;

  /**
   * Disable automatic registration with Inngest dev server on module initialization
   * When true, you must call inngestService.registerWithDevServer() manually
   * Useful for dynamic port allocation or complex startup sequences
   * @default false
   */
  disableAutoRegistration?: boolean;

  /**
   * Signing key for webhook signature validation
   */
  signingKey?: string;

  /**
   * Logger instance or configuration
   */
  logger?: any;

  /**
   * Environment configuration
   */
  environment?: 'development' | 'staging' | 'production' | 'test';

  /**
   * Monitoring configuration
   */
  monitoring?: InngestMonitoringConfig;

  /**
   * Health check configuration
   */
  health?: InngestHealthConfig;

  /**
   * Performance configuration (only memoryLimit is implemented)
   */
  performance?: {
    /**
     * Memory limit in MB for health checks
     */
    memoryLimit?: number;
  };

  /**
   * Tracing configuration
   */
  tracing?: InngestTracingConfig;

  /**
   * Connection mode: 'serve' (HTTP webhook) or 'connect' (WebSocket worker)
   *
   * - 'serve' (default): Creates an HTTP endpoint to serve Inngest functions.
   *   Use this for traditional web applications, serverless, or when running
   *   with the Inngest dev server.
   *
   * - 'connect': Establishes a persistent WebSocket connection to Inngest.
   *   Use this for dedicated worker processes, containers, or when you need
   *   lower latency between function invocations.
   *
   * @default 'serve'
   *
   * @example
   * ```typescript
   * // Default serve mode (HTTP)
   * InngestModule.forRoot({
   *   id: 'my-app',
   *   baseUrl: 'http://localhost:8288',
   * })
   *
   * // Connect mode (WebSocket)
   * InngestModule.forRoot({
   *   id: 'my-app',
   *   mode: 'connect',
   *   connect: {
   *     instanceId: process.env.POD_NAME,
   *     maxConcurrency: 10,
   *   },
   * })
   * ```
   */
  mode?: InngestConnectionMode;

  /**
   * Connect mode specific options (only used when mode is 'connect')
   */
  connect?: InngestConnectOptions;
}

export interface InngestModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  name?: string;
  useExisting?: Type<InngestOptionsFactory>;
  useClass?: Type<InngestOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<InngestModuleOptions> | InngestModuleOptions;
  inject?: any[];
  isGlobal?: boolean;
}

export interface InngestOptionsFactory {
  createInngestOptions(): Promise<InngestModuleOptions> | InngestModuleOptions;
}

/**
 * WebSocket ready state constants
 * Matches the W3C WebSocket API readyState values
 */
export enum WebSocketReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

/**
 * Detailed connection health information for connect mode.
 * Uses SDK internals for accurate health reporting when available.
 *
 * This interface provides insight into the actual WebSocket connection state,
 * which may differ from the SDK's public `state` property in edge cases
 * where the SDK's heartbeat mechanism fails to detect a dead connection.
 */
export interface ConnectionHealthInfo {
  /**
   * Whether the connection is truly healthy.
   * Based on internal checks (WebSocket state, heartbeats) when available,
   * falls back to SDK state if internals are inaccessible.
   */
  isHealthy: boolean;

  /**
   * Human-readable reason for the health status.
   * Examples:
   * - "Connection is active and healthy"
   * - "WebSocket is CLOSED (expected OPEN)"
   * - "Heartbeat failure (2 consecutive heartbeats missed)"
   */
  reason: string;

  /**
   * SDK's public state property.
   * Note: This may be stale in edge cases - use isHealthy for reliable status.
   * Possible values: 'CONNECTING', 'ACTIVE', 'PAUSED', 'RECONNECTING', 'CLOSING', 'CLOSED'
   */
  sdkState: string;

  /**
   * Actual WebSocket readyState from Node.js WebSocket implementation.
   * This cannot be faked and reflects true TCP connection state.
   * - 0 = CONNECTING
   * - 1 = OPEN (healthy)
   * - 2 = CLOSING
   * - 3 = CLOSED
   * Null if internal check is unavailable.
   */
  wsReadyState: number | null;

  /**
   * WebSocket state as human-readable string.
   * One of: 'CONNECTING', 'OPEN', 'CLOSING', 'CLOSED', or null.
   */
  wsStateName: string | null;

  /**
   * Number of consecutive heartbeats that haven't received a response.
   * - 0-1: Normal operation
   * - ≥2: Should trigger reconnection (indicates unhealthy connection)
   * Null if internal check is unavailable.
   */
  pendingHeartbeats: number | null;

  /**
   * Connection ID from the SDK.
   * Useful for correlating with Inngest dashboard.
   * Null if not connected or unavailable.
   */
  connectionId: string | null;

  /**
   * Whether the internal check was successfully performed.
   * - true: Health is determined using WebSocket state and heartbeat info
   * - false: Fell back to SDK state only (less reliable)
   *
   * If false, the health check is less reliable and may miss stale connections.
   * This can happen if the SDK internal structure changes in a future version.
   */
  usingInternalCheck: boolean;
}
