import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { INNGEST_MODULE_OPTIONS } from '../constants';
import { InngestModuleOptions, InngestTracingConfig } from '../interfaces';

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

/**
 * Service for OpenTelemetry trace context propagation with Inngest.
 *
 * This service provides utilities for:
 * - Getting current trace context from OpenTelemetry
 * - Injecting trace context into Inngest event payloads
 * - Extracting trace context from Inngest function context
 *
 * Note: Actual tracing/spans are handled by the Inngest SDK's extendedTracesMiddleware.
 * This service only handles trace context propagation for event correlation.
 */
@Injectable()
export class InngestTracingService {
  private readonly logger = new Logger(InngestTracingService.name);
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
      enabled: true,
      serviceName: this.moduleOptions?.id || 'unknown-service',
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
    if (!this.tracingConfig.enabled) {
      this.logger.debug({ message: 'Tracing disabled by configuration' });
      this.isEnabled = false;
      return;
    }

    try {
      // Try to load OpenTelemetry APIs (optional dependencies)
      const otelApi = require('@opentelemetry/api');
      this.trace = otelApi.trace;
      this.context = otelApi.context;

      if (this.trace) {
        this.isEnabled = true;
        this.logger.debug({
          message: 'OpenTelemetry trace context propagation enabled',
          serviceName: this.tracingConfig.serviceName,
        });
      }
    } catch (error) {
      this.logger.debug({
        message: 'OpenTelemetry not available - trace context propagation disabled',
        error: error.message,
      });
      this.isEnabled = false;
    }
  }

  /**
   * Check if OpenTelemetry tracing is available and enabled
   */
  isTracingEnabled(): boolean {
    return this.isEnabled;
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
      this.logger.warn({
        message: 'Failed to get current trace context',
        error: error.message,
      });
      return null;
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
      this.logger.warn({
        message: 'Failed to extract trace context',
        error: error.message,
      });
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
      this.logger.warn({
        message: 'Failed to inject trace context',
        error: error.message,
      });
      return eventData;
    }
  }
}
