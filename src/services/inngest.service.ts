import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { Inngest, InngestFunction, EventPayload, GetEvents } from 'inngest';
import { extendedTracesMiddleware } from 'inngest/experimental';
import { INNGEST_MODULE_OPTIONS } from '../constants';
import { InngestModuleOptions, ConnectionHealthInfo, WebSocketReadyState } from '../interfaces';
import { InngestTracingService, TraceContext } from '../tracing/tracing.service';

// Type for the WorkerConnection returned by connect()
interface WorkerConnection {
  connectionId: string;
  state: 'CONNECTING' | 'ACTIVE' | 'PAUSED' | 'RECONNECTING' | 'CLOSING' | 'CLOSED';
  close: () => Promise<void>;
  closed: Promise<void>;
}

// Dynamic import holder for connect module
let connectModule: typeof import('inngest/connect') | null = null;

// ConnectionState enum will be loaded dynamically with the connect module
let ConnectionStateEnum: typeof import('inngest/connect').ConnectionState | null = null;

@Injectable()
export class InngestService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(InngestService.name);
  private inngestClient: Inngest;
  private functions: InngestFunction<any, any, any>[] = [];
  private workerConnection: WorkerConnection | null = null;
  private isShuttingDown = false;
  /** Guard flag to prevent log spam when SDK internals are inaccessible */
  private hasLoggedInternalCheckWarning = false;

  /** WebSocket ready state names for human-readable output */
  private static readonly WS_STATE_NAMES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

  constructor(
    @Inject(INNGEST_MODULE_OPTIONS)
    private readonly options: InngestModuleOptions,
    @Optional() private readonly tracingService?: InngestTracingService,
  ) {
    // Prepare middleware array
    const middleware = this.options.middleware ? [...this.options.middleware] : [];

    // Add SDK's extendedTracesMiddleware for proper OpenTelemetry integration
    // This middleware:
    // - Uses startActiveSpan() for proper context propagation (Pino log correlation)
    // - Handles trace context propagation correctly
    // - Registers InngestSpanProcessor in clientProcessorMap for Inngest dashboard traces
    // - Calls forceFlush() after function execution
    try {
      const sdkTracingMiddleware = extendedTracesMiddleware({
        behaviour: 'extendProvider',
      });
      middleware.push(sdkTracingMiddleware as any);
      this.logger.debug({
        message: 'Added SDK extendedTracesMiddleware for OpenTelemetry integration',
        behaviour: 'extendProvider',
      });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to add extendedTracesMiddleware - tracing may not work properly',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.inngestClient = new Inngest({
      id: this.options.id,
      eventKey: this.options.eventKey,
      baseUrl: this.options.baseUrl,
      middleware: middleware as any,
      logger: this.options.logger,
      ...this.options.clientOptions,
    });

    this.logger.log({
      message: 'Inngest client created successfully',
      clientId: this.options.id,
      middlewareCount: middleware.length,
      hasTracing: true,
    });

    // Test functions will be registered by InngestExplorer after module init
  }

  // Manual function registration commented out - using automatic discovery instead
  /*
  private registerTestFunctionManually() {
    // This method is disabled in favor of automatic function discovery
    // The InngestExplorer will find and register decorated functions automatically
  }
  */

  async onModuleInit() {
    this.logger.log(`Initializing Inngest module with app ID: ${this.options.id}`, {
      mode: this.options.mode || 'serve',
    });

    if (this.functions.length > 0) {
      this.logger.log(`Registered ${this.functions.length} Inngest functions`);
    }

    // Skip auto-registration if disabled
    if (this.options.disableAutoRegistration) {
      this.logger.log(
        'Auto-registration disabled. Call registerWithDevServer() or establishConnection() manually when ready.',
      );
      return;
    }

    // Branch based on connection mode
    if (this.options.mode === 'connect') {
      // Delay connection to allow InngestExplorer to finish discovering functions
      setTimeout(() => {
        this.establishConnection();
      }, 1000);
    } else {
      // Default serve mode - register with dev server
      setTimeout(() => {
        this.registerWithDevServer();
      }, 1000);
    }
  }

  /**
   * Lifecycle hook: Called when the module is being destroyed
   */
  async onModuleDestroy() {
    await this.gracefulShutdown('module_destroy');
  }

  /**
   * Lifecycle hook: Called when the application is shutting down
   */
  async onApplicationShutdown(signal?: string) {
    await this.gracefulShutdown(`signal_${signal || 'unknown'}`);
  }

  /**
   * Establish WebSocket connection to Inngest (connect mode)
   * Can be called manually if disableAutoRegistration is true
   */
  async establishConnection(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Cannot establish connection: service is shutting down');
      return;
    }

    if (this.options.mode !== 'connect') {
      this.logger.warn('establishConnection() called but mode is not "connect"');
      return;
    }

    try {
      // Dynamic import for compatibility - connect module may not exist in older Inngest versions
      if (!connectModule) {
        try {
          connectModule = await import('inngest/connect');
        } catch (importError) {
          this.logger.error(
            'Failed to import inngest/connect. Make sure you have inngest >= 3.x installed.',
            { error: importError.message },
          );
          throw new Error(
            'inngest/connect module not available. Connect mode requires inngest >= 3.x',
          );
        }
      }

      const { connect, ConnectionState } = connectModule;
      // Store ConnectionState enum for use in health checks
      ConnectionStateEnum = ConnectionState;
      const connectOptions = this.options.connect || {};

      this.logger.log('Establishing Inngest worker connection', {
        instanceId: connectOptions.instanceId,
        maxWorkerConcurrency: connectOptions.maxWorkerConcurrency ?? connectOptions.maxConcurrency,
        handleShutdownSignals: connectOptions.handleShutdownSignals ?? 'default',
        functionCount: this.functions.length,
      });

      // Build connect options, only including defined values
      // Use maxWorkerConcurrency (SDK v3.45.1+), with fallback to deprecated maxConcurrency
      const workerConcurrency =
        connectOptions.maxWorkerConcurrency ?? connectOptions.maxConcurrency;
      const connectConfig = {
        apps: [
          {
            client: this.inngestClient,
            functions: this.functions,
          },
        ],
        ...(connectOptions.instanceId !== undefined && {
          instanceId: connectOptions.instanceId,
        }),
        ...(workerConcurrency !== undefined && {
          maxWorkerConcurrency: workerConcurrency,
        }),
        ...(connectOptions.handleShutdownSignals !== undefined && {
          handleShutdownSignals: connectOptions.handleShutdownSignals,
        }),
        ...(connectOptions.rewriteGatewayEndpoint !== undefined && {
          rewriteGatewayEndpoint: connectOptions.rewriteGatewayEndpoint,
        }),
      };

      this.workerConnection = (await connect(connectConfig as any)) as WorkerConnection;

      this.logger.log('Inngest worker connection established', {
        state: this.workerConnection.state,
        instanceId: connectOptions.instanceId,
        functionCount: this.functions.length,
      });
    } catch (error) {
      this.logger.error('Failed to establish Inngest connection', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Graceful shutdown for connect mode
   * Waits for in-flight function executions to complete
   */
  private async gracefulShutdown(reason: string): Promise<void> {
    // Only relevant for connect mode with an active connection
    if (this.options.mode !== 'connect' || !this.workerConnection || this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    const timeout = this.options.connect?.shutdownTimeout ?? 30000;

    this.logger.log('Initiating graceful shutdown of Inngest worker connection', {
      reason,
      timeout,
      currentState: this.workerConnection.state,
    });

    try {
      // Race between graceful close and timeout
      const closePromise = this.workerConnection.close();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout exceeded')), timeout),
      );

      await Promise.race([closePromise, timeoutPromise]);
      await this.workerConnection.closed;

      this.logger.log('Inngest worker connection closed gracefully');
    } catch (error) {
      this.logger.warn('Shutdown did not complete gracefully', {
        error: error.message,
        reason,
      });
    } finally {
      this.workerConnection = null;
    }
  }

  /**
   * Register functions with Inngest dev server
   * Can be called manually to control when registration happens
   *
   * @param overrides Optional overrides for serveHost and servePort
   * @example
   * ```typescript
   * // In main.ts after app.listen()
   * const port = process.env.PORT || 3000;
   * await app.listen(port);
   * await app.get(InngestService).registerWithDevServer({
   *   servePort: port,
   *   serveHost: 'localhost'
   * });
   * ```
   */
  async registerWithDevServer(overrides?: {
    serveHost?: string;
    servePort?: number;
  }): Promise<void> {
    if (!this.options.baseUrl || this.options.baseUrl.includes('inngest.com')) {
      // Skip registration for production Inngest or if no baseUrl
      return;
    }

    try {
      // Use overrides if provided, otherwise fall back to options
      const port =
        overrides?.servePort ??
        this.options.servePort ??
        (process.env.PORT ? parseInt(process.env.PORT) : 3000);
      const host = overrides?.serveHost ?? this.options.serveHost ?? 'localhost';

      // Handle serveHost as either full URL or hostname
      // Use URL class to normalize (strips default ports like :80 for HTTP, :443 for HTTPS)
      const path = this.options.path || '/api/inngest';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      let appUrl: string;
      if (host.startsWith('http://') || host.startsWith('https://')) {
        // serveHost is a full URL, normalize it
        appUrl = new URL(normalizedPath, host).href;
      } else {
        // serveHost is just hostname, construct URL with port and normalize
        appUrl = new URL(`http://${host}:${port}${normalizedPath}`).href;
      }

      const devServerUrl = this.options.baseUrl;

      // Configuration validation warnings
      if (process.env.PORT && parseInt(process.env.PORT) !== port) {
        this.logger.warn(
          `Port mismatch detected: servePort (${port}) differs from PORT env var (${process.env.PORT}). ` +
            `Ensure they match, or Inngest won't be able to call your functions. ` +
            `See: https://github.com/yourusername/nestjs-inngest#port-mismatch-issues`,
        );
      }

      if (host === 'localhost' && (process.env.KUBERNETES_SERVICE_HOST || process.env.DOCKER)) {
        this.logger.warn(
          `Using 'localhost' for serveHost in containerized environment. ` +
            `This may not work in Docker/Kubernetes. Consider using service DNS names or setting INNGEST_SERVE_HOST. ` +
            `See: https://github.com/yourusername/nestjs-inngest#kubernetes-docker-connection-issues`,
        );
      }

      this.logger.log('Attempting auto-registration with Inngest dev server', {
        devServerUrl,
        appUrl,
        port,
        source: overrides ? 'manual-registration' : 'auto-nestjs-inngest',
        hasSigningKey: !!this.options.signingKey,
        configSource: overrides ? 'overrides' : this.getConfigSource(port, host),
      });

      const response = await fetch(`${devServerUrl}/fn/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.signingKey && {
            Authorization: `Bearer ${this.options.signingKey}`,
          }),
        },
        body: JSON.stringify({
          url: appUrl,
          source: 'auto-nestjs-inngest',
        }),
      });

      if (response.ok) {
        this.logger.log('Successfully auto-registered with Inngest dev server', {
          devServerUrl,
          appUrl,
          status: response.status,
        });
      } else {
        this.logger.warn('Auto-registration failed', {
          devServerUrl,
          appUrl,
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (error) {
      this.logger.warn('Auto-registration failed', {
        devServerUrl: this.options.baseUrl,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Helper to determine where configuration values came from
   */
  private getConfigSource(port: number, host: string): string {
    const sources: string[] = [];

    if (this.options.servePort) {
      sources.push('explicit-config');
    } else if (process.env.INNGEST_SERVE_PORT) {
      sources.push('INNGEST_SERVE_PORT');
    } else if (process.env.PORT) {
      sources.push('PORT');
    } else {
      sources.push('default');
    }

    if (this.options.serveHost) {
      sources.push('explicit-host');
    } else if (process.env.INNGEST_SERVE_HOST) {
      sources.push('INNGEST_SERVE_HOST');
    } else {
      sources.push('default-host');
    }

    return sources.join(',');
  }

  /**
   * Get the Inngest client instance
   */
  getClient(): Inngest {
    return this.inngestClient;
  }

  /**
   * Send an event to Inngest
   */
  async send<TEvents extends Record<string, EventPayload> = GetEvents<Inngest>>(
    payload: keyof TEvents extends never
      ? EventPayload | EventPayload[]
      : TEvents[keyof TEvents] | TEvents[keyof TEvents][],
  ) {
    try {
      // Automatically inject trace context if tracing is enabled
      const enhancedPayload = this.injectTraceContext(payload);
      const result = await this.inngestClient.send(enhancedPayload as any);
      this.logger.debug('Event sent successfully with trace context', {
        eventCount: Array.isArray(enhancedPayload) ? enhancedPayload.length : 1,
        hasTraceContext: this.hasTraceContext(enhancedPayload),
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to send event: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Send an event with explicit trace context
   */
  async sendWithTraceId<TEvents extends Record<string, EventPayload> = GetEvents<Inngest>>(
    payload: keyof TEvents extends never
      ? EventPayload | EventPayload[]
      : TEvents[keyof TEvents] | TEvents[keyof TEvents][],
    traceContext: TraceContext | string,
  ) {
    try {
      // Parse traceId if provided as string (W3C traceparent format)
      let parsedTraceContext: TraceContext;
      if (typeof traceContext === 'string') {
        parsedTraceContext = this.parseTraceparent(traceContext);
      } else {
        parsedTraceContext = traceContext;
      }

      // Inject the provided trace context
      const enhancedPayload = this.injectExplicitTraceContext(payload, parsedTraceContext);
      const result = await this.inngestClient.send(enhancedPayload as any);

      this.logger.debug('Event sent with explicit trace context', {
        traceId: parsedTraceContext.traceId,
        eventCount: Array.isArray(enhancedPayload) ? enhancedPayload.length : 1,
      });
      return result;
    } catch (error) {
      this.logger.error(`Failed to send event with trace context: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Extract trace context from HTTP request headers
   */
  extractTraceFromHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): TraceContext | null {
    try {
      const traceparent = headers['traceparent'] || headers['x-trace-id'];
      if (typeof traceparent === 'string') {
        return this.parseTraceparent(traceparent);
      }
      return null;
    } catch (error) {
      this.logger.warn('Failed to extract trace context from headers', {
        error: error.message,
        headers: Object.keys(headers),
      });
      return null;
    }
  }

  /**
   * Get current active trace context from OpenTelemetry
   */
  getCurrentTraceContext(): TraceContext | null {
    if (!this.tracingService) {
      return null;
    }
    return this.tracingService.getCurrentTraceContext();
  }

  /**
   * Parse W3C traceparent header format: 00-{traceId}-{spanId}-{flags}
   */
  private parseTraceparent(traceparent: string): TraceContext {
    const parts = traceparent.split('-');
    if (parts.length !== 4) {
      throw new Error(`Invalid traceparent format: ${traceparent}`);
    }

    const [version, traceId, spanId, flags] = parts;
    return {
      traceId,
      spanId,
      parentSpanId: spanId,
      traceFlags: parseInt(flags, 16),
    };
  }

  /**
   * Inject current trace context into event payload
   */
  private injectTraceContext(payload: any): any {
    if (!this.tracingService) {
      return payload;
    }

    return this.tracingService.injectTraceContext(payload);
  }

  /**
   * Inject explicit trace context into event payload
   */
  private injectExplicitTraceContext(payload: any, traceContext: TraceContext): any {
    const payloadArray = Array.isArray(payload) ? payload : [payload];

    const enhancedPayloads = payloadArray.map((event) => ({
      ...event,
      data: {
        ...event.data,
        traceContext: {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          parentSpanId: traceContext.parentSpanId,
          traceFlags: traceContext.traceFlags,
        },
      },
    }));

    return Array.isArray(payload) ? enhancedPayloads : enhancedPayloads[0];
  }

  /**
   * Check if payload contains trace context
   */
  private hasTraceContext(payload: any): boolean {
    if (Array.isArray(payload)) {
      return payload.some((event) => event.data?.traceContext || event.traceContext);
    }
    return !!(payload?.data?.traceContext || payload?.traceContext);
  }

  /**
   * Register a function with the Inngest service
   */
  registerFunction(fn: InngestFunction<any, any, any>) {
    this.functions.push(fn);
    const functionId = typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown';
    this.logger.debug(`Registered function: ${functionId}`);
  }

  /**
   * Get all registered functions
   */
  getFunctions(): InngestFunction<any, any, any>[] {
    return this.functions;
  }

  /**
   * Create a function using the Inngest client
   */
  createFunction(options: any, handler: any): any {
    // Extract trigger from options for Inngest v3 API: createFunction(options, trigger, handler)
    const { trigger, triggers, ...fnOptions } = options;

    // Determine the trigger - could be from 'trigger' or 'triggers' or infer from event name
    let triggerConfig = trigger;
    if (!triggerConfig && triggers) {
      triggerConfig = triggers[0] || triggers;
    }
    if (!triggerConfig && options.event) {
      triggerConfig = { event: options.event };
    }

    try {
      const fn = this.inngestClient.createFunction(fnOptions, triggerConfig, handler);
      this.registerFunction(fn);
      return fn;
    } catch (error) {
      this.logger.error(`Failed to create function: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Create a scheduled function
   */
  createScheduledFunction(options: any & { cron: string }, handler: any): any {
    const { cron, ...fnOptions } = options;
    return this.createFunction(
      {
        ...fnOptions,
        trigger: { cron },
      },
      handler,
    );
  }

  /**
   * Get module options
   */
  getOptions(): InngestModuleOptions {
    return this.options;
  }

  // ============ PUBLIC API FOR CONNECT MODE ============

  /**
   * Get connection state (connect mode only)
   * Returns 'NOT_APPLICABLE' for serve mode
   *
   * Possible states:
   * - 'NOT_APPLICABLE': Running in serve mode
   * - 'CONNECTING': Initial connection being established
   * - 'ACTIVE': Connected and ready to receive function invocations
   * - 'PAUSED': Connection paused (e.g., during backoff)
   * - 'RECONNECTING': Temporarily disconnected, attempting to reconnect
   * - 'CLOSING': Graceful shutdown in progress
   * - 'CLOSED': Connection has been closed
   */
  getConnectionState(): string {
    if (this.options.mode !== 'connect') {
      return 'NOT_APPLICABLE';
    }
    return this.workerConnection?.state ?? 'CLOSED';
  }

  /**
   * Check if the worker connection is active (connect mode only)
   * Returns false for serve mode (use health checks instead)
   */
  isConnected(): boolean {
    if (this.options.mode !== 'connect') {
      return false;
    }
    // Use ConnectionState enum when available for type safety
    const activeState = ConnectionStateEnum?.ACTIVE ?? 'ACTIVE';
    return this.workerConnection?.state === activeState;
  }

  /**
   * Get accurate connection health by inspecting SDK internals.
   *
   * This method accesses internal properties of the Inngest SDK that are not
   * part of the public API. This is necessary because the SDK's public `state`
   * property can get stuck at 'ACTIVE' even when the underlying WebSocket
   * connection is dead (edge case where SDK's heartbeat mechanism fails).
   *
   * The method checks:
   * 1. `currentConnection` - If null, connection is definitely dead
   * 2. `currentConnection.ws.readyState` - Actual WebSocket state from Node.js
   * 3. `currentConnection.pendingHeartbeats` - Missed heartbeat count (≥2 = failing)
   *
   * Falls back gracefully to state-only check if SDK internals are inaccessible
   * (e.g., if SDK internal structure changes in a future version).
   *
   * ## SDK Compatibility
   * Tested and compatible with inngest SDK v3.40.2 - v3.49.1.
   *
   * Internal properties accessed (not part of public API):
   * - `workerConnection.currentConnection` - Active connection wrapper
   * - `currentConnection.ws.readyState` - Node.js WebSocket state (0-3)
   * - `currentConnection.pendingHeartbeats` - Missed heartbeat counter
   *
   * If SDK internals change in future versions, this method falls back
   * gracefully to state-only checking with `usingInternalCheck: false`.
   *
   * @see https://github.com/inngest/inngest-js/blob/v3.49.1/packages/inngest/src/components/connect/index.ts
   * @returns ConnectionHealthInfo with detailed health status
   */
  getConnectionHealth(): ConnectionHealthInfo {
    // Not applicable for serve mode
    if (this.options.mode !== 'connect') {
      return {
        isHealthy: true,
        reason: 'Running in serve mode (HTTP webhooks)',
        sdkState: 'NOT_APPLICABLE',
        wsReadyState: null,
        wsStateName: null,
        pendingHeartbeats: null,
        connectionId: null,
        usingInternalCheck: false,
      };
    }

    const sdkState = this.workerConnection?.state ?? 'CLOSED';
    // Use ConnectionState enum when available for type-safe comparisons
    const activeState = ConnectionStateEnum?.ACTIVE ?? 'ACTIVE';

    // Try to get connection ID safely (getter throws if currentConnection is null)
    let connectionId: string | null = null;
    try {
      connectionId = this.workerConnection?.connectionId ?? null;
    } catch {
      // connectionId getter throws if currentConnection is null - this is expected
      connectionId = null;
    }

    // Try to access SDK internals for accurate health
    try {
      // Cast to any to access internal properties

      const conn = this.workerConnection as any;
      const currentConnection = conn?.currentConnection;

      // Check 1: If currentConnection is null/undefined, connection is dead
      if (!currentConnection) {
        return {
          isHealthy: false,
          reason: 'No active connection (currentConnection is null)',
          sdkState,
          wsReadyState: null,
          wsStateName: null,
          pendingHeartbeats: null,
          connectionId: null,
          usingInternalCheck: true,
        };
      }

      // Check 2: WebSocket readyState - the ground truth
      const ws = currentConnection.ws;
      const wsReadyState: number | undefined = ws?.readyState;

      // If wsReadyState is not accessible, fall back to state-only mode
      if (typeof wsReadyState !== 'number') {
        const isHealthy = sdkState === activeState;
        return {
          isHealthy,
          reason: isHealthy
            ? 'Connection appears active (WebSocket state not accessible)'
            : `Connection state is ${sdkState} (WebSocket state not accessible)`,
          sdkState,
          wsReadyState: null,
          wsStateName: null,
          pendingHeartbeats: null,
          connectionId: currentConnection.id ?? connectionId,
          usingInternalCheck: false,
        };
      }

      const wsStateName = InngestService.WS_STATE_NAMES[wsReadyState] ?? null;

      if (wsReadyState !== WebSocketReadyState.OPEN) {
        // WebSocket is not OPEN - connection is dead
        return {
          isHealthy: false,
          reason: `WebSocket is ${wsStateName} (expected OPEN)`,
          sdkState,
          wsReadyState,
          wsStateName,
          pendingHeartbeats: currentConnection.pendingHeartbeats ?? null,
          connectionId: currentConnection.id ?? connectionId,
          usingInternalCheck: true,
        };
      }

      // Check 3: Pending heartbeats - if ≥2, heartbeats are failing
      const pendingHeartbeats: number | undefined = currentConnection.pendingHeartbeats;
      if (typeof pendingHeartbeats === 'number' && pendingHeartbeats >= 2) {
        return {
          isHealthy: false,
          reason: `Heartbeat failure (${pendingHeartbeats} consecutive heartbeats missed)`,
          sdkState,
          wsReadyState: wsReadyState ?? null,
          wsStateName,
          pendingHeartbeats,
          connectionId: currentConnection.id ?? connectionId,
          usingInternalCheck: true,
        };
      }

      // Check 4: SDK state should be ACTIVE for healthy connection
      if (sdkState !== activeState) {
        return {
          isHealthy: false,
          reason: `Connection state is ${sdkState}`,
          sdkState,
          wsReadyState: wsReadyState ?? null,
          wsStateName,
          pendingHeartbeats: pendingHeartbeats ?? null,
          connectionId: currentConnection.id ?? connectionId,
          usingInternalCheck: true,
        };
      }

      // All checks passed - connection is healthy
      return {
        isHealthy: true,
        reason: 'Connection is active and healthy',
        sdkState,
        wsReadyState: wsReadyState ?? null,
        wsStateName,
        pendingHeartbeats: pendingHeartbeats ?? null,
        connectionId: currentConnection.id ?? connectionId,
        usingInternalCheck: true,
      };
    } catch (error) {
      // Failed to access SDK internals - fall back to state-only check
      // Log warning only once to prevent spam on frequent health checks
      if (!this.hasLoggedInternalCheckWarning) {
        this.hasLoggedInternalCheckWarning = true;
        this.logger.warn(
          'Failed to access SDK internals for health check, falling back to state-only',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        );
      }

      const isHealthy = sdkState === activeState;
      return {
        isHealthy,
        reason: isHealthy
          ? 'Connection appears active (internal check unavailable)'
          : `Connection state is ${sdkState} (internal check unavailable)`,
        sdkState,
        wsReadyState: null,
        wsStateName: null,
        pendingHeartbeats: null,
        connectionId,
        usingInternalCheck: false,
      };
    }
  }

  /**
   * Create step tools for testing
   */
  createStepTools() {
    // This is useful for testing Inngest functions
    return {
      run: async <T>(id: string, fn: () => Promise<T> | T): Promise<T> => {
        this.logger.debug(`Step run: ${id}`);
        return await fn();
      },
      sleep: async (id: string, duration: string | number | Date): Promise<void> => {
        this.logger.debug(`Step sleep: ${id} for ${duration}`);
      },
      sleepUntil: async (id: string, until: string | number | Date): Promise<void> => {
        this.logger.debug(`Step sleepUntil: ${id} until ${until}`);
      },
      waitForEvent: async <T = any>(id: string, options: any): Promise<T | null> => {
        this.logger.debug(`Step waitForEvent: ${id}`);
        return null;
      },
      sendEvent: async (id: string, events: any | any[]): Promise<void> => {
        this.logger.debug(`Step sendEvent: ${id}`);
        await this.send(events);
      },
    };
  }
}
