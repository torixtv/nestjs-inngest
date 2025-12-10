import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { TerminusModule, HealthIndicatorService } from '@nestjs/terminus';
import { InngestModule } from '../src/module/inngest.module';
import { InngestHealthIndicator } from '../src/health/inngest-health.indicator';
import { InngestService } from '../src/services/inngest.service';

describe('InngestHealthIndicator', () => {
  describe('with serve mode', () => {
    let module: TestingModule;
    let healthIndicator: InngestHealthIndicator;
    let inngestService: InngestService;

    beforeEach(async () => {
      // Create module with InngestModule and TerminusModule
      module = await Test.createTestingModule({
        imports: [
          InngestModule.forRoot({
            id: 'health-test-app',
            mode: 'serve',
            isGlobal: true,
          }),
          TerminusModule,
        ],
      }).compile();

      // Get services from the module
      inngestService = module.get<InngestService>(InngestService);
      const healthIndicatorService = module.get<HealthIndicatorService>(
        HealthIndicatorService,
      );

      // Manually create InngestHealthIndicator with correct dependencies
      healthIndicator = new InngestHealthIndicator(
        inngestService,
        healthIndicatorService,
      );
    });

    afterEach(async () => {
      await module.close();
    });

    it('should have InngestService available in module', () => {
      expect(inngestService).toBeDefined();
      expect(inngestService.getClient()).toBeDefined();
    });

    it('should return healthy when client is initialized in serve mode', async () => {
      const result = await healthIndicator.isHealthy('inngest');

      expect(result).toHaveProperty('inngest');
      expect(result.inngest.status).toBe('up');
      expect(result.inngest.mode).toBe('serve');
    });

    it('should return ready when client is initialized in serve mode', async () => {
      const result = await healthIndicator.isReady('inngest');

      expect(result).toHaveProperty('inngest');
      expect(result.inngest.status).toBe('up');
      expect(result.inngest.mode).toBe('serve');
    });
  });

  describe('with connect mode', () => {
    let module: TestingModule;
    let healthIndicator: InngestHealthIndicator;
    let inngestService: InngestService;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          InngestModule.forRoot({
            id: 'health-test-connect-app',
            mode: 'connect',
            isGlobal: true,
            disableAutoRegistration: true, // Don't actually connect
          }),
          TerminusModule,
        ],
      }).compile();

      // Get services from the module
      inngestService = module.get<InngestService>(InngestService);
      const healthIndicatorService = module.get<HealthIndicatorService>(
        HealthIndicatorService,
      );

      // Manually create InngestHealthIndicator with correct dependencies
      healthIndicator = new InngestHealthIndicator(
        inngestService,
        healthIndicatorService,
      );
    });

    afterEach(async () => {
      await module.close();
    });

    it('should return unhealthy when connection is not active', async () => {
      const result = await healthIndicator.isHealthy('inngest');

      expect(result).toHaveProperty('inngest');
      expect(result.inngest.status).toBe('down');
      expect(result.inngest.mode).toBe('connect');
      expect(result.inngest.connectionState).toBe('CLOSED');
    });

    it('should return not ready when connection is not active', async () => {
      const result = await healthIndicator.isReady('inngest');

      expect(result).toHaveProperty('inngest');
      expect(result.inngest.status).toBe('down');
      expect(result.inngest.mode).toBe('connect');
      expect(result.inngest.connectionState).toBe('CLOSED');
    });

    it('should report connection state in health check', async () => {
      const state = inngestService.getConnectionState();
      expect(state).toBe('CLOSED');

      const result = await healthIndicator.isHealthy('inngest');
      expect(result.inngest.connectionState).toBe('CLOSED');
    });
  });

  describe('without InngestService', () => {
    let module: TestingModule;
    let healthIndicator: InngestHealthIndicator;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [TerminusModule],
      }).compile();

      const healthIndicatorService = module.get<HealthIndicatorService>(
        HealthIndicatorService,
      );

      // Create InngestHealthIndicator without InngestService (undefined)
      healthIndicator = new InngestHealthIndicator(
        undefined,
        healthIndicatorService,
      );
    });

    afterEach(async () => {
      await module.close();
    });

    it('should return down when InngestService is not available', async () => {
      const result = await healthIndicator.isHealthy('inngest');

      expect(result).toHaveProperty('inngest');
      expect(result.inngest.status).toBe('down');
      expect(result.inngest.message).toBe('InngestService not available');
    });
  });
});
