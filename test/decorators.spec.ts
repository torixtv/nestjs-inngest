import 'reflect-metadata';
import {
  InngestFunction,
  InngestCron,
  InngestEvent,
  UseMiddleware,
  Concurrency,
  RateLimit,
  BatchEvents,
  Debounce,
} from '../src/decorators';
import { INNGEST_FUNCTION_METADATA } from '../src/constants';

describe('Decorators', () => {
  describe('@InngestFunction', () => {
    it('should set function metadata', () => {
      class TestService {
        @InngestFunction({
          id: 'test-function',
          triggers: [{ event: 'test.event' }],
        })
        async handleEvent(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleEvent',
      );

      expect(metadata).toBeDefined();
      expect(metadata.config.id).toBe('test-function');
      expect(metadata.config.triggers).toEqual([{ event: 'test.event' }]);
    });
  });

  describe('@InngestCron', () => {
    it('should create a cron-triggered function', () => {
      class TestService {
        @InngestCron('scheduled-task', '0 0 * * *')
        async scheduledTask(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'scheduledTask',
      );

      expect(metadata).toBeDefined();
      expect(metadata.config.id).toBe('scheduled-task');
      expect(metadata.config.triggers).toEqual([{ cron: '0 0 * * *' }]);
    });
  });

  describe('@InngestEvent', () => {
    it('should create an event-triggered function', () => {
      class TestService {
        @InngestEvent('event-handler', 'user.created')
        async handleUserCreated(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleUserCreated',
      );

      expect(metadata).toBeDefined();
      expect(metadata.config.id).toBe('event-handler');
      expect(metadata.config.triggers).toEqual([{ event: 'user.created' }]);
    });

    it('should handle complex event triggers', () => {
      class TestService {
        @InngestEvent('conditional-handler', {
          event: 'user.created',
          if: 'event.data.verified == true',
        })
        async handleVerifiedUser(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleVerifiedUser',
      );

      expect(metadata).toBeDefined();
      expect(metadata.config.triggers).toEqual([
        {
          event: 'user.created',
          if: 'event.data.verified == true',
        },
      ]);
    });

    it('should support multiple event triggers', () => {
      class TestService {
        @InngestEvent('multi-handler', ['user.created', 'user.updated'])
        async handleMultipleUsers(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleMultipleUsers',
      );

      expect(metadata.config.triggers).toEqual([
        { event: 'user.created' },
        { event: 'user.updated' },
      ]);
    });
  });

  // Tests for @OnEvent and @Cron removed - these decorators have been deprecated
  // Use @InngestEvent and @InngestCron instead

  describe('Configuration Decorators', () => {
    it('should apply concurrency settings', () => {
      class TestService {
        @InngestFunction({
          id: 'concurrent-function',
          triggers: [{ event: 'test.event' }],
        })
        @Concurrency(5)
        async handleConcurrent(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleConcurrent',
      );

      expect(metadata.concurrency).toBe(5);
    });

    it('should apply rate limiting', () => {
      class TestService {
        @InngestFunction({
          id: 'rate-limited-function',
          triggers: [{ event: 'test.event' }],
        })
        @RateLimit(10, '1m')
        async handleRateLimited(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleRateLimited',
      );

      expect(metadata.rateLimit).toEqual({
        limit: 10,
        period: '1m',
      });
    });

    it('should apply multiple concurrency rules', () => {
      class TestService {
        @InngestFunction({
          id: 'multi-concurrency',
          triggers: [{ event: 'test.event' }],
        })
        @Concurrency([
          { limit: 2, key: 'event.data.accountId' },
          { limit: 5, scope: 'env' },
        ])
        async handleConcurrent(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleConcurrent',
      );

      expect(metadata.concurrency).toEqual([
        { limit: 2, key: 'event.data.accountId' },
        { limit: 5, scope: 'env' },
      ]);
    });

    it('should apply a single concurrency rule object', () => {
      class TestService {
        @InngestFunction({
          id: 'object-concurrency',
          triggers: [{ event: 'test.event' }],
        })
        @Concurrency({ limit: 3, key: 'event.data.accountId' })
        async handleConcurrent(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleConcurrent',
      );

      expect(metadata.concurrency).toEqual([
        { limit: 3, key: 'event.data.accountId' },
      ]);
    });

    it('should apply debounce timeout and batch event options', () => {
      class TestService {
        @InngestFunction({
          id: 'batched-function',
          triggers: [{ event: 'test.event' }],
        })
        @Debounce('1m', 'event.data.id', '10m')
        @BatchEvents(10, '5m', { key: 'event.data.accountId', if: 'event.data.enabled == true' })
        async handleBatched(context: any) {
          return { success: true };
        }
      }

      const metadata = Reflect.getMetadata(
        INNGEST_FUNCTION_METADATA,
        TestService.prototype,
        'handleBatched',
      );

      expect(metadata.debounce).toEqual({
        period: '1m',
        key: 'event.data.id',
        timeout: '10m',
      });
      expect(metadata.batchEvents).toEqual({
        maxSize: 10,
        timeout: '5m',
        key: 'event.data.accountId',
        if: 'event.data.enabled == true',
      });
    });
  });
});
