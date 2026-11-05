import { Test, TestingModule } from '@nestjs/testing';
import { InngestService } from '../src/services/inngest.service';
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

  async function build(connectOptions: Record<string, unknown> = {}) {
    module = await Test.createTestingModule({
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
  }

  afterEach(async () => {
    await module?.close();
    mockConnect.mockReset();
  });

  it('starts the watchdog on first connect', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();

    expect(service.getWatchdogStatus()).toMatchObject({
      enabled: true,
      transportHealthy: true,
      reconnectAttempts: 0,
    });
  });

  it('does not start the watchdog when disabled', async () => {
    await build({ watchdog: { enabled: false } });
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();
    expect(service.getWatchdogStatus()).toBeNull();
  });

  it('reconnect() closes the old connection and opens a new one', async () => {
    await build();
    const first = fakeConnection('c1');
    const second = fakeConnection('c2');
    mockConnect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await service.establishConnection();
    await expect(service.reconnect('test')).resolves.toBe(true);

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

  it('logs an error when a wedged connection has no worker thread to terminate', async () => {
    await build();
    const wedged = { ...fakeConnection('c1', { hangOnClose: true }), strategy: {} };
    mockConnect.mockResolvedValueOnce(wedged).mockResolvedValueOnce(fakeConnection('c2'));
    const error = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await service.establishConnection();
    await service.reconnect('frozen');

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Could not terminate the previous Inngest connection'),
    );
  });

  it('tells the watchdog about each new connection', async () => {
    await build();
    mockConnect
      .mockResolvedValueOnce(fakeConnection('c1'))
      .mockResolvedValueOnce(fakeConnection('c2'));
    await service.establishConnection();
    const replaced = jest.spyOn((service as any).watchdog, 'onConnectionReplaced');
    await service.reconnect('test');
    expect(replaced).toHaveBeenCalledTimes(1);
  });

  it('recovers when the first connect() threw: reconnect() opens a connection', async () => {
    await build();
    mockConnect
      .mockRejectedValueOnce(new Error('gateway unreachable'))
      .mockResolvedValueOnce(fakeConnection('c1'));

    await expect(service.establishConnection()).rejects.toThrow('gateway unreachable');
    expect(service.getConnectionState()).toBe('CLOSED');
    expect(service.getWatchdogStatus()).not.toBeNull(); // started before connect()

    await expect(service.reconnect('no worker connection')).resolves.toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(service.getConnectionState()).toBe('ACTIVE');
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

  it('reports CONNECTING and skips reconnect while the initial connect() is still pending', async () => {
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
    expect(service.getConnectionState()).toBe('CONNECTING');

    await expect(service.reconnect('impatient')).resolves.toBe(false);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    resolveConnect(fakeConnection('c1'));
    await pending;
    expect(service.getConnectionState()).toBe('ACTIVE');
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

  it('closes a connection that completes after shutdown already finished waiting', async () => {
    await build(); // shutdownTimeout 50ms
    const first = fakeConnection('c1');
    const late = fakeConnection('c2');
    let resolveLate: (c: unknown) => void = () => undefined;
    mockConnect.mockResolvedValueOnce(first).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );
    await service.establishConnection();

    const reconnecting = service.reconnect('test');
    await new Promise((r) => setImmediate(r));
    await service.onApplicationShutdown('SIGTERM'); // gives up waiting after 50ms
    expect((service as any).workerConnection).toBeNull();

    resolveLate(late);
    await reconnecting;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect((service as any).workerConnection).toBeNull();
  });

  // Greptile round 1: shutdown that stops a reconnect before it opens a connection must not
  // read as success, for the caller or for a concurrent one.
  it('resolves false when shutdown stops a reconnect before it opens a connection', async () => {
    await build(); // shutdownTimeout 50ms
    const wedged = fakeConnection('c1', { hangOnClose: true });
    mockConnect.mockResolvedValueOnce(wedged);
    await service.establishConnection();

    const first = service.reconnect('test');
    const second = service.reconnect('concurrent');
    await new Promise((r) => setImmediate(r));
    const shutdown = service.onApplicationShutdown('SIGTERM');

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await shutdown;
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('logs the skip warning once per pending connect()', async () => {
    await build();
    let resolveConnect: (c: unknown) => void = () => undefined;
    mockConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const pending = service.establishConnection();
    await new Promise((r) => setImmediate(r));

    for (let i = 0; i < 5; i++) await service.reconnect('impatient');
    const skips = warn.mock.calls.filter(([m]) =>
      String(m).startsWith('Skipping Inngest reconnect'),
    );
    expect(skips).toHaveLength(1);

    resolveConnect(fakeConnection('c1'));
    await pending;
  });

  it('does not reconnect after shutdown started', async () => {
    await build();
    mockConnect.mockResolvedValueOnce(fakeConnection('c1'));
    await service.establishConnection();
    await service.onApplicationShutdown('SIGTERM');

    await expect(service.reconnect('late')).resolves.toBe(false);
    expect(mockConnect).toHaveBeenCalledTimes(1);
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
