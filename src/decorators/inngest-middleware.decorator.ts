import { Middleware } from 'inngest';
import { INNGEST_MIDDLEWARE_METADATA, INNGEST_FUNCTION_METADATA } from '../constants';
import {
  InngestBatchEventsConfig,
  InngestCancellationRule,
  InngestCheckpointingConfig,
  InngestConcurrencyOption,
  InngestPriorityConfig,
  InngestRetryCount,
  InngestSingletonConfig,
  InngestTimeoutsConfig,
} from '../interfaces';

/**
 * Helper function to create decorators that work with both legacy and modern TypeScript decorators
 */
function createMetadataDecorator(_decoratorName: string, updateFn: (metadata: any) => void): any {
  return (target: any, propertyKey?: string | symbol, descriptor?: PropertyDescriptor | any) => {
    // Handle both legacy and modern decorator signatures
    if (typeof propertyKey === 'object' && propertyKey && 'kind' in propertyKey) {
      // Modern decorator (stage 3)
      const context = propertyKey as any;
      const propertyName = context.name;

      const metadata = Reflect.getMetadata(INNGEST_FUNCTION_METADATA, target, propertyName) || {};
      updateFn(metadata);
      Reflect.defineMetadata(INNGEST_FUNCTION_METADATA, metadata, target, propertyName);

      return target;
    } else {
      // Legacy decorator
      if (!propertyKey) {
        throw new Error('PropertyKey is required for legacy decorator');
      }

      const metadata = Reflect.getMetadata(INNGEST_FUNCTION_METADATA, target, propertyKey) || {};
      updateFn(metadata);
      Reflect.defineMetadata(INNGEST_FUNCTION_METADATA, metadata, target, propertyKey);

      return descriptor;
    }
  };
}

function appendMetadataArray<T>(currentValue: T[] | undefined, nextValue: T | T[]): T[] {
  const nextValues = Array.isArray(nextValue) ? nextValue : [nextValue];
  return [...(currentValue || []), ...nextValues];
}

/**
 * Decorator to add middleware to an Inngest function
 */
export function UseMiddleware(...middleware: Middleware.Class[]) {
  return (target: any, propertyKey?: string | symbol, descriptor?: PropertyDescriptor | any) => {
    if (typeof propertyKey === 'object' && propertyKey && 'kind' in propertyKey) {
      const context = propertyKey as any;
      const propertyName = context.name;
      const existingMiddleware =
        Reflect.getMetadata(INNGEST_MIDDLEWARE_METADATA, target, propertyName) || [];

      Reflect.defineMetadata(
        INNGEST_MIDDLEWARE_METADATA,
        [...existingMiddleware, ...middleware],
        target,
        propertyName,
      );

      return target;
    }

    if (!propertyKey) {
      throw new Error('PropertyKey is required for legacy decorator');
    }

    const existingMiddleware =
      Reflect.getMetadata(INNGEST_MIDDLEWARE_METADATA, target, propertyKey) || [];

    Reflect.defineMetadata(
      INNGEST_MIDDLEWARE_METADATA,
      [...existingMiddleware, ...middleware],
      target,
      propertyKey,
    );

    return descriptor;
  };
}

/**
 * Decorator to set concurrency limits for an Inngest function
 */
export function Concurrency(limit: number, options?: Omit<InngestConcurrencyOption, 'limit'>): any;
export function Concurrency(option: InngestConcurrencyOption): any;
export function Concurrency(options: InngestConcurrencyOption[]): any;
export function Concurrency(
  limitOrOptions: number | InngestConcurrencyOption | InngestConcurrencyOption[],
  options?: Omit<InngestConcurrencyOption, 'limit'>,
): any {
  return createMetadataDecorator('Concurrency', (metadata) => {
    if (typeof limitOrOptions === 'number') {
      metadata.concurrency = options ? { limit: limitOrOptions, ...options } : limitOrOptions;
      return;
    }

    if (Array.isArray(limitOrOptions)) {
      metadata.concurrency = appendMetadataArray(
        Array.isArray(metadata.concurrency) ? metadata.concurrency : undefined,
        limitOrOptions,
      );
      return;
    }

    metadata.concurrency = appendMetadataArray(
      Array.isArray(metadata.concurrency) ? metadata.concurrency : undefined,
      limitOrOptions,
    );
  });
}

/**
 * Decorator to set rate limiting for an Inngest function
 */
export function RateLimit(limit: number, period: string, key?: string): any {
  return createMetadataDecorator('RateLimit', (metadata) => {
    metadata.rateLimit = { limit, period, key };
  });
}

/**
 * Decorator to set throttling for an Inngest function
 */
export function Throttle(
  limit: number,
  period: string,
  options?: {
    key?: string;
    burst?: number;
  },
): any {
  return createMetadataDecorator('Throttle', (metadata) => {
    metadata.throttle = { limit, period, ...options };
  });
}

/**
 * Decorator to set debounce configuration for an Inngest function
 */
export function Debounce(period: string, key?: string, timeout?: string): any;
export function Debounce(period: string, key?: string, timeout?: string): any {
  return createMetadataDecorator('Debounce', (metadata) => {
    metadata.debounce = { period, key, timeout };
  });
}

/**
 * Decorator to set retry configuration for an Inngest function
 */
export function Retries(count: InngestRetryCount): any {
  return createMetadataDecorator('Retries', (metadata) => {
    metadata.retries = count;
  });
}

export function BatchEvents(
  maxSize: number,
  timeout: string,
  options?: Omit<InngestBatchEventsConfig, 'maxSize' | 'timeout'>,
): any {
  return createMetadataDecorator('BatchEvents', (metadata) => {
    metadata.batchEvents = { maxSize, timeout, ...options };
  });
}

export function CancelOn(
  ruleOrRules: InngestCancellationRule | InngestCancellationRule[],
): any {
  return createMetadataDecorator('CancelOn', (metadata) => {
    metadata.cancelOn = appendMetadataArray(metadata.cancelOn, ruleOrRules);
  });
}

export function Singleton(
  modeOrConfig: InngestSingletonConfig['mode'] | InngestSingletonConfig,
  key?: string,
): any {
  return createMetadataDecorator('Singleton', (metadata) => {
    metadata.singleton =
      typeof modeOrConfig === 'string' ? { mode: modeOrConfig, key } : modeOrConfig;
  });
}

export function Priority(runOrConfig: string | InngestPriorityConfig): any {
  return createMetadataDecorator('Priority', (metadata) => {
    metadata.priority = typeof runOrConfig === 'string' ? { run: runOrConfig } : runOrConfig;
  });
}

export function Idempotency(key: string): any {
  return createMetadataDecorator('Idempotency', (metadata) => {
    metadata.idempotency = key;
  });
}

export function Timeouts(config: InngestTimeoutsConfig): any {
  return createMetadataDecorator('Timeouts', (metadata) => {
    metadata.timeouts = config;
  });
}

export function OptimizeParallelism(enabled: boolean = true): any {
  return createMetadataDecorator('OptimizeParallelism', (metadata) => {
    metadata.optimizeParallelism = enabled;
  });
}

export function Checkpointing(
  config: boolean | InngestCheckpointingConfig = true,
): any {
  return createMetadataDecorator('Checkpointing', (metadata) => {
    metadata.checkpointing = config;
  });
}

export function OnFailure(methodName: string | symbol): any {
  return createMetadataDecorator('OnFailure', (metadata) => {
    metadata.onFailureMethod = methodName;
  });
}
