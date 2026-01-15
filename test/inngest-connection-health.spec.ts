import { Test, TestingModule } from '@nestjs/testing';
import { InngestService } from '../src/services/inngest.service';
import { INNGEST_MODULE_OPTIONS } from '../src/constants';
import { WebSocketReadyState } from '../src/interfaces';

describe('InngestService.getConnectionHealth()', () => {
  let service: InngestService;

  describe('serve mode', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InngestService,
          {
            provide: INNGEST_MODULE_OPTIONS,
            useValue: { id: 'test-app', mode: 'serve' },
          },
        ],
      }).compile();

      service = module.get<InngestService>(InngestService);
    });

    it('should return healthy for serve mode', () => {
      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.sdkState).toBe('NOT_APPLICABLE');
      expect(health.usingInternalCheck).toBe(false);
    });
  });

  describe('connect mode', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InngestService,
          {
            provide: INNGEST_MODULE_OPTIONS,
            useValue: { id: 'test-app', mode: 'connect' },
          },
        ],
      }).compile();

      service = module.get<InngestService>(InngestService);
    });

    it('should return unhealthy when no workerConnection exists', () => {
      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.sdkState).toBe('CLOSED');
    });

    it('should return unhealthy when currentConnection is null', () => {
      // Mock workerConnection with null currentConnection
      (service as any).workerConnection = {
        state: 'ACTIVE',
        get connectionId() {
          throw new Error('No connection');
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.reason).toContain('currentConnection is null');
      expect(health.usingInternalCheck).toBe(true);
    });

    it('should return unhealthy when WebSocket is CLOSED', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.CLOSED },
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.wsReadyState).toBe(WebSocketReadyState.CLOSED);
      expect(health.wsStateName).toBe('CLOSED');
      expect(health.reason).toContain('CLOSED');
    });

    it('should return unhealthy when WebSocket is CONNECTING', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.CONNECTING },
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.wsReadyState).toBe(WebSocketReadyState.CONNECTING);
      expect(health.wsStateName).toBe('CONNECTING');
    });

    it('should return unhealthy when pendingHeartbeats >= 2', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.OPEN },
          pendingHeartbeats: 2,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.pendingHeartbeats).toBe(2);
      expect(health.reason).toContain('Heartbeat failure');
    });

    it('should return unhealthy when SDK state is not ACTIVE', () => {
      (service as any).workerConnection = {
        state: 'RECONNECTING',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.OPEN },
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.sdkState).toBe('RECONNECTING');
      expect(health.reason).toContain('RECONNECTING');
    });

    it('should return healthy when all checks pass', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.OPEN },
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.wsReadyState).toBe(WebSocketReadyState.OPEN);
      expect(health.wsStateName).toBe('OPEN');
      expect(health.usingInternalCheck).toBe(true);
      expect(health.connectionId).toBe('test-conn-id');
    });

    it('should return healthy when pendingHeartbeats is 1 (normal operation)', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: { readyState: WebSocketReadyState.OPEN },
          pendingHeartbeats: 1,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.pendingHeartbeats).toBe(1);
    });

    it('should fallback when wsReadyState is undefined', () => {
      (service as any).workerConnection = {
        state: 'ACTIVE',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: {}, // no readyState
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(true); // ACTIVE state means healthy in fallback
      expect(health.usingInternalCheck).toBe(false);
      expect(health.reason).toContain('not accessible');
    });

    it('should fallback unhealthy when wsReadyState is undefined and state is not ACTIVE', () => {
      (service as any).workerConnection = {
        state: 'RECONNECTING',
        connectionId: 'test-conn-id',
        currentConnection: {
          id: 'test-conn-id',
          ws: {}, // no readyState
          pendingHeartbeats: 0,
        },
      };

      const health = service.getConnectionHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.usingInternalCheck).toBe(false);
      expect(health.reason).toContain('RECONNECTING');
    });

    it('should log warning only once on repeated fallbacks from exceptions', () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      // Mock to throw error on internal access
      (service as any).workerConnection = {
        state: 'ACTIVE',
        get connectionId() {
          throw new Error('Test error');
        },
        get currentConnection() {
          throw new Error('Test error');
        },
      };

      // Call multiple times
      service.getConnectionHealth();
      service.getConnectionHealth();
      service.getConnectionHealth();

      // Should only log once
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to access SDK internals for health check, falling back to state-only',
        expect.objectContaining({ error: 'Test error' }),
      );
    });
  });
});
