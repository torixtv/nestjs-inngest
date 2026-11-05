import {
  ConnectWatchdog,
  NO_CONNECTION_ERROR_PREFIX,
  WatchdogDebugState,
} from '../src/services/connect-watchdog';

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
  // Default: an SDK with getDebugState() whose heartbeats keep arriving.
  let debug: WatchdogDebugState | null | 'fresh' =
    overrides.debug === undefined ? 'fresh' : overrides.debug;
  let shuttingDown = false;
  const reconnect = overrides.reconnect ?? jest.fn().mockResolvedValue(true);
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const watchdog = new ConnectWatchdog(overrides.options, {
    getState: () => state,
    getDebugState: () => (debug === 'fresh' ? { lastHeartbeatReceivedAt: now - 3_000 } : debug),
    isShuttingDown: () => shuttingDown,
    reconnect,
    now: () => now,
    logger,
  });

  const h = {
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
    setDebug: (d: WatchdogDebugState | null | 'fresh') => {
      debug = d;
    },
    setShuttingDown: (v: boolean) => {
      shuttingDown = v;
    },
    noConnectionErrors: () =>
      logger.error.mock.calls.filter(([m]) => String(m).startsWith(NO_CONNECTION_ERROR_PREFIX)),
    /** Tick every 15s (the default interval) for `ms`, letting reconnects settle. */
    run: async (ms: number) => {
      for (let t = 0; t < ms; t += 15_000) {
        await watchdog.tick();
        await watchdog.settled();
        now += 15_000;
      }
    },
  };
  return h;
}

