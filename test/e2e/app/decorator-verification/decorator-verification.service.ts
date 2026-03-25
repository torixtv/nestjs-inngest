import { Injectable, Logger } from '@nestjs/common';
import {
  BatchEvents,
  CancelOn,
  Checkpointing,
  Concurrency,
  Debounce,
  Idempotency,
  InngestEvent,
  InngestFunction,
  OnFailure,
  OptimizeParallelism,
  Priority,
  RateLimit,
  Retries,
  Singleton,
  Throttle,
  Timeouts,
} from '../../../../src';
import { DecoratorStateService } from './decorator-state.service';

@Injectable()
export class DecoratorVerificationService {
  private readonly logger = new Logger(DecoratorVerificationService.name);

  constructor(private readonly state: DecoratorStateService) {}

  @InngestEvent(
    'decorator-verification-multi-trigger',
    ['decorator.verify.multi.a', 'decorator.verify.multi.b'],
    { name: 'Decorator Verification Multi Trigger' },
  )
  async handleMultiTrigger({ event, step }: any) {
    return step.run('record-multi-trigger', () => {
      const eventName = String(event?.name || 'unknown');
      this.logger.log(`Recording multi-trigger execution for ${eventName}`);
      this.state.recordMultiTrigger(eventName);
      return { eventName };
    });
  }

  @InngestFunction({
    id: 'decorator-verification-concurrency',
    name: 'Decorator Verification Concurrency',
    triggers: { event: 'decorator.verify.concurrency' },
  })
  @Concurrency([
    { limit: 1, key: 'event.data.accountId' },
    { limit: 2, key: 'event.data.userId' },
  ])
  async handleConcurrencyConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-concurrency-object',
    name: 'Decorator Verification Concurrency Object',
    triggers: { event: 'decorator.verify.concurrency-object' },
  })
  @Concurrency({ limit: 3, key: 'event.data.accountId' })
  async handleConcurrencyObjectConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-batch',
    name: 'Decorator Verification Batch',
    triggers: { event: 'decorator.verify.batch' },
  })
  @BatchEvents(25, '30s', {
    key: 'event.data.accountId',
    if: 'event.data.enabled == true',
  })
  async handleBatchConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-options',
    name: 'Decorator Verification Options',
    triggers: { event: 'decorator.verify.options' },
  })
  @Debounce('5s', 'event.data.accountId', '2m')
  @Throttle(10, '1m', { key: 'event.data.accountId', burst: 3 })
  @Retries(4)
  @Priority('event.data.priority')
  @Timeouts({ start: '10s', finish: '2h' })
  async handleOptionsConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-control',
    name: 'Decorator Verification Control',
    triggers: { event: 'decorator.verify.control' },
  })
  @Singleton({ mode: 'cancel', key: 'event.data.accountId' })
  @CancelOn([
    { event: 'decorator.verify.cancel.primary', match: 'data.accountId' },
    { event: 'decorator.verify.cancel.secondary', match: 'data.accountId', timeout: '10m' },
  ])
  async handleControlConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-rate-limit',
    name: 'Decorator Verification Rate Limit',
    triggers: { event: 'decorator.verify.rate-limit' },
  })
  @RateLimit(50, '1m', 'event.data.accountId')
  async handleRateLimitConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-idempotency',
    name: 'Decorator Verification Idempotency',
    triggers: { event: 'decorator.verify.idempotency' },
  })
  @Idempotency('event.data.requestId')
  async handleIdempotencyConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-execution-tuning',
    name: 'Decorator Verification Execution Tuning',
    triggers: { event: 'decorator.verify.execution-tuning' },
  })
  @OptimizeParallelism(true)
  @Checkpointing({ maxRuntime: '1h', bufferedSteps: 10, maxInterval: '5m' })
  async handleExecutionTuningConfig() {
    return { registered: true };
  }

  @InngestFunction({
    id: 'decorator-verification-failure-source',
    name: 'Decorator Verification Failure Source',
    triggers: { event: 'decorator.verify.failure' },
  })
  @Retries(0)
  @OnFailure('handleFailure')
  async handleFailureSource({ event, step }: any) {
    return step.run('fail-intentionally', () => {
      throw new Error(String(event?.data?.message || 'Decorator verification failure'));
    });
  }

  async handleFailure({ event, step }: any) {
    return step.run('record-failure-handler', () => {
      const errorMessage = String(event?.data?.error?.message || 'unknown');
      const eventName = String(event?.name || 'unknown');
      this.logger.log(`Recording failure handler execution for ${eventName}`);
      this.state.recordFailureHandler(eventName, errorMessage);
      return { eventName, errorMessage };
    });
  }
}
