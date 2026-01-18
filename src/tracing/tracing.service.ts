import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { INNGEST_MODULE_OPTIONS } from '../constants';
import { InngestModuleOptions, InngestTracingConfig } from '../interfaces';

// OpenTelemetry interfaces (compatible with optional dependency)
interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  addEvent(name: string, attributesOrStartTime?: any, startTime?: any): void;
  recordException(exception: Error): void;
  setStatus(status: { code: number; message?: string }): void;
  end(endTime?: number): void;
}

interface Tracer {
  startSpan(name: string, options?: any): Span;
  startActiveSpan(name: string, options: any, callback: (span: Span) => any): any;
}

export interface TraceContext {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceFlags?: number;
}

export interface InngestTraceContext extends TraceContext {
  functionId: string;
  functionName: string;
  eventName?: string;
  runId?: string;
  stepId?: string;
}

@Injectable()
export class InngestTracingService {
  private readonly logger = new Logger(InngestTracingService.name);
  private tracer?: Tracer;
  private trace?: any; // OpenTelemetry trace API
  private context?: any; // OpenTelemetry context API
  private isEnabled = false;
  private tracingConfig: InngestTracingConfig;

  constructor(
    @Optional()
    @Inject(INNGEST_MODULE_OPTIONS)
    private readonly moduleOptions?: InngestModuleOptions,
  ) {
    // Extract tracing configuration with defaults
    this.tracingConfig = {
      enabled: true, // Re-enable our custom tracing
      serviceName: this.moduleOptions?.id || 'unknown-service', // Default to consumer's app ID
      includeEventData: false,
      includeStepData: false,
      defaultAttributes: {},
      contextInjection: {
        enabled: true,
        fieldName: 'traceContext',
      },
      ...this.moduleOptions?.tracing,
    };

    this.initializeTracing();
  }

  private initializeTracing(): void {
    // Check if tracing is enabled in configuration
    if (!this.tracingConfig.enabled) {
      this.logger.debug('Tracing disabled by configuration');
      this.isEnabled = false;
      return;
    }

    try {
      // Try to load OpenTelemetry APIs (optional dependencies)
      const otelApi = require('@opentelemetry/api');
      this.trace = otelApi.trace;
      this.context = otelApi.context;

      if (this.trace) {
        this.tracer = this.trace.getTracer(
          this.tracingConfig.serviceName || 'unknown-service',
          process.env.npm_package_version || '0.1.0',
        );
        this.isEnabled = true;
        this.logger.debug('OpenTelemetry integration enabled', {
          tracerName: this.tracingConfig.serviceName,
          version: process.env.npm_package_version || '0.1.0',
          configuration: this.tracingConfig,
        });

        // Try to register a custom span processor to intercept and rename Inngest spans
        this.registerCustomSpanProcessor();
      }
    } catch (error) {
      this.logger.debug('OpenTelemetry not available - tracing disabled', {
        error: error.message,
      });
      this.isEnabled = false;
    }
  }

  /**
   * Register custom span processor to intercept and rename Inngest execution spans
   */
  private registerCustomSpanProcessor(): void {
    try {
      // Instead of trying to register a span processor, let's create a custom tracer wrapper
      // that intercepts startSpan calls and renames inngest.execution spans
      if (this.tracer) {
        const originalStartSpan = this.tracer.startSpan.bind(this.tracer);

        // Override the startSpan method to intercept inngest.execution spans
        this.tracer.startSpan = (name: string, options?: any): Span => {
          // Check if this is an inngest.execution span
          if (name === 'inngest.execution') {
            // Try to extract function ID from current context or options
            const functionId = this.extractFunctionIdFromContext(options);
            if (functionId) {
              const newName = `${functionId}.execution`;
              this.logger.debug('🎯 Renaming span from inngest.execution to', {
                newName,
                functionId,
              });
              return originalStartSpan(newName, options);
            }
          }

          // For all other spans, use original behavior
          return originalStartSpan(name, options);
        };

        this.logger.debug('✅ Custom tracer wrapper installed for function name fixing');
      }
    } catch (error) {
      this.logger.debug('Failed to register custom tracer wrapper', {
        error: error.message,
      });
    }
  }

