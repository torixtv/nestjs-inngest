import { EventType } from 'inngest';
import { INNGEST_FUNCTION_METADATA, INNGEST_HANDLER_METADATA } from '../constants';
import { InngestFunctionConfig, InngestFunctionMetadata, InngestTrigger } from '../interfaces';

type EventTriggerInput =
  | string
  | EventType<string, any>
  | { event: string | EventType<string, any>; if?: string };

function normalizeEventTrigger(trigger: EventTriggerInput): InngestTrigger {
  if (typeof trigger === 'string' || trigger instanceof EventType) {
    return { event: trigger };
  }

  return {
    event: trigger.event,
    ...(trigger.if !== undefined && { if: trigger.if }),
  };
}

/**
 * Decorator to mark a method as an Inngest function
 * @param config - Configuration for the Inngest function
 */
export function InngestFunction(config: InngestFunctionConfig): any {
  return (target: any, propertyKey?: string | symbol, descriptor?: PropertyDescriptor | any) => {
    // Handle both legacy and modern decorator signatures
    if (typeof propertyKey === 'object' && propertyKey && 'kind' in propertyKey) {
      // Modern decorator (stage 3)
      const context = propertyKey as any;
      const propertyName = context.name;
      const existingMetadata =
        Reflect.getMetadata(INNGEST_FUNCTION_METADATA, target, propertyName) || {};

      const metadata: InngestFunctionMetadata = {
        ...existingMetadata,
        target,
        propertyKey: propertyName,
        config: {
          ...(existingMetadata.config || {}),
          ...config,
        },
      };

      Reflect.defineMetadata(INNGEST_FUNCTION_METADATA, metadata, target, propertyName);
      Reflect.defineMetadata(INNGEST_HANDLER_METADATA, { useContext: true }, target, propertyName);

      return target;
    } else {
      // Legacy decorator
      if (!propertyKey) {
        throw new Error('PropertyKey is required for legacy decorator');
      }

      // Check if there's existing metadata from middleware decorators
      const existingMetadata =
        Reflect.getMetadata(INNGEST_FUNCTION_METADATA, target, propertyKey) || {};

      const metadata: InngestFunctionMetadata = {
        ...existingMetadata,
        target,
        propertyKey,
        config: {
          ...(existingMetadata.config || {}),
          ...config,
        },
      };

      Reflect.defineMetadata(INNGEST_FUNCTION_METADATA, metadata, target, propertyKey);

      // Mark as using context object by default
      Reflect.defineMetadata(INNGEST_HANDLER_METADATA, { useContext: true }, target, propertyKey);

      return descriptor;
    }
  };
}

/**
 * Decorator to mark a method as an Inngest scheduled function
 * @param id - Function ID
 * @param cron - Cron expression for scheduling
 * @param options - Additional function options
 */
export function InngestCron(
  id: string,
  cron: string,
  options?: Omit<InngestFunctionConfig, 'id' | 'triggers'>,
): any {
  return InngestFunction({
    id,
    triggers: [{ cron }],
    ...options,
  });
}

/**
 * Decorator to mark a method as an Inngest event-triggered function
 * @param id - Function ID
 * @param event - Event name or event configuration
 * @param options - Additional function options
 */
export function InngestEvent(
  id: string,
  event: EventTriggerInput | EventTriggerInput[],
  options?: Omit<InngestFunctionConfig, 'id' | 'triggers'>,
): any {
  const triggers = (Array.isArray(event) ? event : [event]).map(normalizeEventTrigger);

  return InngestFunction({
    id,
    triggers,
    ...options,
  });
}
