import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InngestService } from '../src';
import {
  CONNECT_DECORATOR_TEST_APP_ID,
  bootstrapConnectDecoratorTestApp,
  parseFunctionConfig,
  resetDecoratorState,
  waitForConnectHealth,
  waitForDecoratorState,
  waitForRegisteredFunctionsForApp,
} from './e2e/decorator-verification.helpers';

describe('Decorator Connect Mode (e2e)', () => {
  let app: INestApplication;
  let registeredFunctions: Array<Record<string, any>>;

  beforeAll(async () => {
    app = await bootstrapConnectDecoratorTestApp();

    await waitForConnectHealth(
      app,
      (health) => health.isHealthy && health.sdkState === 'ACTIVE',
    );

    const functions = await waitForRegisteredFunctionsForApp(CONNECT_DECORATOR_TEST_APP_ID, [
      'Decorator Verification Multi Trigger',
      'Decorator Verification Concurrency',
      'Decorator Verification Concurrency Object',
      'Decorator Verification Failure Source',
      'Decorator Verification Failure Source (failure)',
    ]);

    registeredFunctions = functions.map((candidate) => ({
      ...candidate,
      config: parseFunctionConfig(candidate),
    }));
  });

  afterAll(async () => {
    await app.get(InngestService).onApplicationShutdown('test');
    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  beforeEach(async () => {
    await resetDecoratorState(app);
  });

  function findRegisteredFunction(name: string) {
    const functionRecord = registeredFunctions.find((candidate) => candidate.name === name);
    if (!functionRecord) {
      throw new Error(
        `Function "${name}" was not found in the connect registration payload: ${registeredFunctions
          .map((candidate) => candidate.name)
          .join(', ')}`,
      );
    }

    return functionRecord.config;
  }

  it('establishes an active worker connection', () => {
    const service = app.get(InngestService);

    expect(service.getConnectionState()).toBe('ACTIVE');
    expect(service.isConnected()).toBe(true);
  });

  it('registers decorator verification functions using websocket runtimes', () => {
    const multiTrigger = findRegisteredFunction('Decorator Verification Multi Trigger');
    const concurrency = findRegisteredFunction('Decorator Verification Concurrency');
    const concurrencyObject = findRegisteredFunction('Decorator Verification Concurrency Object');

    expect(multiTrigger.steps[0].uri).toContain('wss://connect/');
    expect(concurrency.steps[0].uri).toContain('wss://connect/');
    expect(concurrencyObject.steps[0].uri).toContain('wss://connect/');
    expect(multiTrigger.triggers).toEqual([
      { event: 'decorator.verify.multi.a' },
      { event: 'decorator.verify.multi.b' },
    ]);
    expect(concurrency.concurrency.map((rule: any) => rule.limit)).toEqual([1, 2]);
    expect(concurrencyObject.concurrency).toEqual([
      {
        limit: 3,
        key: 'event.data.accountId',
        scope: 'Fn',
        hash: expect.any(String),
      },
    ]);
  });

  it('executes multi-trigger functions over the connect worker', async () => {
    await request(app.getHttpServer())
      .post('/api/test/decorators/multi-trigger')
      .send({ variant: 'a' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/test/decorators/multi-trigger')
      .send({ variant: 'b' })
      .expect(201);

    const state = await waitForDecoratorState(
      app,
      (current) => {
        const names = new Set(current.multiTriggerExecutions.map((entry: any) => entry.eventName));
        return names.has('decorator.verify.multi.a') && names.has('decorator.verify.multi.b');
      },
    );

    const eventNames = new Set(state.multiTriggerExecutions.map((entry: any) => entry.eventName));
    expect(eventNames.has('decorator.verify.multi.a')).toBe(true);
    expect(eventNames.has('decorator.verify.multi.b')).toBe(true);
  });

  it('invokes the configured @OnFailure handler over the connect worker', async () => {
    await request(app.getHttpServer())
      .post('/api/test/decorators/failure')
      .send({ message: 'Connect failure handler should execute' })
      .expect(201);

    const state = await waitForDecoratorState(
      app,
      (current) => current.counts.failureHandlerExecutions >= 1,
      30000,
    );

    expect(state.counts.failureHandlerExecutions).toBeGreaterThanOrEqual(1);
  });
});