  /**
   * Extract function ID from span context or options
   */
  private extractFunctionIdFromContext(options: any): string | null {
    try {
      // Try to get function ID from span options/attributes
      const attributes = options?.attributes || {};

      // Look for various attributes that might contain function ID
      const functionId =
        attributes['inngest.function.id'] ||
        attributes['function.id'] ||
        attributes['inngest.fn.id'] ||
        attributes['fn.id'];

      if (functionId) {
        return functionId;
      }

      // If no direct function ID, try to extract from operation name or other attributes
      const operationName = attributes['inngest.operation.name'] || attributes['operation.name'];
      if (operationName && operationName !== 'inngest.execution') {
        return operationName;
      }

      return null;
    } catch (error) {
      this.logger.debug('Failed to extract function ID from context', { error: error.message });
      return null;
    }
  }

  /**
   * Extract function ID from span attributes or context
   */
  private extractFunctionIdFromSpan(span: any): string | null {
    try {
      // Try to get function ID from span attributes
      const attributes = span.attributes || {};

      // Look for various attributes that might contain function ID
      const functionId =
        attributes['inngest.function.id'] ||
        attributes['function.id'] ||
        attributes['inngest.fn.id'] ||
        attributes['fn.id'];

      if (functionId) {
        return functionId;
      }

      // If no direct function ID, try to extract from operation name or other attributes
      const operationName = attributes['inngest.operation.name'] || attributes['operation.name'];
      if (operationName && operationName !== 'inngest.execution') {
        return operationName;
      }

      return null;
    } catch (error) {
      this.logger.debug('Failed to extract function ID from span', { error: error.message });
      return null;
    }
  }

  /**
   * Check if OpenTelemetry tracing is available and enabled
   */
  isTracingEnabled(): boolean {
    return this.isEnabled && !!this.tracer;
  }

