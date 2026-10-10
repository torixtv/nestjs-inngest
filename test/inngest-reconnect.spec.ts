import { Test, TestingModule } from '@nestjs/testing';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { InngestService } from '../src/services/inngest.service';
import { InngestHealthIndicator } from '../src/health/inngest-health.indicator';
import { INNGEST_MODULE_OPTIONS } from '../src/constants';

const mockConnect = jest.fn();

jest.mock('inngest/connect', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  ConnectionState: {
    CONNECTING: 'CONNECTING',
    ACTIVE: 'ACTIVE',
    PAUSED: 'PAUSED',
    RECONNECTING: 'RECONNECTING',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED',
  },
}));

function fakeConnection(id: string, opts: { hangOnClose?: boolean } = {}) {
  const terminate = jest.fn().mockResolvedValue(0);
  return {
    id,
    state: 'ACTIVE',
    connectionId: id,
    closed: Promise.resolve(),
    close: jest.fn(() =>
      opts.hangOnClose ? new Promise<void>(() => undefined) : Promise.resolve(),
    ),
    getDebugState: jest.fn(() => ({ lastHeartbeatReceivedAt: Date.now() })),
    strategy: { worker: { terminate } },
    terminate,
  };
}

describe('InngestService reconnect + watchdog wiring (connect mode)', () => {
  let module: TestingModule;
  let service: InngestService;
  let indicator: InngestHealthIndicator;

  async function build(connectOptions: Record<string, unknown> = {}) {
    module = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [
        InngestService,
        {
          provide: INNGEST_MODULE_OPTIONS,
          useValue: {
            id: 'reconnect-test-app',
            mode: 'connect',
            disableAutoRegistration: true,
            connect: { shutdownTimeout: 50, ...connectOptions },
          },
        },
      ],
    }).compile();
    service = module.get(InngestService);
    indicator = new InngestHealthIndicator(service, module.get(HealthIndicatorService));
  }

  afterEach(async () => {
    await module?.close();
    mockConnect.mockReset();
  });

  it('starts the watchdog on first connect and exposes its status in health details', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();

    const status = service.getWatchdogStatus();
    expect(status).toMatchObject({ enabled: true, transportHealthy: true, live: true });

    const health = await indicator.isHealthy('inngest');
    expect(health.inngest.status).toBe('up');
    expect(health.inngest.watchdog).toMatchObject({ live: true, reconnectAttempts: 0 });

    const live = await indicator.isLive('inngest');
    expect(live.inngest.status).toBe('up');
  });

  it('does not start the watchdog when disabled', async () => {
    await build({ watchdog: { enabled: false } });
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();
    expect(service.getWatchdogStatus()).toBeNull();
    const live = await indicator.isLive('inngest');
    expect(live.inngest.status).toBe('up');
  });

  it('reconnect() closes the old connection and opens a new one', async () => {
    await build();
    const first = fakeConnection('c1');
    const second = fakeConnection('c2');
    mockConnect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await service.establishConnection();
    await service.reconnect('test');

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(service.getConnectionState()).toBe('ACTIVE');
    expect((service as any).workerConnection).toBe(second);
  });

  it('terminates a wedged worker thread whose close() never resolves, then reconnects', async () => {
    await build();
    const wedged = fakeConnection('c1', { hangOnClose: true });
    const fresh = fakeConnection('c2');
    mockConnect.mockResolvedValueOnce(wedged).mockResolvedValueOnce(fresh);

    await service.establishConnection();
    await service.reconnect('frozen');

    expect(wedged.terminate).toHaveBeenCalledTimes(1);
    expect((service as any).workerConnection).toBe(fresh);
  });

  it('concurrent reconnect() calls share a single attempt', async () => {
    await build();
    mockConnect
      .mockResolvedValueOnce(fakeConnection('c1'))
      .mockResolvedValueOnce(fakeConnection('c2'));
    await service.establishConnection();

    await Promise.all([service.reconnect('a'), service.reconnect('b')]);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('skips reconnect while the initial connect() is still pending', async () => {
    await build();
    let resolveConnect: (c: unknown) => void = () => undefined;
    mockConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const pending = service.establishConnection();
    // let the dynamic import + connect() call happen
    await new Promise((r) => setImmediate(r));
    expect(service.getWatchdogStatus()).not.toBeNull();

    await service.reconnect('impatient');
    expect(mockConnect).toHaveBeenCalledTimes(1);

    resolveConnect(fakeConnection('c1'));
    await pending;
    expect(service.getConnectionState()).toBe('ACTIVE');
  });

  it('isLive goes down only when the watchdog reports a long transport failure', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();

    jest.spyOn(service, 'getWatchdogStatus').mockReturnValue({
      enabled: true,
      transportHealthy: false,
      unhealthyReason: 'SDK state is RECONNECTING',
      unhealthySince: Date.now() - 700_000,
      unhealthyForMs: 700_000,
      live: false,
      lastExecutionAt: null,
      msSinceLastExecution: null,
      idle: false,
      reconnectAttempts: 2,
      lastReconnectAt: Date.now() - 100_000,
      lastReconnectError: null,
    });

    const live = await indicator.isLive('inngest');
    expect(live.inngest.status).toBe('down');
    expect(live.inngest.message).toMatch(/unhealthy for 700s: SDK state is RECONNECTING/);
  });

  it('recordExecution() feeds the watchdog', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();
    service.recordExecution();
    expect(service.getWatchdogStatus()?.msSinceLastExecution).toBeLessThan(1000);
  });

  it('shutdown during an in-flight reconnect closes the connection it opens', async () => {
    await build();
    const first = fakeConnection('c1');
    const second = fakeConnection('c2');
    let resolveSecond: (c: unknown) => void = () => undefined;
    mockConnect.mockResolvedValueOnce(first).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    await service.establishConnection();

    const reconnecting = service.reconnect('test');
    await new Promise((r) => setImmediate(r));
    const shutdown = service.onApplicationShutdown('SIGTERM');
    resolveSecond(second);
    await Promise.all([reconnecting, shutdown]);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect((service as any).workerConnection).toBeNull();
  });

  it('stops the watchdog on shutdown', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();
    const watchdog = (service as any).watchdog;
    const stop = jest.spyOn(watchdog, 'stop');
    await service.onApplicationShutdown('SIGTERM');
    expect(stop).toHaveBeenCalled();
  });
});
