# Migration Guide: `0.x` to `1.0.0`

This guide is for users upgrading from any previous `0.x` release of `@torixtv/nestjs-inngest` to `1.0.0`.

`1.0.0` is a breaking release because the package now aligns its public API with the Inngest v4 SDK instead of preserving older v3-era names.

## Upgrade Checklist

1. Upgrade to `@torixtv/nestjs-inngest@^1.0.0` and `inngest@^4.0.5`
2. Ensure your runtime is Node `>=20`
3. Rename `trigger` to `triggers`
4. Rename `serveHost` to `serveOrigin`
5. Rename `rewriteGatewayEndpoint` to `gatewayUrl`
6. Replace `InngestMiddleware` usage with class-based `Middleware`
7. Replace any `connect.maxConcurrency` usage with `connect.maxWorkerConcurrency`
8. Remove any references to removed v3-only exports such as `GetEvents`
9. Update decorator usage if you want the newer v4 execution controls
10. Run a local registration and execution smoke test against the Inngest dev server

## Breaking Changes At A Glance

| Previous package surface | `1.0.0` surface | What you need to do |
| --- | --- | --- |
| `trigger` | `triggers` | Rename the config property in `@InngestFunction(...)` |
| `serveHost` | `serveOrigin` | Rename serve-mode registration config |
| `rewriteGatewayEndpoint` | `gatewayUrl` | Rename connect-mode gateway override |
| `InngestMiddleware` | `Middleware.BaseMiddleware` or `Middleware.Class` | Rewrite middleware definitions and `@UseMiddleware(...)` usage |
| `connect.maxConcurrency` | `connect.maxWorkerConcurrency` | Rename the option |
| `GetEvents` export | Removed | Stop importing it; use the v4 `inngest` types you actually need |
| `inngest@^3.x` | `inngest@^4.0.5` | Upgrade the SDK |
| Node `<20` | Node `>=20` | Upgrade the runtime |

## Install And Runtime Requirements

Before:

```bash
npm install @torixtv/nestjs-inngest inngest
```

After:

```bash
npm install @torixtv/nestjs-inngest@^1.0.0 inngest@^4.0.5
```

Runtime requirement:

```text
Node >=20
```

## Function Configuration Changes

### `trigger` -> `triggers`

Before:

```typescript
@InngestFunction({
  id: 'process-order',
  trigger: { event: 'order.created' },
})
async processOrder({ event, step }) {
  // ...
}
```

After:

```typescript
@InngestFunction({
  id: 'process-order',
  triggers: { event: 'order.created' },
})
async processOrder({ event, step }) {
  // ...
}
```

`triggers` accepts either a single trigger or an array of triggers.

### Multiple triggers on a single function

You can now model this directly without workarounds.

```typescript
@InngestFunction({
  id: 'sync-account',
  triggers: [
    { event: 'account.sync.requested' },
    { event: 'account.resync.requested' },
  ],
})
async syncAccount({ event, step }) {
  // ...
}
```

The `@InngestEvent(...)` shorthand also accepts arrays, conditional trigger objects, and `eventType(...)` values.

## Decorator Changes

### Existing decorators with expanded support

`1.0.0` keeps the existing decorator-first model, but expands it to cover the v4 execution controls.

#### `@Concurrency`

Before you could only express the simple numeric form reliably.

Now you can use all of these:

```typescript
@Concurrency(5)

@Concurrency({ limit: 2, key: 'event.data.accountId' })

@Concurrency([
  { limit: 1, key: 'event.data.accountId' },
  { limit: 5, key: 'event.data.userId' },
])
```

#### `@Debounce`

Before:

```typescript
@Debounce('5s', 'event.data.documentId')
```

After:

```typescript
@Debounce('5s', 'event.data.documentId', '5m')
```

The third argument is the optional `timeout`.

#### `@BatchEvents`

Before, the wrapper did not expose all v4 fields.

After:

```typescript
@BatchEvents(25, '30s', {
  key: 'event.data.accountId',
  if: 'event.data.enabled == true',
})
```

### New decorator-first execution controls

The package now supports these decorators directly:

- `@BatchEvents`
- `@CancelOn`
- `@Singleton`
- `@Priority`
- `@Idempotency`
- `@Timeouts`
- `@OptimizeParallelism`
- `@Checkpointing`
- `@OnFailure`

Example:

```typescript
@InngestFunction({
  id: 'sync-account',
  triggers: { event: 'account.sync.requested' },
})
@Concurrency([
  { limit: 1, key: 'event.data.accountId' },
  { limit: 5, key: 'event.data.userId' },
])
@BatchEvents(25, '30s', {
  key: 'event.data.accountId',
  if: 'event.data.priority != "low"',
})
@CancelOn([
  { event: 'account.sync.cancelled', match: 'data.accountId' },
  { event: 'account.deleted', match: 'data.accountId' },
])
@Singleton({ mode: 'cancel', key: 'event.data.accountId' })
@Priority('event.data.priority')
@Idempotency('event.data.requestId')
@Timeouts({ start: '5m', finish: '30m' })
@OptimizeParallelism(true)
@Checkpointing({ maxRuntime: '1h', bufferedSteps: 10, maxInterval: '5m' })
@OnFailure('handleSyncFailure')
async syncAccount({ event, step }) {
  // ...
}

async handleSyncFailure({ event, step }) {
  // ...
}
```

