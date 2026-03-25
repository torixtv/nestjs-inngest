import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  bootstrapDecoratorTestApp,
  resetDecoratorState,
  waitForDecoratorState,
  waitForRegisteredFunctions,
} from './e2e/decorator-verification.helpers';

describe('Decorator Runtime Wiring (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapDecoratorTestApp();
    await waitForRegisteredFunctions([
      'Decorator Verification Multi Trigger',
      'Decorator Verification Failure Source',
      'Decorator Verification Failure Source (failure)',
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDecoratorState(app);
  });

  it('executes the same function for both registered triggers', async () => {
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
      (current) => current.counts.multiTriggerExecutions === 2,
    );

    expect(state.multiTriggerExecutions.map((entry: any) => entry.eventName).sort()).toEqual([
      'decorator.verify.multi.a',
      'decorator.verify.multi.b',
    ]);
  });

  it('invokes the configured @OnFailure handler', async () => {
    await request(app.getHttpServer())
      .post('/api/test/decorators/failure')
      .send({ message: 'Failure handler should execute' })
      .expect(201);

    const state = await waitForDecoratorState(
      app,
      (current) => current.counts.failureHandlerExecutions >= 1,
      30000,
    );

    expect(state.counts.failureHandlerExecutions).toBeGreaterThanOrEqual(1);
  });
});
