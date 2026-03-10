# Serve to Connect Migration Guide

This guide is for teams currently running `@torixtv/nestjs-inngest` in `serve` mode and planning to move to `connect`.

It is intentionally conservative. The main goal is a safe migration without repeating the connection-drop issues we previously saw in `connect`.

## What Changed

This release improves `connect` support in a few ways that matter for migration:

- The package now targets `inngest@3.52.6`
- `maxWorkerConcurrency` is now the primary documented concurrency setting
- `connect.isolateExecution` is now supported, typed, and forwarded to the SDK
- Connection health checks now understand the current SDK's same-thread internal shape
- When `isolateExecution` is enabled, health checks intentionally fall back to SDK state instead of raw WebSocket inspection

## Why Previous Connect Rollouts Were Painful

The biggest risk with `connect` is that the worker can look healthy at the process level while the underlying connection is degraded or repeatedly reconnecting.

Common causes:

- Event-loop blocking or CPU-heavy code delays heartbeats
- Running worker execution in the same busy process as unrelated HTTP or batch work
- Aggressive concurrency before the worker behavior is well understood
- Weak readiness/liveness signals during rollout

`isolateExecution: true` is specifically interesting here because it moves the SDK's connection-management loop into a worker thread, which can reduce false disconnects caused by blocked user code on the main thread.

## Migration Strategy

Do not switch every existing `serve` consumer in place on day one.

Recommended rollout:

1. Start with one dedicated `connect` worker deployment.
2. Validate in a non-production Inngest environment first.
3. Keep the rollout small: one replica, low concurrency, clear health probes.
4. Observe for reconnect churn before increasing replicas or concurrency.
5. Roll back by redeploying the previous `serve` configuration if connection stability is not acceptable.

For initial validation, prefer a separate Inngest environment or otherwise isolated test target. Avoid mixing `serve` and `connect` replicas for the same app/environment during cutover unless you are doing that deliberately and understand the overlap.

## Recommended First Configuration

```typescript
InngestModule.forRoot({
  id: process.env.INNGEST_APP_ID || 'my-app',
  mode: 'connect',
  signingKey: process.env.INNGEST_SIGNING_KEY,
  connect: {
    instanceId: process.env.INNGEST_INSTANCE_ID,
    maxWorkerConcurrency: 2,
    isolateExecution: true,
    shutdownTimeout: 60000,
    handleShutdownSignals: ['SIGTERM', 'SIGINT'],
  },
});
```

```bash
INNGEST_MODE=connect
INNGEST_SIGNING_KEY=...
INNGEST_INSTANCE_ID=worker-1
INNGEST_CONNECT_MAX_WORKER_CONCURRENCY=2
INNGEST_CONNECT_ISOLATE_EXECUTION=true
INNGEST_SHUTDOWN_TIMEOUT=60000
```

Recommended starting point:

- Use a dedicated worker deployment if possible
- Start with `maxWorkerConcurrency: 1` or `2`
- Prefer `isolateExecution: true` for the first migration if previous failures looked like heartbeat drops or random disconnects
- Set `instanceId` explicitly so logs and diagnostics are easier to follow

## What Changes for Consumers

Most application code does not need to change.

What stays the same:

- Function definitions
- Event sending via `InngestService.send()`
- Health and monitoring modules

What changes:

- Function execution no longer depends on Inngest calling your HTTP `serve` endpoint
- The worker now maintains an outbound connection to Inngest
- Readiness should be based on `connect` health, not only on HTTP process uptime

## Rollout Checklist

- Confirm `signingKey` is available in the target environment
- Set a stable, explicit `instanceId`
- Start with low `maxWorkerConcurrency`
- Expose `/health/inngest` and use it for readiness/liveness
- Watch for sustained `RECONNECTING`, `PAUSED`, or repeated transitions out of `ACTIVE`
- Roll out one replica before horizontal scaling
- Increase concurrency only after the connection remains stable under normal traffic

## Health Expectations

In same-thread `connect` mode, this package can inspect the underlying WebSocket more directly.

In `isolateExecution` mode, the SDK keeps connection internals inside its worker thread, so this package falls back to the SDK's public connection state for health reporting.

That means:

- `ACTIVE` is the key steady-state target
- Short reconnects may happen during network disturbances
- Repeated or prolonged `RECONNECTING` is a rollout blocker

## Known Caveats

- Do not combine `connect.isolateExecution` with `connect.rewriteGatewayEndpoint`
- Do not begin with high concurrency just because `serve` was stable
- Do not treat "process is up" as proof that the Inngest connection is healthy

## Troubleshooting Connection Drops

If the worker still appears to die or flap:

- Turn on `isolateExecution` if it is currently off
- Reduce `maxWorkerConcurrency`
- Check whether the process is doing CPU-heavy synchronous work
- Separate the worker from unrelated HTTP traffic or batch jobs
- Verify readiness probes are checking `/health/inngest`
- Watch logs for repeated reconnect cycles tied to deployment, scaling, or resource pressure

## Suggested Cutover Order

1. Deploy one `connect` worker in a non-production environment.
2. Verify it reaches and stays in `ACTIVE`.
3. Exercise real functions with low concurrency.
4. Repeat in production with one replica.
5. Increase replicas or concurrency only after connection stability is proven.
