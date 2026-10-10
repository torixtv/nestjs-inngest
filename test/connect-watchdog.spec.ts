import { ConnectWatchdog, WatchdogDebugState } from '../src/services/connect-watchdog';

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function harness(
  overrides: {
    options?: ConstructorParameters<typeof ConnectWatchdog>[0];
    state?: string | null;
    debug?: WatchdogDebugState | null;
    reconnect?: jest.Mock;
  } = {},
) {
  let now = 1_000_000;
  let state: string | null = overrides.state === undefined ? 'ACTIVE' : overrides.state;
  let debug: WatchdogDebugState | null = overrides.debug ?? null;
  let shuttingDown = false;
  const reconnect = overrides.reconnect ?? jest.fn().mockResolvedValue(undefined);
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const watchdog = new ConnectWatchdog(overrides.options, {
    getState: () => state,
    getDebugState: () => debug,
    isShuttingDown: () => shuttingDown,
    reconnect,
    now: () => now,
    logger,
  });

  return {
    watchdog,
    reconnect,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setState: (s: string | null) => {
      state = s;
    },
    setDebug: (d: WatchdogDebugState | null) => {
      debug = d;
    },
    setShuttingDown: (v: boolean) => {
      shuttingDown = v;
    },
  };
}

describe('ConnectWatchdog', () => {
  afterEach(() => jest.clearAllMocks());

  it('stays healthy and never reconnects while ACTIVE with fresh heartbeats', async () => {
    const h = harness();
    for (let i = 0; i < 100; i++) {
      h.setDebug({ lastHeartbeatReceivedAt: h.now() - 5_000 });
      await h.watchdog.tick();
      h.advance(15_000);
    }
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.watchdog.status()).toMatchObject({ transportHealthy: true, live: true });
  });

  it('does not treat a missing heartbeat timestamp as a failure (old SDK / fresh worker thread)', async () => {
    const h = harness({ debug: { lastHeartbeatReceivedAt: undefined } });
    for (let i = 0; i < 60; i++) {
      await h.watchdog.tick();
      h.advance(15_000);
    }
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.watchdog.status().transportHealthy).toBe(true);
  });

  it('tolerates brief non-ACTIVE states without reconnecting or failing liveness', async () => {
    const h = harness();
    h.setState('RECONNECTING');
    await h.watchdog.tick();
    h.advance(60_000);
    await h.watchdog.tick();
    expect(h.watchdog.status()).toMatchObject({ transportHealthy: false, live: true });
    h.setState('ACTIVE');
    h.advance(15_000);
    await h.watchdog.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.watchdog.status()).toMatchObject({ transportHealthy: true, unhealthyForMs: 0 });
  });

  it('forces a reconnect once a non-ACTIVE state outlives reconnectAfterMs, rate-limited', async () => {
    const h = harness({ state: 'RECONNECTING' });
    await h.watchdog.tick(); // unhealthySince = t0
    h.advance(119_000);
    await h.watchdog.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    h.advance(1_000); // 120s
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.reconnect).toHaveBeenCalledWith('SDK state is RECONNECTING');

    // Still broken: no second reconnect inside minReconnectIntervalMs (5 min)
    h.advance(299_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.advance(1_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(h.watchdog.status().reconnectAttempts).toBe(2);
  });

  it('detects an ACTIVE connection whose gateway heartbeats stopped (frozen worker-thread state)', async () => {
    const h = harness();
    const frozenAt = h.now();
    h.setDebug({ lastHeartbeatReceivedAt: frozenAt });
    await h.watchdog.tick();
    expect(h.watchdog.status().transportHealthy).toBe(true);

    h.advance(61_000);
    await h.watchdog.tick();
    const status = h.watchdog.status();
    expect(status.transportHealthy).toBe(false);
    expect(status.unhealthyReason).toMatch(/no gateway heartbeat for 61s/);

    h.advance(120_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });

  it('treats a missing worker connection as unhealthy and repairs it', async () => {
    const h = harness({ state: null });
    await h.watchdog.tick();
    h.advance(120_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledWith('no worker connection');
  });

  it('fails liveness only after livenessFailAfterMs of continuous transport failure', async () => {
    const h = harness({ state: 'CONNECTING' });
    await h.watchdog.tick();
    h.advance(599_000);
    await h.watchdog.tick();
    expect(h.watchdog.status().live).toBe(true);
    h.advance(1_000);
    await h.watchdog.tick();
    expect(h.watchdog.status().live).toBe(false);

    // Recovery resets liveness immediately
    h.setState('ACTIVE');
    await h.watchdog.tick();
    expect(h.watchdog.status()).toMatchObject({ live: true, transportHealthy: true });
  });

  it('records reconnect errors without throwing', async () => {
    const reconnect = jest.fn().mockRejectedValue(new Error('gateway unreachable'));
    const h = harness({ state: 'RECONNECTING', reconnect });
    await h.watchdog.tick();
    h.advance(120_000);
    await expect(h.watchdog.tick()).resolves.toBeUndefined();
    await h.watchdog.settled();
    expect(h.watchdog.status().lastReconnectError).toBe('gateway unreachable');
  });

  it('does nothing while the host is shutting down', async () => {
    const h = harness({ state: 'CLOSING' });
    h.setShuttingDown(true);
    await h.watchdog.tick();
    h.advance(1_000_000);
    await h.watchdog.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.watchdog.status().transportHealthy).toBe(true);
  });

  it('does nothing when disabled', async () => {
    const h = harness({ state: 'RECONNECTING', options: { enabled: false } });
    await h.watchdog.tick();
    h.advance(1_000_000);
    await h.watchdog.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.watchdog.status().live).toBe(true);
  });

  describe('dispatch stall (the 2026-10-10 incident shape)', () => {
    // Transport healthy - heartbeats keep flowing - but Inngest dispatches nothing.
    it('never reconnects or fails liveness; warns once per idle episode when configured', async () => {
      const h = harness({ options: { idleWarnAfterMs: 5 * 60_000 } });
      h.watchdog.recordExecution(h.now());

      for (let i = 0; i < 4 * 45; i++) {
        // 45 minutes of 15s ticks with fresh heartbeats and zero executions
        h.setDebug({ lastHeartbeatReceivedAt: h.now() - 3_000 });
        await h.watchdog.tick();
        h.advance(15_000);
      }

      expect(h.reconnect).not.toHaveBeenCalled();
      const status = h.watchdog.status();
      expect(status).toMatchObject({ live: true, transportHealthy: true, idle: true });
      const idleWarnings = h.logger.warn.mock.calls.filter(([m]) =>
        String(m).startsWith('Inngest worker idle'),
      );
      expect(idleWarnings).toHaveLength(1);

      // Runs resume: idle clears and a new episode can be reported later
      h.watchdog.recordExecution(h.now());
      expect(h.watchdog.status().idle).toBe(false);
      expect(h.logger.log).toHaveBeenCalledWith(
        'Inngest function executions resumed after an idle period',
      );
    });

    it('does not report idle when idleWarnAfterMs is not configured', async () => {
      const h = harness();
      h.advance(24 * 3600_000);
      await h.watchdog.tick();
      expect(h.watchdog.status().idle).toBe(false);
      expect(silentLogger.warn).not.toHaveBeenCalled();
    });
  });

  it('keeps evaluating while a slow reconnect is pending, without starting another', async () => {
    let release: () => void = () => undefined;
    const reconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const h = harness({ state: 'RECONNECTING', reconnect });
    await h.watchdog.tick();
    h.advance(120_000);
    await h.watchdog.tick(); // starts reconnect, returns immediately
    expect(reconnect).toHaveBeenCalledTimes(1);

    h.setState('CONNECTING');
    h.advance(600_000); // past minReconnectIntervalMs and livenessFailAfterMs
    await h.watchdog.tick();
    expect(reconnect).toHaveBeenCalledTimes(1); // still in flight: no pile-up
    expect(h.watchdog.status()).toMatchObject({
      unhealthyReason: 'SDK state is CONNECTING',
      live: false,
    });

    release();
    await h.watchdog.settled();
    h.setState('ACTIVE');
    await h.watchdog.tick();
    expect(h.watchdog.status()).toMatchObject({ live: true, transportHealthy: true });
  });

  it('shares one in-flight tick between concurrent callers', async () => {
    let release: () => void = () => undefined;
    const reconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const h = harness({ state: 'RECONNECTING', reconnect });
    await h.watchdog.tick();
    h.advance(120_000);
    const a = h.watchdog.tick();
    const b = h.watchdog.tick();
    await Promise.all([a, b]);
    release();
    await h.watchdog.settled();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