### `@OnFailure` migration pattern

The new failure-handler path is method-based:

```typescript
@InngestFunction({
  id: 'import-catalog',
  triggers: { event: 'catalog.import.requested' },
})
@OnFailure('handleCatalogImportFailure')
async importCatalog({ event, step }) {
  // ...
}

async handleCatalogImportFailure({ event, step }) {
  // ...
}
```

Rules:

- The referenced method must exist on the same class
- It should be a normal class method, not a separate independently decorated Inngest function unless you intend that explicitly
- Invalid method references fail during registration

## Middleware Migration

### `InngestMiddleware` -> class-based `Middleware`

Before:

```typescript
const loggingMiddleware = new InngestMiddleware({
  name: 'logging',
});

@UseMiddleware(loggingMiddleware)
async myFunction({ event, step }) {
  // ...
}
```

After:

```typescript
import { Middleware, UseMiddleware } from '@torixtv/nestjs-inngest';

class LoggingMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'logging';
}

@UseMiddleware(LoggingMiddleware)
async myFunction({ event, step }) {
  // ...
}
```

You can also pass middleware classes globally through the module config:

```typescript
InngestModule.forRoot({
  id: 'my-app',
  middleware: [LoggingMiddleware],
});
```

## Module Configuration Changes

### Serve mode

Before:

```typescript
InngestModule.forRoot({
  id: 'my-app',
  baseUrl: 'http://localhost:8288',
  serveHost: 'https://api.example.com',
  servePort: 3000,
});
```

After:

```typescript
InngestModule.forRoot({
  id: 'my-app',
  baseUrl: 'http://localhost:8288',
  serveOrigin: 'https://api.example.com',
  servePort: 3000,
});
```

If you are rotating keys, `1.0.0` also supports `signingKeyFallback`.

```typescript
InngestModule.forRoot({
  id: 'my-app',
  signingKey: process.env.INNGEST_SIGNING_KEY,
  signingKeyFallback: process.env.INNGEST_SIGNING_KEY_FALLBACK,
});
```

### Connect mode

Before:

```typescript
InngestModule.forRoot({
  id: 'my-app',
  mode: 'connect',
  connect: {
    rewriteGatewayEndpoint: 'ws://localhost:8288/connect',
    maxConcurrency: 10,
  },
});
```

After:

```typescript
InngestModule.forRoot({
  id: 'my-app',
  mode: 'connect',
  connect: {
    gatewayUrl: 'ws://localhost:8288/connect',
    maxWorkerConcurrency: 10,
  },
});
```

Recommended starting point for a first connect rollout:

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

## Imports And Re-exports

### Removed or renamed

- `GetEvents` is no longer exported
- `InngestMiddleware` is no longer exported

### New or now-important re-exports

These helpers are re-exported from `inngest` through this package:

- `Middleware`
- `eventType`
- `cron`
- `invoke`
- `staticSchema`
- `referenceFunction`
- `group`
- `step`
- `GetFunctionOutput`
- `StepError`
- `NonRetriableError`
- `RetryAfterError`

## What Does Not Change

Most application logic does not need to change:

- `InngestService.send(...)` still sends events the same way
- `@InngestEvent(...)` and `@InngestCron(...)` are still the main shorthand decorators
- Step-based workflow code using `step.run()`, `step.waitForEvent()`, `step.sendEvent()`, `step.sleep()`, and `step.sleepUntil()` stays the same
- Health checks, monitoring, and tracing remain available

## Recommended Verification After Upgrading

After you update the package and rename the breaking APIs:

1. Run `npm install`
2. Run `npm run build`
3. Start the Inngest dev server with `inngest dev`
4. Start your NestJS app
5. Verify your functions register in the Inngest dev UI
6. Send a real event and confirm the function runs
7. If you use connect mode, confirm the worker reaches `ACTIVE`
8. If you use `@OnFailure`, trigger a controlled failure and verify the handler runs

## Common Upgrade Mistakes

- Renaming `trigger` to `triggers` in some functions but not all
- Keeping `serveHost` or `rewriteGatewayEndpoint` in config
- Passing old middleware instances to `@UseMiddleware(...)` instead of middleware classes
- Keeping `connect.maxConcurrency` instead of `connect.maxWorkerConcurrency`
- Forgetting the Node `>=20` runtime requirement
- Assuming old names still exist as compatibility aliases

## Need More Detail?

- See [README.md](./README.md) for current API usage and examples
- See [DECORATORS.md](./DECORATORS.md) for detailed decorator semantics
- See [CHANGELOG.md](./CHANGELOG.md) for the release summary
