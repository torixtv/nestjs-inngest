import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InngestExplorer } from '../src/services/inngest.explorer';
import { InngestService } from '../src/services/inngest.service';
import { InngestFunction } from '../src/decorators';
import { INNGEST_MODULE_OPTIONS } from '../src/constants';
import { InngestMonitoringService } from '../src/monitoring';

describe('InngestExplorer', () => {
  let explorer: InngestExplorer;
  let inngestService: InngestService;
  let module: TestingModule;

  // Test service with decorated methods
  class TestService {
    @InngestFunction({
      id: 'test-function',
      triggers: [{ event: 'test.event' }],
    })
    async handleTestEvent(context: { event: any; step: any; ctx: any }) {
      return { success: true, data: context.event.data };
    }

    @InngestFunction({
      id: 'another-function',
      triggers: [{ cron: '0 0 * * *' }],
    })
    async handleScheduled(context: { event: any; step: any; ctx: any }) {
      return { scheduled: true };
    }

    // Method without decorator should be ignored
    async regularMethod() {
      return { regular: true };
    }
  }

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        InngestExplorer,
        InngestService,
        TestService,
        MetadataScanner,
        {
          provide: InngestMonitoringService,
          useValue: {
            registerFunction: jest.fn(),
            recordFunctionExecution: jest.fn(),
          },
        },
        {
          provide: INNGEST_MODULE_OPTIONS,
          useValue: {
            id: 'test-app',
            eventKey: 'test-key',
          },
        },
        {
          provide: DiscoveryService,
          useValue: {
            getProviders: jest.fn(() => [
              {
                instance: new TestService(),
                name: 'TestService',
              },
            ]),
            getControllers: jest.fn(() => []),
          },
        },
      ],
    }).compile();

    explorer = module.get<InngestExplorer>(InngestExplorer);
    inngestService = module.get<InngestService>(InngestService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(explorer).toBeDefined();
  });

  it('should discover and register functions on module init', async () => {
    const registerFunctionSpy = jest.spyOn(inngestService, 'registerFunction');

    await explorer.onModuleInit();

    // Should register the two decorated functions
    expect(registerFunctionSpy).toHaveBeenCalledTimes(2);

    const functions = inngestService.getFunctions();
    expect(functions).toHaveLength(2);

    const functionIds = functions.map(fn => fn.id('test-app'));
    expect(functionIds).toContain('test-app-test-function');
    expect(functionIds).toContain('test-app-another-function');
  });

  it('should not register methods without decorators', async () => {
    await explorer.onModuleInit();

    const functions = inngestService.getFunctions();
    const functionIds = functions.map(fn => fn.id);

    // regularMethod should not be registered
    expect(functionIds).not.toContain('regularMethod');
    expect(functionIds).not.toContain('TestService.regularMethod');
  });

  it('should bind function handlers to their instances', async () => {
    await explorer.onModuleInit();

    const functions = inngestService.getFunctions();
    const testFunction = functions.find(fn => (typeof fn.id === 'function' ? fn.id() : fn.id) === 'test-function');

    expect(testFunction).toBeDefined();

    // Mock the function handler execution
    const mockEvent = { name: 'test.event', data: { test: true } };
    const mockStep = { run: jest.fn() };
    const mockCtx = { runId: 'test-run' };

    // This would normally be called by Inngest
    // We're testing that the handler is properly bound
    const result = await (testFunction as any).fn({
      event: mockEvent,
      step: mockStep,
      ctx: mockCtx,
    });

    expect(result).toEqual({ success: true, data: { test: true } });
  });
});
