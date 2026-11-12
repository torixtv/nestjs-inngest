import { Test, TestingModule } from '@nestjs/testing';
import { InngestModule } from '../module/inngest.module';
import { InngestService } from '../services/inngest.service';
import { InngestModuleOptions } from '../interfaces';

/**
 * Helper to create a testing module with Inngest
 */
export async function createInngestTestingModule(
  options: InngestModuleOptions,
  additionalProviders: any[] = [],
): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [InngestModule.forRoot(options)],
    providers: additionalProviders,
  }).compile();

  return module;
}

/**
 * Mock Inngest service for testing
 */
export class MockInngestService {
  private events: any[] = [];
  private functions: any[] = [];

  async send(event: any) {
    this.events.push(event);
    return { ids: ['mock-event-id'] };
  }

  registerFunction(fn: any) {
    this.functions.push(fn);
  }

  getFunctions() {
    return this.functions;
  }

  getEvents() {
    return this.events;
  }

  clearEvents() {
    this.events = [];
  }

  createStepTools() {
    return {
      run: jest.fn(async (id: string, fn: () => any) => fn()),
      sleep: jest.fn(async () => {}),
      sleepUntil: jest.fn(async () => {}),
      waitForEvent: jest.fn(async () => null),
      sendEvent: jest.fn(async (id: string, events: any) => this.send(events)),
    };
  }
}

/**
 * Create a mock Inngest context for testing
 */
export function createMockInngestContext(overrides?: Partial<any>) {
  // The wrapper hands a handler the same attempt at the top level and on ctx,
  // so overriding either one sets both. Two different values describe a run
  // Inngest never produces, and a retry test would then pass or fail on
  // whichever field the handler reads; refuse it instead of picking one.
  const topAttempt = overrides?.attempt;
  const ctxAttempt = overrides?.ctx?.attempt;
  if (topAttempt !== undefined && ctxAttempt !== undefined && topAttempt !== ctxAttempt) {
    throw new Error(
      `createMockInngestContext: attempt (${topAttempt}) and ctx.attempt (${ctxAttempt}) differ; set one of them`,
    );
  }
  const attempt = topAttempt ?? ctxAttempt ?? 0;
  const ctx = overrides?.ctx ?? {
    env: 'test',
    functionId: 'test-function',
    runId: 'test-run-id',
  };

  return {
    event: {
      name: 'test.event',
      data: { test: true },
      id: 'test-event-id',
      ts: Date.now(),
    },
    step: {
      run: jest.fn(async (id: string, fn: () => any) => fn()),
      sleep: jest.fn(async () => {}),
      sleepUntil: jest.fn(async () => {}),
      waitForEvent: jest.fn(async () => null),
      sendEvent: jest.fn(async () => {}),
    },
    ...overrides,
    ctx: { ...ctx, attempt },
    attempt,
  };
}
