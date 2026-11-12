import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InngestExplorer } from '../src/services/inngest.explorer';
import { InngestService } from '../src/services/inngest.service';
import { InngestFunction } from '../src/decorators';
import { INNGEST_MODULE_OPTIONS } from '../src/constants';
import { InngestMonitoringService } from '../src/monitoring';
import { InngestHandlerContext } from '../src/interfaces';

/**
 * What a handler registered through the real wrapper receives. Handlers read
 * `attempt` to pick retry delays and to tell a retry from a first run, so it
 * must arrive with the value Inngest sent, not `undefined`.
 */
describe('InngestExplorer: the handler context', () => {
  let module: TestingModule;
  let inngestService: InngestService;
  const received: InngestHandlerContext[] = [];

  class AttemptService {
    @InngestFunction({ id: 'attempt-function', triggers: [{ event: 'attempt.event' }] })
    async handle(context: InngestHandlerContext) {
      received.push(context);
      return { ok: true };
    }
  }

  beforeEach(async () => {
    received.length = 0;
    module = await Test.createTestingModule({
      providers: [
        InngestExplorer,
        InngestService,
        MetadataScanner,
        {
          provide: InngestMonitoringService,
          useValue: { registerFunction: jest.fn(), recordFunctionExecution: jest.fn() },
        },
        { provide: INNGEST_MODULE_OPTIONS, useValue: { id: 'test-app', eventKey: 'test-key' } },
        {
          provide: DiscoveryService,
          useValue: {
            getProviders: jest.fn(() => [
              { instance: new AttemptService(), name: 'AttemptService' },
            ]),
            getControllers: jest.fn(() => []),
          },
        },
      ],
    }).compile();
    await module.get(InngestExplorer).onModuleInit();
    inngestService = module.get(InngestService);
  });

  afterEach(async () => {
    await module.close();
  });

  /** Calls the registered function with the context shape Inngest passes it. */
  async function invoke(attempt: number) {
    const fn: any = inngestService.getFunctions()[0];
    const event = { name: 'attempt.event', data: { id: 1 } };
    const step = { run: jest.fn() };
    await fn.fn({
      event,
      events: [event],
      step,
      runId: 'run-1',
      attempt,
      logger: { info: jest.fn() },
      // A property added by middleware (transformInput) sits at the top level too.
      tenant: 'torix',
    });
    return { event, step, context: received[0] };
  }

  it.each([0, 3])('passes attempt %i at the top level', async (attempt) => {
    const { context } = await invoke(attempt);
    expect(context.attempt).toBe(attempt);
  });

  it('passes attempt and runId on ctx too, as the declared Context type promises', async () => {
    const { context } = await invoke(2);
    expect(context.ctx.attempt).toBe(2);
    expect(context.ctx.runId).toBe('run-1');
  });

  it('keeps middleware properties on ctx and the event and step tools off it', async () => {
    const { event, step, context } = await invoke(0);
    expect(context.event).toBe(event);
    expect(context.step).toBe(step);
    expect((context.ctx as any).tenant).toBe('torix');
    expect(context.ctx).not.toHaveProperty('step');
    expect(context.ctx).not.toHaveProperty('event');
    expect(context.ctx).not.toHaveProperty('events');
  });
});