  /**
   * Get current trace context from OpenTelemetry
   */
  getCurrentTraceContext(): TraceContext | null {
    if (!this.isTracingEnabled() || !this.trace || !this.context) {
      return null;
    }

    try {
      const activeSpan = this.trace.getActiveSpan();
      if (!activeSpan) {
        return null;
      }

      const spanContext = activeSpan.spanContext();
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
      };
    } catch (error) {
      this.logger.warn('Failed to get current trace context:', error.message);
      return null;
    }
  }

  /**
   * Create a new span for Inngest function execution
   */
  startFunctionSpan(
    functionId: string,
    functionName: string,
    context: {
      eventName?: string;
      runId?: string;
      stepId?: string;
      triggerType?: 'event' | 'cron' | 'manual';
      userId?: string;
      tenantId?: string;
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): Span | null {
    if (!this.isTracingEnabled() || !this.tracer) {
      return null;
    }

    try {
      // Use descriptive span name: {functionId}.execution
      const spanName = `${functionId}.execution`;

      this.logger.debug('🚀 Starting function span', {
        spanName,
        functionId,
        functionName,
        serviceName: this.tracingConfig.serviceName,
        hasTracer: !!this.tracer,
        context: {
          eventName: context.eventName,
          runId: context.runId,
          triggerType: context.triggerType,
          userId: context.userId,
          tenantId: context.tenantId,
        },
      });

      const span = this.tracer.startSpan(spanName, {
        kind: 1, // SERVER span kind
        attributes: {
          // Core Inngest function attributes
          'inngest.function.id': functionId,
          'inngest.function.name': functionName,
          'inngest.function.type': context.triggerType || 'event-driven',
          'inngest.sdk.name': 'nestjs-inngest',
          'inngest.sdk.version': process.env.npm_package_version || '0.1.0',

          // Event and trigger context
          ...(context.eventName && {
            'inngest.event.name': context.eventName,
            'inngest.event.type': 'user_event',
            'inngest.trigger.type': context.triggerType || 'event',
            'inngest.trigger.source': context.eventName,
          }),

          // Execution context
          ...(context.runId && {
            'inngest.run.id': context.runId,
            'inngest.execution.id': context.runId,
            'inngest.execution.type': 'function',
          }),

          // Step context (if within a step)
          ...(context.stepId && {
            'inngest.step.id': context.stepId,
            'inngest.step.parent': functionId,
          }),

          // Business context
          ...(context.userId && {
            'user.id': context.userId,
            'inngest.user.id': context.userId,
          }),
          ...(context.tenantId && {
            'tenant.id': context.tenantId,
            'inngest.tenant.id': context.tenantId,
          }),

          // Service metadata (OpenTelemetry semantic conventions)
          'service.name': this.tracingConfig.serviceName || 'unknown-service',
          'service.namespace': 'inngest',
          'service.version': process.env.npm_package_version || '0.1.0',

          // Operation metadata
          'operation.name': functionId,
          'operation.type': 'inngest.function',
          'operation.description': `Execute Inngest function: ${functionName}`,

          // Component and framework
          component: 'inngest-function',
          framework: 'nestjs',
          'instrumentation.name': 'nestjs-inngest',
          'instrumentation.version': process.env.npm_package_version || '0.1.0',

          // Default attributes from configuration
          ...this.tracingConfig.defaultAttributes,

          // Context-specific attributes (can override defaults)
          ...context.attributes,
        },
      });

      this.logger.debug('Started function execution span', {
        spanName,
        functionId,
        functionName,
        spanKind: 'SERVER',
        context: {
          eventName: context.eventName,
          runId: context.runId,
          stepId: context.stepId,
          triggerType: context.triggerType,
          userId: context.userId,
          tenantId: context.tenantId,
        },
      });
      return span;
    } catch (error) {
      this.logger.warn('Failed to start function span:', error.message);
      return null;
    }
  }

  /**
   * Create a new span for Inngest step execution
   */
  startStepSpan(
    stepName: string,
    context: {
      functionId?: string;
      runId?: string;
      stepMethod?: string;
      stepType?: string;
      userId?: string;
      tenantId?: string;
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): Span | null {
    if (!this.isTracingEnabled() || !this.tracer) {
      return null;
    }

    try {
      // Use descriptive span name: {functionId}.step.{stepName}
      const functionPrefix = context.functionId ? `${context.functionId}.step` : 'inngest.step';
      const spanName = `${functionPrefix}.${stepName}`;
      const span = this.tracer.startSpan(spanName, {
        kind: 0, // INTERNAL span kind
        attributes: {
          // Core step attributes
          'inngest.step.name': stepName,
          'inngest.step.type': context.stepType || 'user_step',
          'inngest.step.method': context.stepMethod || 'unknown',
          'inngest.sdk.name': 'nestjs-inngest',
          'inngest.sdk.version': process.env.npm_package_version || '0.1.0',

          // Function context (parent)
          ...(context.functionId && {
            'inngest.function.id': context.functionId,
            'inngest.parent.function.id': context.functionId,
            'inngest.step.parent_function': context.functionId,
          }),

          // Execution context
          ...(context.runId && {
            'inngest.run.id': context.runId,
            'inngest.execution.id': context.runId,
            'inngest.execution.type': 'step',
          }),

          // Business context
          ...(context.userId && {
            'user.id': context.userId,
            'inngest.user.id': context.userId,
          }),
          ...(context.tenantId && {
            'tenant.id': context.tenantId,
            'inngest.tenant.id': context.tenantId,
          }),

          // Service metadata (OpenTelemetry semantic conventions)
          'service.name': this.tracingConfig.serviceName || 'unknown-service',
          'service.namespace': 'inngest',
          'service.version': process.env.npm_package_version || '0.1.0',

          // Operation metadata
          'operation.name': stepName,
          'operation.type': 'inngest.step',
          'operation.description': `Execute Inngest step: ${stepName}`,

          // Component and framework
          component: 'inngest-step',
          framework: 'nestjs',
          'instrumentation.name': 'nestjs-inngest',
          'instrumentation.version': process.env.npm_package_version || '0.1.0',

          // Default attributes from configuration
          ...this.tracingConfig.defaultAttributes,

          // Context-specific attributes (can override defaults)
          ...context.attributes,
        },
      });

      this.logger.debug('Started step execution span', {
        spanName,
        stepName,
        functionId: context.functionId,
        spanKind: 'INTERNAL',
        context: {
          stepMethod: context.stepMethod,
          stepType: context.stepType,
          runId: context.runId,
          userId: context.userId,
          tenantId: context.tenantId,
        },
      });
      return span;
    } catch (error) {
      this.logger.warn('Failed to start step span:', error.message);
      return null;
    }
  }

  /**
   * Record function execution result on span
   */
  recordFunctionResult(
    span: Span | null,
    result: {
      success: boolean;
      duration: number;
      error?: Error;
      metadata?: Record<string, any>;
    },
  ): void {
    if (!span) return;

    try {
      span.setAttributes({
        'inngest.function.success': result.success,
        'inngest.function.duration_ms': result.duration,
        ...(result.metadata &&
          Object.entries(result.metadata).reduce(
            (acc, [key, value]) => {
              if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
              ) {
                acc[`inngest.function.metadata.${key}`] = value;
              }
              return acc;
            },
            {} as Record<string, string | number | boolean>,
          )),
      });

      if (result.error) {
        span.recordException(result.error);
        span.setStatus({
          code: 2, // ERROR status
          message: result.error.message,
        });
      } else {
        span.setStatus({
          code: 1, // OK status
        });
      }

      span.addEvent('function.completed', {
        success: result.success,
        duration: result.duration,
      });
    } catch (error) {
      this.logger.warn('Failed to record function result on span:', error.message);
    }
  }

  /**
   * Safely end a span
   */
  endSpan(span: Span | null): void {
    if (!span) return;

    try {
      span.end();
    } catch (error) {
      this.logger.warn('Failed to end span:', error.message);
    }
  }

  /**
   * Create trace context for passing to Inngest function
   */
  createInngestTraceContext(
    functionId: string,
    functionName: string,
    additionalContext: Partial<InngestTraceContext> = {},
  ): InngestTraceContext {
    const currentTrace = this.getCurrentTraceContext();

    return {
      ...currentTrace,
      functionId,
      functionName,
      ...additionalContext,
    };
  }

  /**
   * Extract trace context from Inngest event or context
   */
  extractTraceContext(inngestContext: any): TraceContext | null {
    try {
      // Priority order for trace context extraction:
      // 1. Direct context (for middleware-injected context)
      if (inngestContext?.traceContext) {
        return inngestContext.traceContext;
      }

      // 2. Event data (for event-triggered functions)
      if (inngestContext?.event?.data?.traceContext) {
        return inngestContext.event.data.traceContext;
      }

      // 3. Event metadata (alternative location)
      if (inngestContext?.event?.traceContext) {
        return inngestContext.event.traceContext;
      }

      return null;
    } catch (error) {
      this.logger.warn('Failed to extract trace context:', error.message);
      return null;
    }
  }

  /**
   * Inject trace context into event data for propagation
   */
  injectTraceContext(eventData: any): any {
    if (!this.isTracingEnabled()) {
      return eventData;
    }

    // Check if context injection is enabled
    if (!this.tracingConfig.contextInjection?.enabled) {
      return eventData;
    }

    try {
      const currentTrace = this.getCurrentTraceContext();
      if (!currentTrace) {
        return eventData;
      }

      const fieldName = this.tracingConfig.contextInjection?.fieldName || 'traceContext';

      // Inject trace context into event data using configured field name
      return {
        ...eventData,
        [fieldName]: {
          traceId: currentTrace.traceId,
          spanId: currentTrace.spanId,
          parentSpanId: currentTrace.parentSpanId,
          traceFlags: currentTrace.traceFlags,
        },
      };
    } catch (error) {
      this.logger.warn('Failed to inject trace context:', error.message);
      return eventData;
    }
  }

  /**
   * Create tracing middleware for Inngest functions
   *
   * @deprecated Custom tracing middleware is disabled. The Inngest SDK's built-in
   * tracing uses startActiveSpan() which properly propagates context to Pino and
   * other OTel-instrumented loggers. Use extendedTracesMiddleware from 'inngest/experimental'
   * instead for enhanced tracing capabilities.
   */
  createTracingMiddleware() {
    // Disabled: Custom middleware creates non-active spans that don't propagate context
    // The SDK's core execution already uses startActiveSpan() which properly
    // propagates context for log correlation. Using extendedTracesMiddleware instead.
    this.logger.debug(
      'Custom tracing middleware disabled - using SDK built-in tracing via extendedTracesMiddleware',
    );
    return null;

    // Legacy implementation kept for reference but disabled
    /* istanbul ignore next */
    if (!this.isTracingEnabled()) {
      this.logger.debug('OpenTelemetry tracing disabled, no middleware will be applied');
      return null;
    }

    this.logger.debug('Creating OpenTelemetry tracing middleware for Inngest functions');

    return {
      name: 'nestjs-inngest-tracing',
      init: () => {
        this.logger.debug('🔧 OpenTelemetry middleware initialized by Inngest SDK');
        return {
          onFunctionRun: () => {
            this.logger.debug('⚡ onFunctionRun hook called');
            return {
              transformInput: (inputParams: any) => {
                this.logger.debug('🔄 transformInput called', {
                  hasCtx: !!inputParams?.ctx,
                  hasStep: !!inputParams?.ctx?.step,
                  hasFn: !!inputParams?.fn,
                  fnId: inputParams?.fn?.id,
                  fnName: inputParams?.fn?.name,
                });
                try {
                  if (!inputParams?.ctx?.step) {
                    return inputParams;
                  }

                  const { ctx, fn, steps, ...rest } = inputParams;

                  // Wrap step methods with OpenTelemetry tracing
                  const wrappedStep = this.wrapStepMethods(ctx.step, fn, ctx);
                  const functionId = typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown';
                  this.logger.debug('Wrapped step methods for function', {
                    functionId,
                    functionName: fn?.name || 'unknown',
                  });

                  return {
                    ...rest,
                    ctx: {
                      ...ctx,
                      step: wrappedStep,
                    },
                    fn,
                    steps,
                  };
                } catch (error) {
                  this.logger.error(
                    'Failed to wrap step methods in transformInput:',
                    error.message,
                  );
                  return inputParams;
                }
              },
              beforeExecution: (...args: any[]) => {
                // Debug the actual arguments structure
                this.logger.debug('🔍 MIDDLEWARE beforeExecution called with args', {
                  argsLength: args.length,
                  argTypes: args.map((arg) => typeof arg),
                  firstArgKeys: args[0] ? Object.keys(args[0]) : null,
                  firstArg: args[0],
                });

                // Handle parameter validation - try different parameter structures
                let params = args[0];
                if (!params) {
                  this.logger.warn('beforeExecution called with no parameters');
                  return {};
                }

                const { ctx, event, fn, ...execParams } = params;

                // Create function-level parent span
                this.logger.debug('🔍 MIDDLEWARE beforeExecution extracted params', {
                  hasFn: !!fn,
                  fnId: fn?.id,
                  fnIdType: typeof fn?.id,
                  fnName: fn?.name,
                  hasCtx: !!ctx,
                  hasEvent: !!event,
                  eventName: event?.name,
                  runId: ctx?.runId,
                  allParams: Object.keys(execParams || {}),
                });

                try {
                  if (ctx?.event || event) {
                    const functionId =
                      typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown-function';
                    const functionName = fn?.name || functionId;

                    this.logger.debug('🎯 Creating function span', {
                      functionId,
                      functionName,
                      extractedFromType: typeof fn?.id,
                      originalId: fn?.id,
                    });

                    // Extract business context from event data
                    const actualEvent = ctx?.event || event;
                    const eventData = actualEvent?.data || {};
                    const userId = eventData.userId || eventData.user?.id;
                    const tenantId = eventData.tenantId || eventData.tenant?.id;

                    // Determine trigger type
                    let triggerType: 'event' | 'cron' | 'manual' = 'event';
                    if (actualEvent?.name?.startsWith('inngest/scheduled')) {
                      triggerType = 'cron';
                    } else if (!actualEvent?.name) {
                      triggerType = 'manual';
                    }

                    const functionSpan = this.startFunctionSpan(functionId, functionName, {
                      eventName: actualEvent?.name,
                      runId: ctx?.runId,
                      triggerType,
                      userId,
                      tenantId,
                      attributes: {
                        // Execution metadata
                        'inngest.execution.attempt': ctx?.attempt || 1,
                        'inngest.execution.mode': 'function',
                        'inngest.execution.batch': ctx?.batch || false,
                        'inngest.execution.timestamp': new Date().toISOString(),

                        // Event metadata
                        ...(actualEvent && {
                          'inngest.event.id': actualEvent.id,
                          'inngest.event.timestamp': actualEvent.ts,
                          'inngest.event.size': JSON.stringify(actualEvent).length,
                          'inngest.event.has_data': !!actualEvent.data,
                          'inngest.event.data_keys': actualEvent.data
                            ? Object.keys(actualEvent.data).join(',')
                            : '',
                        }),

                        // Environment metadata
                        'deployment.environment': process.env.NODE_ENV || 'development',
                        'host.name': process.env.HOSTNAME || 'localhost',
                        'host.arch': process.arch,
                        'runtime.name': 'node',
                        'runtime.version': process.version,

                        // Request metadata
                        'http.method': 'POST',
                        'http.route': '/api/inngest',
                        'http.scheme': 'http',
                        'http.target': '/api/inngest',

                        // Framework and service metadata
                        'nestjs.module': 'inngest',
                        'framework.name': 'nestjs',
                        'framework.version': process.env.npm_package_version || '0.1.0',
                        'service.instance.id': process.env.HOSTNAME || 'localhost',
                      },
                    });

                    // Store span and start time in context for cleanup in afterExecution
                    ctx._functionSpan = functionSpan;
                    ctx._functionStartTime = Date.now();

                    this.logger.debug('Created function-level parent span', {
                      functionId,
                      functionName,
                      eventName: execParams.ctx.event?.name,
                      runId: execParams.ctx.runId,
                      triggerType,
                      userId,
                      tenantId,
                      attempt: execParams.ctx.attempt || 1,
                      hasSpan: !!functionSpan,
                    });
                  }
                } catch (error) {
                  this.logger.warn('Failed to create function-level span', {
                    error: error.message,
                  });
                }
                return {};
              },
              afterExecution: (...args: any[]) => {
                // Debug the actual arguments structure
                this.logger.debug('🏁 MIDDLEWARE afterExecution called with args', {
                  argsLength: args.length,
                  argTypes: args.map((arg) => typeof arg),
                  firstArgKeys: args[0] ? Object.keys(args[0]) : null,
                  firstArg: args[0],
                });

                // Handle parameter validation
                let params = args[0];
                if (!params) {
                  this.logger.warn('afterExecution called with no parameters');
                  return {};
                }

                const { ctx, error, fn, result, ...resultParams } = params;

                // Complete function-level parent span
                this.logger.debug('🏁 MIDDLEWARE afterExecution extracted params', {
                  hasFunctionSpan: !!ctx?._functionSpan,
                  hasError: !!error,
                  errorMessage: error?.message,
                  hasFn: !!fn,
                  fnId: fn?.id,
                  fnName: fn?.name,
                  hasResult: !!result,
                  allParams: Object.keys(resultParams || {}),
                });

                try {
                  if (ctx?._functionSpan) {
                    const functionSpan = ctx._functionSpan;
                    const success = !error;
                    const duration = Date.now() - (ctx._functionStartTime || 0);

                    this.recordFunctionResult(functionSpan, {
                      success,
                      duration,
                      error: error,
                      metadata: {
                        result: success ? 'completed' : 'failed',
                        hasSteps: true,
                      },
                    });

                    this.endSpan(functionSpan);

                    const functionId = typeof fn?.id === 'function' ? fn.id() : fn?.id || 'unknown';
                    this.logger.debug('Completed function-level parent span', {
                      functionId,
                      success,
                      duration,
                      error: error?.message,
                    });
                  }
                } catch (error) {
                  this.logger.warn('Failed to complete function-level span', {
                    error: error.message,
                  });
                }
                return {};
              },
            };
          },
          onSendEvent: () => {
            return {
              transformInput: ({ payloads }: any) => {
                try {
                  // Inject trace context into events if available
                  if (payloads && Array.isArray(payloads)) {
                    const enhancedPayloads = payloads.map((payload: any) =>
                      this.injectTraceContext(payload),
                    );
                    return { payloads: enhancedPayloads };
                  }
                  return { payloads };
                } catch (error) {
                  this.logger.error('Failed to inject trace context into events:', error.message);
                  return { payloads };
                }
              },
            };
          },
        };
      },
    };
  }

  /**
   * Wrap step methods with OpenTelemetry tracing
   */
  private wrapStepMethods(step: any, fn: any, context: any = {}): any {
    if (!this.isTracingEnabled()) {
      return step;
    }

    const functionId =
      typeof fn?.id === 'function' ? fn.id() : fn?.id || fn?.name || 'unknown-function';
    const runId = context.runId;
    const userId = context.event?.data?.userId || context.event?.data?.user?.id;
    const tenantId = context.event?.data?.tenantId || context.event?.data?.tenant?.id;

    // Create a proxy to wrap all step methods
    return new Proxy(step, {
      get: (target: any, prop: string) => {
        const originalMethod = target[prop];

        // Only wrap functions
        if (typeof originalMethod !== 'function') {
          return originalMethod;
        }

        // Return wrapped method with tracing
        return (...args: any[]) => {
          const stepName = args[0] || `${prop}-step`;
          const startTime = Date.now();

          const span = this.startStepSpan(stepName, {
            functionId,
            runId,
            stepMethod: prop,
            stepType: this.getStepMethodType(prop),
            userId,
            tenantId,
            attributes: {
              // Step method details
              'inngest.step.method': prop,
              'inngest.step.args_count': args.length,
              'inngest.step.method_type': this.getStepMethodType(prop),

              // Timing
              'inngest.step.start_time': startTime,
              'inngest.step.start_timestamp': new Date(startTime).toISOString(),

              // Arguments context (if safe to log)
              ...(args.length > 1 &&
                typeof args[1] === 'object' &&
                args[1] && {
                  'inngest.step.has_config': true,
                  'inngest.step.config_keys': Object.keys(args[1]).join(','),
                }),

              // Environment
              'deployment.environment': process.env.NODE_ENV || 'development',
              'runtime.name': 'node',
              'runtime.version': process.version,

              // Framework
              'framework.name': 'nestjs',
              'nestjs.module': 'inngest',
              'instrumentation.name': 'nestjs-inngest',
            },
          });

          try {
            const result = originalMethod.apply(target, args);

            // Handle both sync and async results
            if (result && typeof result.then === 'function') {
              return result
                .then((asyncResult: any) => {
                  const duration = Date.now() - startTime;
                  this.recordStepSuccess(span, duration);
                  this.endSpan(span);
                  return asyncResult;
                })
                .catch((asyncError: any) => {
                  const error =
                    asyncError instanceof Error ? asyncError : new Error(String(asyncError));
                  const duration = Date.now() - startTime;
                  this.recordStepError(span, error, duration);
                  this.endSpan(span);
                  throw asyncError;
                });
            } else {
              // Sync result
              const duration = Date.now() - startTime;
              this.recordStepSuccess(span, duration);
              this.endSpan(span);
              return result;
            }
          } catch (syncError) {
            const error = syncError instanceof Error ? syncError : new Error(String(syncError));
            const duration = Date.now() - startTime;
            this.recordStepError(span, error, duration);
            this.endSpan(span);
            throw syncError;
          }
        };
      },
    });
  }

  /**
   * Record successful step execution on span
   */
  private recordStepSuccess(span: any, duration: number): void {
    if (!span) return;

    try {
      span.setAttributes({
        'inngest.step.success': true,
        'inngest.step.duration_ms': duration,
      });
      span.addEvent('step.completed', {
        success: true,
        duration,
      });
      span.setStatus({ code: 1 }); // OK
    } catch (error) {
      this.logger.warn('Failed to record step success on span:', error.message);
    }
  }

  /**
   * Get the type of step method for better categorization
   */
  private getStepMethodType(methodName: string): string {
    const methodTypes = {
      run: 'computation',
      sendEvent: 'event_dispatch',
      sleep: 'delay',
      sleepUntil: 'delay',
      waitForEvent: 'event_wait',
      invoke: 'function_call',
      parallel: 'parallel_execution',
    };
    return methodTypes[methodName as keyof typeof methodTypes] || 'unknown';
  }

  /**
   * Record step execution error on span
   */
  private recordStepError(span: any, error: Error, duration: number): void {
    if (!span) return;

    try {
      span.recordException(error);
      span.setAttributes({
        'inngest.step.success': false,
        'inngest.step.duration_ms': duration,
      });
      span.setStatus({
        code: 2, // ERROR
        message: error.message,
      });
      span.addEvent('step.error', {
        success: false,
        duration,
        error: error.message,
      });
    } catch (spanError) {
      this.logger.warn('Failed to record step error on span:', spanError.message);
    }
  }
}
