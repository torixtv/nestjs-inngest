import { Context, EventPayload, GetStepTools, Handler, InngestFunction as InngestFunctionType, Middleware } from 'inngest';

export type InngestTrigger = InngestFunctionType.Trigger<string>;
export type InngestTriggerInput = InngestTrigger | InngestTrigger[];
export type InngestRetryCount =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20;

export interface InngestConcurrencyOption {
  limit: number;
  key?: string;
  scope?: 'fn' | 'env' | 'account';
}

export interface InngestBatchEventsConfig {
  maxSize: number;
  timeout: string;
  key?: string;
  if?: string;
}

export interface InngestRateLimitConfig {
  limit: number;
  period: string;
  key?: string;
}

export interface InngestThrottleConfig {
  limit: number;
  period: string;
  key?: string;
  burst?: number;
}

export interface InngestDebounceConfig {
  period: string;
  key?: string;
  timeout?: string;
}

export interface InngestPriorityConfig {
  run?: string;
}

export interface InngestTimeoutsConfig {
  start?: string;
  finish?: string;
}

export interface InngestSingletonConfig {
  mode: 'skip' | 'cancel';
  key?: string;
}

export interface InngestCancellationRule {
  event: string;
  match?: string;
  if?: string;
  timeout?: string;
}

export interface InngestCheckpointingConfig {
  maxRuntime?: string;
  bufferedSteps?: number;
  maxInterval?: string;
}

export interface InngestFunctionConfig<TTriggers extends InngestTriggerInput | undefined = InngestTriggerInput> {
  /**
   * Optional function ID override (defaults to class method name)
   */
  id?: string;

  /**
   * Function name for display
   */
  name?: string;

  /**
   * Function description shown in Inngest
   */
  description?: string;

  /**
   * Trigger configuration
   */
  triggers?: TTriggers;

  /**
   * Concurrency configuration
   */
  concurrency?: number | InngestConcurrencyOption | InngestConcurrencyOption[];

  /**
   * Batch events configuration
   */
  batchEvents?: InngestBatchEventsConfig;

  /**
   * Idempotency key expression
   */
  idempotency?: string;

  /**
   * Rate limiting configuration
   */
  rateLimit?: InngestRateLimitConfig;

  /**
   * Throttling configuration
   */
  throttle?: InngestThrottleConfig;

  /**
   * Debounce configuration
   */
  debounce?: InngestDebounceConfig;

  /**
   * Priority configuration
   */
  priority?: InngestPriorityConfig;

  /**
   * Function timeout configuration
   */
  timeouts?: InngestTimeoutsConfig;

  /**
   * Singleton configuration
   */
  singleton?: InngestSingletonConfig;

  /**
   * Cancel on configuration
   */
  cancelOn?: InngestCancellationRule[];

  /**
   * Retry configuration
   */
  retries?: InngestRetryCount;

  /**
   * Failure handler function
   */
  onFailure?: Handler.Any;

  /**
   * Middleware classes to apply to the function
   */
  middleware?: Middleware.Class[];

  /**
   * Optimize parallel promise execution
   */
  optimizeParallelism?: boolean;

  /**
   * Checkpointing configuration
   */
  checkpointing?: boolean | InngestCheckpointingConfig;
}

export interface InngestStepConfig {
  /**
   * Step ID
   */
  id: string;

  /**
   * Step name for display
   */
  name?: string;

  /**
   * Retry configuration for this step
   */
  retries?: InngestRetryCount;
}

export interface InngestHandlerContext<TTriggers extends InngestTriggerInput | undefined = InngestTriggerInput> {
  event: EventPayload | any;
  step: GetStepTools<any>;
  ctx: Context;
}

export interface InngestFunctionHandler<
  TTriggers extends InngestTriggerInput | undefined = InngestTriggerInput,
  TOutput = any,
> {
  (context: InngestHandlerContext<TTriggers>): Promise<TOutput> | TOutput;
}

export interface InngestFunctionMetadata {
  target: any;
  propertyKey: string | symbol;
  config: InngestFunctionConfig;
  retries?: InngestRetryCount;
  concurrency?: number | InngestConcurrencyOption | InngestConcurrencyOption[];
  batchEvents?: InngestBatchEventsConfig;
  idempotency?: string;
  rateLimit?: InngestRateLimitConfig;
  throttle?: InngestThrottleConfig;
  debounce?: InngestDebounceConfig;
  priority?: InngestPriorityConfig;
  timeouts?: InngestTimeoutsConfig;
  singleton?: InngestSingletonConfig;
  cancelOn?: InngestCancellationRule[];
  onFailureMethod?: string | symbol;
  optimizeParallelism?: boolean;
  checkpointing?: boolean | InngestCheckpointingConfig;
}
