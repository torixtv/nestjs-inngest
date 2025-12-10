import { Test } from '@nestjs/testing';
import {
  createEvent,
  createBatchEvents,
  isEventPayload,
  isEventPayloadArray,
} from '../src/utils';
import {
  createInngestTestingModule,
  MockInngestService,
  createMockInngestContext,
} from '../src/testing';

describe('Utils', () => {
  describe('createEvent', () => {
    it('should create a typed event payload', () => {
      const event = createEvent('user.created', { userId: '123', email: 'test@example.com' });

      expect(event).toEqual({
        name: 'user.created',
        data: { userId: '123', email: 'test@example.com' },
        ts: expect.any(Number),
      });
    });

    it('should include optional fields', () => {
      const event = createEvent(
        'user.updated',
        { userId: '456' },
        {
          id: 'custom-id',
          user: { id: '789' },
        },
      );

      expect(event).toEqual({
        name: 'user.updated',
        data: { userId: '456' },
        id: 'custom-id',
        user: { id: '789' },
        ts: expect.any(Number),
      });
    });
  });

  describe('createBatchEvents', () => {
    it('should create a batch of events', () => {
      const event1 = createEvent('event.one', { data: 1 });
      const event2 = createEvent('event.two', { data: 2 });

      const batch = createBatchEvents(event1, event2);

      expect(batch).toHaveLength(2);
      expect(batch[0]).toEqual(event1);
      expect(batch[1]).toEqual(event2);
    });
  });

  describe('isEventPayload', () => {
    it('should return true for valid event payload', () => {
      const event = {
        name: 'test.event',
        data: { test: true },
        ts: Date.now(),
      };

      expect(isEventPayload(event)).toBe(true);
    });

    it('should return false for invalid event payload', () => {
      expect(isEventPayload(null)).toBe(false);
      expect(isEventPayload({})).toBe(false);
      expect(isEventPayload({ name: 'test' })).toBe(false);
      expect(isEventPayload({ data: {} })).toBe(false);
    });
  });

  describe('isEventPayloadArray', () => {
    it('should return true for array of valid event payloads', () => {
      const events = [
        { name: 'event1', data: {}, ts: Date.now() },
        { name: 'event2', data: {}, ts: Date.now() },
      ];

      expect(isEventPayloadArray(events)).toBe(true);
    });

    it('should return false for invalid arrays', () => {
      expect(isEventPayloadArray(null)).toBe(false);
      expect(isEventPayloadArray([])).toBe(true); // Empty array is valid
      expect(isEventPayloadArray([{ name: 'test' }])).toBe(false);
      expect(isEventPayloadArray(['not-an-event'])).toBe(false);
    });
  });

  describe('createInngestTestingModule', () => {
    it('should create a testing module with Inngest', async () => {
      const module = await createInngestTestingModule({
        id: 'test-app',
        eventKey: 'test-key',
      });

      expect(module).toBeDefined();

      await module.close();
    });

    it('should include additional providers', async () => {
      class TestProvider {
        getValue() {
          return 'test-value';
        }
      }

      const module = await createInngestTestingModule(
        {
          id: 'test-app',
          eventKey: 'test-key',
        },
        [TestProvider],
      );

      const provider = module.get<TestProvider>(TestProvider);
      expect(provider).toBeDefined();
      expect(provider.getValue()).toBe('test-value');

      await module.close();
    });
  });

  describe('MockInngestService', () => {
    let mockService: MockInngestService;

    beforeEach(() => {
      mockService = new MockInngestService();
    });

    it('should track sent events', async () => {
      const event = { name: 'test.event', data: { test: true } };

      const result = await mockService.send(event);

      expect(result).toEqual({ ids: ['mock-event-id'] });
      expect(mockService.getEvents()).toContain(event);
    });

    it('should track registered functions', () => {
      const mockFunction = { id: 'test-function', name: 'Test' };

      mockService.registerFunction(mockFunction);

      expect(mockService.getFunctions()).toContain(mockFunction);
    });

    it('should clear events', async () => {
      await mockService.send({ name: 'test', data: {} });
      expect(mockService.getEvents()).toHaveLength(1);

      mockService.clearEvents();
      expect(mockService.getEvents()).toHaveLength(0);
    });

    it('should provide step tools', () => {
      const stepTools = mockService.createStepTools();

      expect(stepTools.run).toBeDefined();
      expect(stepTools.sleep).toBeDefined();
      expect(stepTools.sleepUntil).toBeDefined();
      expect(stepTools.waitForEvent).toBeDefined();
      expect(stepTools.sendEvent).toBeDefined();
    });
  });

  describe('createMockInngestContext', () => {
    it('should create a mock context', () => {
      const context = createMockInngestContext();

      expect(context).toEqual({
        event: {
          name: 'test.event',
          data: { test: true },
          id: 'test-event-id',
          ts: expect.any(Number),
        },
        step: {
          run: expect.any(Function),
          sleep: expect.any(Function),
          sleepUntil: expect.any(Function),
          waitForEvent: expect.any(Function),
          sendEvent: expect.any(Function),
        },
        ctx: {
          env: 'test',
          functionId: 'test-function',
          runId: 'test-run-id',
          attempt: 0,
        },
      });
    });

    it('should accept overrides', () => {
      const context = createMockInngestContext({
        event: { name: 'custom.event', data: { custom: true } },
      });

      expect(context.event.name).toBe('custom.event');
      expect(context.event.data).toEqual({ custom: true });
    });
  });
});