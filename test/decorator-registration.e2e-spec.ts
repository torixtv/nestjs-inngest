import { INestApplication } from '@nestjs/common';
import {
  bootstrapDecoratorTestApp,
  fetchDecoratorSdkConfig,
  parseFunctionConfig,
  waitForRegisteredFunctions,
} from './e2e/decorator-verification.helpers';

describe('Decorator Registration (e2e)', () => {
  let app: INestApplication;
  let registeredFunctions: Array<Record<string, any>>;
  let sdkFunctions: Array<Record<string, any>>;

  beforeAll(async () => {
    app = await bootstrapDecoratorTestApp();
    const functions = await waitForRegisteredFunctions([
      'Decorator Verification Multi Trigger',
      'Decorator Verification Concurrency',
      'Decorator Verification Concurrency Object',
      'Decorator Verification Batch',
      'Decorator Verification Options',
      'Decorator Verification Control',
      'Decorator Verification Rate Limit',
      'Decorator Verification Idempotency',
      'Decorator Verification Execution Tuning',
      'Decorator Verification Failure Source',
      'Decorator Verification Failure Source (failure)',
    ]);
    registeredFunctions = functions.map((candidate) => ({
      ...candidate,
      config: parseFunctionConfig(candidate as any),
    }));
    sdkFunctions = (await fetchDecoratorSdkConfig(app)).functions;
  });

  afterAll(async () => {
    await app.close();
  });

  function findRegisteredFunction(name: string) {
    const functionRecord = registeredFunctions.find((candidate) => candidate.name === name);
    if (!functionRecord) {
      throw new Error(
        `Function "${name}" was not found in the dev server registration payload: ${registeredFunctions
          .map((candidate) => candidate.name)
          .join(', ')}`,
      );
    }
    return functionRecord.config;
  }

  function findSdkFunction(name: string) {
    const functionRecord = sdkFunctions.find((candidate) => candidate.name === name);
    if (!functionRecord) {
      throw new Error(
        `Function "${name}" was not found in the local SDK snapshot: ${sdkFunctions
          .map((candidate) => candidate.name)
          .join(', ')}`,
      );
    }
    return functionRecord;
  }

  it('registers both triggers for @InngestEvent arrays', () => {
    const config = findRegisteredFunction('Decorator Verification Multi Trigger');

    expect(config.triggers).toEqual([
      { event: 'decorator.verify.multi.a' },
      { event: 'decorator.verify.multi.b' },
    ]);
  });

  it('registers both concurrency rules', () => {
    const config = findRegisteredFunction('Decorator Verification Concurrency');

    expect(Array.isArray(config.concurrency)).toBe(true);
    expect(config.concurrency).toHaveLength(2);
    expect(config.concurrency.map((rule: any) => rule.limit)).toEqual([1, 2]);
  });

  it('registers the single-rule concurrency object overload', () => {
    const config = findRegisteredFunction('Decorator Verification Concurrency Object');

    expect(config.concurrency).toEqual([
      {
        limit: 3,
        key: 'event.data.accountId',
        scope: 'Fn',
        hash: expect.any(String),
      },
    ]);
  });

  it('registers batch options including key and condition', () => {
    const config = findRegisteredFunction('Decorator Verification Batch');

    expect(config.batchEvents).toEqual({
      maxSize: 25,
      timeout: '30s',
      key: 'event.data.accountId',
      if: 'event.data.enabled == true',
    });
  });

  it('registers the expanded decorator-first options', () => {
    const config = findRegisteredFunction('Decorator Verification Options');

    expect(config.debounce).toEqual({
      period: '5s',
      key: 'event.data.accountId',
      timeout: '2m',
    });
    expect(config.throttle).toEqual({
      limit: 10,
      period: '1m',
      key: 'event.data.accountId',
      burst: 3,
    });
    expect(config.steps[0].retries).toBe(4);
    expect(config.priority).toEqual({ run: 'event.data.priority' });
    expect(config.timeouts).toEqual({
      start: '10s',
      finish: '2h',
    });
  });

  it('registers a dedicated rate-limit decorator configuration', () => {
    const config = findRegisteredFunction('Decorator Verification Rate Limit');

    expect(config.rateLimit).toEqual({
      limit: 50,
      period: '1m',
      key: 'event.data.accountId',
    });
  });

  it('registers the idempotency decorator in the dev server payload', () => {
    const config = findRegisteredFunction('Decorator Verification Idempotency');

    expect(config.rateLimit).toEqual({
      limit: 1,
      period: '24h0m0s',
      key: 'event.data.requestId',
    });
  });

  it('passes SDK-only execution tuning options into the created function', () => {
    const executionTuning = findSdkFunction('Decorator Verification Execution Tuning');
    const idempotency = findSdkFunction('Decorator Verification Idempotency');

    expect(idempotency.opts.idempotency).toBe('event.data.requestId');
    expect(executionTuning.opts.optimizeParallelism).toBe(true);
    expect(executionTuning.computed.optimizeParallelism).toBe(true);
    expect(executionTuning.opts.checkpointing).toEqual({
      maxRuntime: '1h',
      bufferedSteps: 10,
      maxInterval: '5m',
    });
    expect(executionTuning.computed.checkpointing).toEqual({
      maxRuntime: '1h',
      bufferedSteps: 10,
      maxInterval: '5m',
    });
  });

  it('registers singleton and multiple cancel rules', () => {
    const config = findRegisteredFunction('Decorator Verification Control');

    expect(config.singleton).toEqual({
      mode: 'cancel',
      key: 'event.data.accountId',
    });
    expect(config.cancel).toEqual([
      {
        event: 'decorator.verify.cancel.primary',
        if: 'event.data.accountId == async.data.accountId',
      },
      {
        event: 'decorator.verify.cancel.secondary',
        if: 'event.data.accountId == async.data.accountId',
        timeout: '10m',
      },
    ]);
  });

  it('registers the @OnFailure handler relationship', () => {
    const failureSource = findRegisteredFunction('Decorator Verification Failure Source');
    const failureHandler = findRegisteredFunction('Decorator Verification Failure Source (failure)');

    expect(failureSource.id).not.toBe(failureHandler.id);
    expect(failureHandler.triggers).toEqual([
      {
        event: 'inngest/function.failed',
        expression:
          "event.data.function_id == 'nestjs-integration-test-v4-decorator-verification-failure-source'",
      },
    ]);
  });
});
