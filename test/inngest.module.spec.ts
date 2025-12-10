import { Test, TestingModule } from '@nestjs/testing';
import { InngestModule } from '../src/module/inngest.module';
import { InngestService } from '../src/services/inngest.service';
import { InngestModuleOptions, InngestOptionsFactory } from '../src/interfaces';
import { Injectable } from '@nestjs/common';

describe('InngestModule', () => {
  describe('forRoot', () => {
    it('should create a module with options', async () => {
      const options: InngestModuleOptions = {
        id: 'test-app',
        eventKey: 'test-key',
        isGlobal: true,
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();
      
      // Should include merged defaults for test environment
      const mergedOptions = service.getOptions();
      expect(mergedOptions.id).toBe(options.id);
      expect(mergedOptions.eventKey).toBe(options.eventKey);
      expect(mergedOptions.isGlobal).toBe(options.isGlobal);
      // Should have defaults merged in
      expect(mergedOptions.environment).toBe('test');
      expect(mergedOptions.path).toBe('/api/inngest');
      expect(mergedOptions.baseUrl).toBe('http://localhost:8288');

      await module.close();
    });

    it('should create a non-global module by default', async () => {
      const options: InngestModuleOptions = {
        id: 'test-app',
        eventKey: 'test-key',
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();

      await module.close();
    });
  });

  describe('forRootAsync', () => {
    it('should create a module with useFactory', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          InngestModule.forRootAsync({
            useFactory: () => ({
              id: 'async-app',
              eventKey: 'async-key',
            }),
          }),
        ],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();
      expect(service.getOptions().id).toBe('async-app');

      await module.close();
    });

    it('should create a module with useClass', async () => {
      @Injectable()
      class ConfigService implements InngestOptionsFactory {
        createInngestOptions(): InngestModuleOptions {
          return {
            id: 'class-app',
            eventKey: 'class-key',
          };
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          InngestModule.forRootAsync({
            useClass: ConfigService,
          }),
        ],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();
      expect(service.getOptions().id).toBe('class-app');

      await module.close();
    });

    it('should create a module with useExisting', async () => {
      @Injectable()
      class ConfigService implements InngestOptionsFactory {
        createInngestOptions(): InngestModuleOptions {
          return {
            id: 'existing-app',
            eventKey: 'existing-key',
          };
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        providers: [ConfigService],
        imports: [
          InngestModule.forRootAsync({
            useExisting: ConfigService,
            imports: [
              {
                module: class TestConfigModule {},
                providers: [ConfigService],
                exports: [ConfigService],
              }
            ],
          }),
        ],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();
      expect(service.getOptions().id).toBe('existing-app');

      await module.close();
    });

    it('should support async factory', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          InngestModule.forRootAsync({
            useFactory: async () => {
              await new Promise(resolve => setTimeout(resolve, 10));
              return {
                id: 'async-factory-app',
                eventKey: 'async-factory-key',
              };
            },
          }),
        ],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();
      expect(service.getOptions().id).toBe('async-factory-app');

      await module.close();
    });
  });

  describe('forFeature', () => {
    it('should create a feature module', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          InngestModule.forRoot({
            id: 'root-app',
            eventKey: 'root-key',
          }),
          InngestModule.forFeature(),
        ],
      }).compile();

      expect(module).toBeDefined();
      await module.close();
    });
  });

  describe('connect mode', () => {
    it('should configure module with connect mode', async () => {
      const options: InngestModuleOptions = {
        id: 'connect-app',
        mode: 'connect',
        connect: {
          instanceId: 'test-worker-1',
          maxConcurrency: 5,
          shutdownTimeout: 60000,
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service).toBeDefined();

      const mergedOptions = service.getOptions();
      expect(mergedOptions.mode).toBe('connect');
      expect(mergedOptions.connect?.instanceId).toBe('test-worker-1');
      expect(mergedOptions.connect?.maxConcurrency).toBe(5);
      expect(mergedOptions.connect?.shutdownTimeout).toBe(60000);

      await module.close();
    });

    it('should default to serve mode when mode is not specified', async () => {
      const options: InngestModuleOptions = {
        id: 'default-mode-app',
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      const mergedOptions = service.getOptions();

      expect(mergedOptions.mode).toBe('serve');

      await module.close();
    });

    it('should return NOT_APPLICABLE for connection state in serve mode', async () => {
      const options: InngestModuleOptions = {
        id: 'serve-mode-app',
        mode: 'serve',
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service.getConnectionState()).toBe('NOT_APPLICABLE');
      expect(service.isConnected()).toBe(false);

      await module.close();
    });

    it('should return CLOSED for connection state in connect mode before connection', async () => {
      const options: InngestModuleOptions = {
        id: 'connect-mode-app',
        mode: 'connect',
        disableAutoRegistration: true, // Prevent auto-connection
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      expect(service.getConnectionState()).toBe('CLOSED');
      expect(service.isConnected()).toBe(false);

      await module.close();
    });

    it('should configure connect mode with handleShutdownSignals array', async () => {
      const options: InngestModuleOptions = {
        id: 'signals-app',
        mode: 'connect',
        connect: {
          handleShutdownSignals: ['SIGTERM'], // Only handle SIGTERM
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      const mergedOptions = service.getOptions();

      expect(mergedOptions.connect?.handleShutdownSignals).toEqual(['SIGTERM']);

      await module.close();
    });

    it('should configure connect mode with empty handleShutdownSignals to disable auto signal handling', async () => {
      const options: InngestModuleOptions = {
        id: 'no-signals-app',
        mode: 'connect',
        connect: {
          handleShutdownSignals: [], // Disable automatic signal handling
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [InngestModule.forRoot(options)],
      }).compile();

      const service = module.get<InngestService>(InngestService);
      const mergedOptions = service.getOptions();

      expect(mergedOptions.connect?.handleShutdownSignals).toEqual([]);

      await module.close();
    });
  });
});