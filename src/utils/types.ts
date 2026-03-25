import { EventPayload } from 'inngest';

/**
 * @deprecated Inngest v4 no longer exposes centralized client event maps.
 */
export type ExtractEvents<T = never> = never;

/**
 * Helper type for function return values
 */
export type InngestReturn<T = void> = T | Promise<T>;

/**
 * Helper type for step function return values
 */
export type StepReturn<T = void> = T | Promise<T>;

/**
 * Type guard to check if a value is an event payload
 */
export function isEventPayload(value: any): value is EventPayload {
  return typeof value === 'object' && value !== null && 'name' in value && 'data' in value;
}

/**
 * Type guard to check if a value is an array of event payloads
 */
export function isEventPayloadArray(value: any): value is EventPayload[] {
  return Array.isArray(value) && value.every(isEventPayload);
}

/**
 * Standard user context interface for Inngest events
 * Follows Inngest best practices for user attribution
 */
export interface UserContext {
  /** Unique user identifier */
  id: string;
  /** User email address */
  email?: string;
  /** User display name */
  name?: string;
  /** User role or permission level */
  role?: string;
  /** Any additional user metadata */
  [key: string]: any;
}

/**
 * Helper to create typed event payloads with proper user context
 */
export function createEvent<TName extends string, TData = any>(
  name: TName,
  data: TData,
  options?: {
    id?: string;
    ts?: number;
    user?: UserContext;
  },
): EventPayload {
  return {
    name,
    data,
    id: options?.id,
    ts: options?.ts ?? Date.now(),
    user: options?.user,
  } as EventPayload;
}

/**
 * Helper to create events with user context from common patterns
 */
export function createUserEvent<TName extends string, TData = any>(
  name: TName,
  data: TData,
  userContext: {
    userId: string;
    email?: string;
    name?: string;
    role?: string;
  },
  options?: {
    id?: string;
    ts?: number;
  },
): EventPayload {
  return createEvent(name, data, {
    ...options,
    user: {
      id: userContext.userId,
      email: userContext.email,
      name: userContext.name,
      role: userContext.role,
    },
  });
}

/**
 * Helper to create typed batch events
 */
export function createBatchEvents<TEvents extends EventPayload[]>(...events: TEvents): TEvents {
  return events;
}