describe('ConnectWatchdog', () => {
  afterEach(() => jest.clearAllMocks());

  it('stays healthy and never reconnects while ACTIVE with fresh heartbeats', async () => {
    const h = harness();
    await h.run(25 * 60_000);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.watchdog.status()).toMatchObject({ transportHealthy: true, unhealthyForMs: 0 });
  });

  it('tolerates a brief non-ACTIVE state, and ends the episode only after 2 min healthy', async () => {
    const h = harness();
    h.setState('RECONNECTING');
    await h.run(60_000);
    expect(h.watchdog.status().transportHealthy).toBe(false);

    h.setState('ACTIVE');
    await h.run(105_000);
    expect(h.watchdog.status().transportHealthy).toBe(false); // healthy, but not for 2 min yet
    await h.run(30_000);
    expect(h.watchdog.status()).toMatchObject({ transportHealthy: true, unhealthyForMs: 0 });
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Inngest worker connection recovered after 60s'),
    );
  });

  // 2026-10-30 00:10: the Inngest gateway hung for ~2 minutes and every pod sat in
  // RECONNECTING until it came back. The watchdog's reconnect is the only action it takes,
  // so a fleet-wide outage costs one extra connection attempt per pod and nothing else.
  it('a 2-minute fleet-wide outage costs at most one reconnect and no error log', async () => {
    const h = harness({ state: 'RECONNECTING' });
    await h.run(135_000);
    h.setState('ACTIVE');
    await h.run(5 * 60_000);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.noConnectionErrors()).toHaveLength(0);
    expect(h.watchdog.status().transportHealthy).toBe(true);
  });

  it('forces a reconnect once a non-ACTIVE state outlives reconnectAfterMs, rate-limited', async () => {
    const h = harness({ state: 'RECONNECTING' });
    await h.watchdog.tick(); // unhealthySince = t0
    h.advance(119_000);
    await h.watchdog.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    h.advance(1_000); // 120s
    await h.watchdog.tick();
    await h.watchdog.settled();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.reconnect).toHaveBeenCalledWith('SDK state is RECONNECTING');

    // Still broken: no second reconnect inside minReconnectIntervalMs (5 min)
    h.advance(299_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    h.advance(1_000);
    await h.watchdog.tick();
    await h.watchdog.settled();
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(h.watchdog.status().reconnectAttempts).toBe(2);
  });

  // The SDK gives up for good when its worker thread crashes more than 10 times in a row,
  // or when its connection loop dies on an unexpected error, and in both cases its state
  // stays RECONNECTING forever. Nothing but a fresh connection recovers it.
  it('repairs an SDK that gave up for good', async () => {
    const h = harness({ state: 'RECONNECTING' });
    h.reconnect.mockImplementation(async () => {
      h.setState('ACTIVE');
      h.watchdog.onConnectionReplaced();
      return true;
    });
    await h.run(10 * 60_000);
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.watchdog.status().transportHealthy).toBe(true);
    expect(h.noConnectionErrors()).toHaveLength(0);
  });

  // Found in review: ending the episode on the first healthy check after a reconnect let a
  // worker that breaks again shortly after every reconnect stay silent for hours.
  // Two rules cover it, and each catches a case the other misses: the episode stays open
  // until the connection has been healthy for 2 min (45 s case), and 3 forced reconnects
  // within 30 min log the error whatever the episode length (3 min case).
  it.each([
    ['45 s', 45_000],
    ['3 min', 3 * 60_000],
  ])(
    'logs the error for a worker that breaks again %s after every reconnect',
    async (_label, okForMs) => {
      const h = harness({ state: 'RECONNECTING' });
      let brokenAt = Number.POSITIVE_INFINITY;
      h.reconnect.mockImplementation(async () => {
        h.setState('ACTIVE');
        h.watchdog.onConnectionReplaced();
        brokenAt = h.now() + okForMs;
        return true;
      });
      for (let t = 0; t < 2 * 3600_000; t += 15_000) {
        if (h.now() >= brokenAt) h.setState('RECONNECTING');
        await h.watchdog.tick();
        await h.watchdog.settled();
        h.advance(15_000);
      }
      expect(h.reconnect.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(h.noConnectionErrors().length).toBeGreaterThan(0);
    },
  );

  it('keeps one episode open for a connection that flaps without ever staying healthy', async () => {
    // Down 90 s, up 30 s, repeatedly: no single outage reaches reconnectAfterMs, so ending
    // the episode on the first healthy check would never reconnect or log anything.
    const h = harness();
    for (let t = 0; t < 30 * 60_000; t += 15_000) {
      h.setState(t % 120_000 < 90_000 ? 'RECONNECTING' : 'ACTIVE');
      await h.watchdog.tick();
      await h.watchdog.settled();
      h.advance(15_000);
    }
    expect(h.reconnect).toHaveBeenCalled();
    expect(h.noConnectionErrors().length).toBeGreaterThan(0);
  });

  describe('heartbeats', () => {
    it('detects an ACTIVE connection whose gateway heartbeats stopped (frozen worker-thread state)', async () => {
      const h = harness();
      await h.watchdog.tick(); // activeSince = t0
      h.setDebug({ lastHeartbeatReceivedAt: h.now() });
      await h.watchdog.tick();
      expect(h.watchdog.status().transportHealthy).toBe(true);

      h.advance(61_000);
      await h.watchdog.tick();
      const status = h.watchdog.status();
      expect(status.transportHealthy).toBe(false);
      expect(status.unhealthyReason).toMatch(/no gateway heartbeat for 61s/);

      h.advance(120_000);
      await h.watchdog.tick();
      await h.watchdog.settled();
      expect(h.reconnect).toHaveBeenCalledTimes(1);
    });

    // Found in review: a worker thread that stalls before its first heartbeat would report
    // ACTIVE with an empty heartbeat time forever.
    it('treats ACTIVE with no heartbeat ever as stale after heartbeatStaleMs', async () => {
      const h = harness({ debug: { lastHeartbeatReceivedAt: undefined } });
      await h.run(60_000);
      expect(h.watchdog.status().transportHealthy).toBe(true);
      await h.run(30_000);
      expect(h.watchdog.status().unhealthyReason).toMatch(
        /ACTIVE for .* without a gateway heartbeat/,
      );
    });

    it('does not flag a connection that just became ACTIVE and has had no heartbeat yet', async () => {
      const h = harness({ debug: { lastHeartbeatReceivedAt: undefined } });
      await h.run(45_000);
      expect(h.watchdog.status().transportHealthy).toBe(true);
    });

    // Found in review: the SDK keeps its pre-outage heartbeat time across its own
    // reconnect, so right after it recovers the heartbeat looks as old as the outage.
    it('does not reconnect a connection the SDK itself just recovered', async () => {
      const h = harness();
      await h.run(30_000);
      const lastBeforeOutage = h.now();
      h.setDebug({ lastHeartbeatReceivedAt: lastBeforeOutage });
      h.setState('RECONNECTING');
      await h.run(105_000); // just under reconnectAfterMs
      h.setState('ACTIVE'); // SDK reconnected; heartbeat time still from before the outage
      await h.run(30_000);
      expect(h.reconnect).not.toHaveBeenCalled();
    });

    it('warns once when the SDK cannot report heartbeats, and keeps checking state', async () => {
      const h = harness({ debug: null });
      await h.run(10 * 60_000);
      const warnings = h.logger.warn.mock.calls.filter(([m]) =>
        String(m).includes('cannot check gateway heartbeats'),
      );
      expect(warnings).toHaveLength(1);
      h.setState('RECONNECTING');
      await h.run(150_000);
      expect(h.reconnect).toHaveBeenCalled();
    });
  });

  it('treats a missing worker connection as unhealthy and repairs it', async () => {
    const h = harness({ state: null });
    await h.watchdog.tick();
    h.advance(120_000);
    await h.watchdog.tick();
    expect(h.reconnect).toHaveBeenCalledWith('no worker connection');
  });

  // Found in review: with default options the SDK closes its own connection on SIGTERM.
  it.each(['CLOSING', 'CLOSED'])(
    'never reconnects a connection the SDK closed on purpose (%s)',
    async (closedState) => {
      const h = harness({ state: closedState });
      await h.run(30 * 60_000);
      expect(h.reconnect).not.toHaveBeenCalled();
      expect(h.logger.error).not.toHaveBeenCalled();
    },
  );

  describe('error log for alerting', () => {
    it('logs after errorAfterMs and repeats every errorRepeatMs while broken', async () => {
      const h = harness({ state: 'RECONNECTING' });
      await h.run(300_000); // ticks up to 4:45
      expect(h.noConnectionErrors()).toHaveLength(0);

      await h.run(5 * 60_000); // ticks from 5:00 to 9:45
      const errors = h.noConnectionErrors();
      expect(errors).toHaveLength(5); // 5:00, 6:00, 7:00, 8:00, 9:00
      expect(String(errors[0][0])).toContain('for 5 min: SDK state is RECONNECTING.');
      expect(String(errors[0][0])).toContain('Forced reconnects in the last 30 min: 1.');
    });

    it('starts a new episode only after the connection stayed healthy', async () => {
      const h = harness({ state: 'RECONNECTING' });
      await h.run(6 * 60_000);
      expect(h.noConnectionErrors().length).toBeGreaterThan(0);
      const before = h.noConnectionErrors().length;

      h.setState('ACTIVE');
      await h.run(3 * 60_000);
      expect(h.watchdog.status().transportHealthy).toBe(true);
      h.setState('RECONNECTING');
      await h.run(4 * 60_000);
      expect(h.noConnectionErrors()).toHaveLength(before); // new episode not yet 5 min old
      await h.run(2 * 60_000);
      expect(h.noConnectionErrors().length).toBeGreaterThan(before);
    });

    it('honours custom errorAfterMs and errorRepeatMs', async () => {
      const h = harness({
        state: 'CONNECTING',
        options: { errorAfterMs: 60_000, errorRepeatMs: 300_000 },
      });
      await h.run(75_000);
      expect(h.noConnectionErrors()).toHaveLength(1);
      await h.run(4 * 60_000);
      expect(h.noConnectionErrors()).toHaveLength(1);
    });
  });

  describe('failed reconnects', () => {
    it('records a reconnect error without throwing', async () => {
      const reconnect = jest.fn().mockRejectedValue(new Error('gateway unreachable'));
      const h = harness({ state: 'RECONNECTING', reconnect });
      await h.watchdog.tick();
      h.advance(120_000);
      await expect(h.watchdog.tick()).resolves.toBeUndefined();
      await h.watchdog.settled();
      expect(h.watchdog.status()).toMatchObject({
        lastReconnectError: 'gateway unreachable',
        consecutiveFailedReconnects: 1,
      });
      expect(h.logger.error).toHaveBeenCalledWith(
        'Inngest watchdog reconnect failed: gateway unreachable',
      );
    });

    // Found in review: a connect() that throws leaves a worker thread behind; retrying
    // every 5 min forever would leak one per attempt.
    it('stops reconnecting after 3 failures in a row and asks for a restart', async () => {
      const reconnect = jest.fn().mockRejectedValue(new Error('fatal'));
      const h = harness({ state: null, reconnect });
      await h.run(2 * 3600_000);
      expect(reconnect).toHaveBeenCalledTimes(3);
      expect(h.watchdog.status().reconnectsStopped).toBe(true);
      const last = h.noConnectionErrors().pop();
      expect(String(last?.[0])).toContain(
        'stopped reconnecting after 3 failed attempts in a row; restart this pod',
      );
    });

    // Greptile round 1: a skip did nothing, so it must not start the 5-min cooldown. The
    // pending first connect() it waited for may throw right after.
    it('retries a minute after a skipped reconnect instead of after the cooldown', async () => {
      const h = harness({ state: null });
      h.reconnect.mockResolvedValueOnce(false).mockResolvedValue(true);
      await h.run(135_000); // first try at 2:00, skipped
      expect(h.reconnect).toHaveBeenCalledTimes(1);
      await h.run(60_000); // retried at 3:00
      expect(h.reconnect).toHaveBeenCalledTimes(2);
      expect(h.watchdog.status().reconnectAttempts).toBe(1);
    });

    it('does not count a skipped reconnect as an attempt', async () => {
      const reconnect = jest.fn().mockResolvedValue(false);
      const h = harness({ state: 'CONNECTING', reconnect });
      await h.run(6 * 60_000);
      expect(reconnect).toHaveBeenCalled();
      expect(h.watchdog.status().reconnectAttempts).toBe(0);
      expect(String(h.noConnectionErrors()[0][0])).toContain(
        'Forced reconnects in the last 30 min: 0.',
      );
    });
  });

  it('logs instead of throwing when a dependency throws', async () => {
    const h = harness();
    (h.watchdog as any).deps.getState = () => {
      throw new Error('boom');
    };
    await expect(h.watchdog.tick()).resolves.toBeUndefined();
    expect(h.logger.error).toHaveBeenCalledWith('Inngest watchdog check failed: boom');
  });

  it('does nothing while the host is shutting down', async () => {
    const h = harness({ state: 'RECONNECTING' });
    h.setShuttingDown(true);
    await h.run(30 * 60_000);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    const h = harness({ state: 'RECONNECTING', options: { enabled: false } });
    await h.run(30 * 60_000);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.watchdog.status()).toMatchObject({ enabled: false, transportHealthy: true });
  });

  it('keeps evaluating while a slow reconnect is pending, without starting another', async () => {
    let release: (v: boolean) => void = () => undefined;
    const reconnect = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const h = harness({ state: 'RECONNECTING', reconnect });
    await h.watchdog.tick();
    h.advance(120_000);
    await h.watchdog.tick(); // starts reconnect, returns immediately
    expect(reconnect).toHaveBeenCalledTimes(1);

    h.setState('CONNECTING');
    h.advance(600_000); // past minReconnectIntervalMs and errorAfterMs
    await h.watchdog.tick();
    expect(reconnect).toHaveBeenCalledTimes(1); // still in flight: no pile-up
    expect(h.watchdog.status().unhealthyReason).toBe('SDK state is CONNECTING');
    expect(h.noConnectionErrors()).toHaveLength(1); // the alert still sees the episode

    release(true);
    await h.watchdog.settled();
    h.setState('ACTIVE');
    await h.run(3 * 60_000);
    expect(h.watchdog.status().transportHealthy).toBe(true);
  });

  it('shares one in-flight tick between concurrent callers', async () => {
    let release: (v: boolean) => void = () => undefined;
    const reconnect = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const h = harness({ state: 'RECONNECTING', reconnect });
    await h.watchdog.tick();
    h.advance(120_000);
    const a = h.watchdog.tick();
    const b = h.watchdog.tick();
    await Promise.all([a, b]);
    release(true);
    await h.watchdog.settled();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
