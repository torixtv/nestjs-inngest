import { Test, TestingModule } from '@nestjs/testing';
import { InngestService } from '../src/services/inngest.service';
import { InngestModule } from '../src/module/inngest.module';
import { INNGEST_MODULE_OPTIONS } from '../src/constants';

describe('InngestService', () => {
  let service: InngestService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        InngestService,
        {
          provide: INNGEST_MODULE_OPTIONS,
          useValue: {
            id: 'test-app',
            eventKey: 'test-key',
            baseUrl: 'http://localhost:8288',
          },
        },
      ],
    }).compile();

    service = module.get<InngestService>(InngestService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getClient', () => {
    it('should return an Inngest client', () => {
      const client = service.getClient();
      expect(client).toBeDefined();
      expect(client.id).toBe('test-app');
    });
  });

  describe('createFunction', () => {
    it('should create and register a function', () => {
      const fn = service.createFunction(
        {
          id: 'test-function',
          trigger: { event: 'test.event' },
        },
        async ({ event, step }: { event: any; step: any }) => {
          return { success: true };
        },
      );

      expect(fn).toBeDefined();
      expect(typeof fn.id).toBe('function'); // In Inngest v3, id is a function
      expect(fn.id('test-app')).toBe('test-app-test-function');
      expect(service.getFunctions()).toContain(fn);
    });
  });

  describe('createScheduledFunction', () => {
    it('should create a scheduled function', () => {
      const fn = service.createScheduledFunction(
        {
          id: 'scheduled-function',
          cron: '0 0 * * *',
        },
        async ({ event, step }: { event: any; step: any }) => {
          return { success: true };
        },
      );

      expect(fn).toBeDefined();
      expect(typeof fn.id).toBe('function'); // In Inngest v3, id is a function
      expect(fn.id('test-app')).toBe('test-app-scheduled-function');
      expect(service.getFunctions()).toContain(fn);
    });
  });

  describe('registerFunction', () => {
    it('should register a function', () => {
      const mockFunction = {
        id: 'mock-function',
        name: 'Mock Function',
      } as any;

      service.registerFunction(mockFunction);
      expect(service.getFunctions()).toContain(mockFunction);
    });
  });

  describe('send', () => {
    it('should send an event', async () => {
      const mockSend = jest.fn().mockResolvedValue({ ids: ['event-123'] });
      const client = service.getClient();
      client.send = mockSend;

      const result = await service.send({
        name: 'test.event',
        data: { test: true },
      });

      expect(mockSend).toHaveBeenCalledWith({
        name: 'test.event',
        data: { test: true },
      });
      expect(result).toEqual({ ids: ['event-123'] });
    });

    it('should handle send errors', async () => {
      const mockSend = jest.fn().mockRejectedValue(new Error('Send failed'));
      const client = service.getClient();
      client.send = mockSend;

      await expect(
        service.send({
          name: 'test.event',
          data: { test: true },
        }),
      ).rejects.toThrow('Send failed');
    });
  });

  describe('createStepTools', () => {
    it('should create step tools for testing', async () => {
      const stepTools = service.createStepTools();

      expect(stepTools).toBeDefined();
      expect(stepTools.run).toBeDefined();
      expect(stepTools.sleep).toBeDefined();
      expect(stepTools.sleepUntil).toBeDefined();
      expect(stepTools.waitForEvent).toBeDefined();
      expect(stepTools.sendEvent).toBeDefined();

      // Test step.run
      const result = await stepTools.run('test-step', () => 'test-result');
      expect(result).toBe('test-result');

      // Test step.waitForEvent
      const eventResult = await stepTools.waitForEvent('wait-step', {});
      expect(eventResult).toBeNull();
    });
  });

  describe('buildConnectConfig', () => {
    it('should map maxConcurrency to maxWorkerConcurrency for the SDK', () => {
      const connectConfig = (service as any).buildConnectConfig({
        instanceId: 'worker-1',
        maxConcurrency: 4,
      });

      expect(connectConfig).toMatchObject({
        instanceId: 'worker-1',
        maxWorkerConcurrency: 4,
        apps: [{ client: service.getClient(), functions: [] }],
      });
    });

    it('should forward isolateExecution to the SDK connect config', () => {
      const connectConfig = (service as any).buildConnectConfig({
        maxWorkerConcurrency: 2,
        isolateExecution: true,
      });

      expect(connectConfig).toMatchObject({
        maxWorkerConcurrency: 2,
        isolateExecution: true,
      });
    });

    it('should reject rewriteGatewayEndpoint when isolateExecution is enabled', () => {
      expect(() =>
        (service as any).buildConnectConfig({
          isolateExecution: true,
          rewriteGatewayEndpoint: (url: string) => url,
        }),
      ).toThrow(
        'connect.rewriteGatewayEndpoint is not supported when connect.isolateExecution is enabled',
      );
    });
  });
});
