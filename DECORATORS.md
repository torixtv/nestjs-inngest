# NestJS Inngest Decorators Guide

This guide explains how the Inngest decorators work technically, how function registration happens, and how to use all available decorators.

## Table of Contents

- [Overview](#overview)
- [Core Decorators](#core-decorators)
- [Middleware Decorators](#middleware-decorators)
- [Technical Implementation](#technical-implementation)
- [Function Registration Process](#function-registration-process)
- [Usage Examples](#usage-examples)

## Overview

The NestJS Inngest integration uses TypeScript decorators to automatically discover and register Inngest functions within your NestJS application. The decorators work by storing metadata on class methods, which is then read during application startup to create and register Inngest functions.

This guide reflects the Inngest v4 SDK integration:

- Function config uses `triggers`, not `trigger`
- Function middleware uses `Middleware.BaseMiddleware` classes, not `InngestMiddleware`
- Decorators now cover newer v4 execution controls such as batching, cancellation, singleton execution, timeouts, idempotency, checkpointing, and failure handlers

## Core Decorators

### `@InngestFunction(config)`

The primary decorator that marks a method as an Inngest function.

```typescript
@InngestFunction({
  id: 'my-function',
  name: 'My Function',
  triggers: { event: 'user.created' },
})
async myFunction({ event, step }: { event: any; step: any }) {
  // Function logic here
}
```

**Parameters:**
- `id`: Unique identifier for the function
- `name`: Display name (optional)
- `triggers`: One trigger or an array of event/cron triggers
- Additional Inngest configuration options

### `@InngestEvent(id, event, options?)`

Shorthand for event-triggered functions.

```typescript
@InngestEvent('process-user', 'user.updated')
async processUser({ event, step }: { event: any; step: any }) {
  // Handles user.updated events
}
```

**Parameters:**
- `id`: Function identifier
- `event`: Event name or event configuration object
- `options`: Additional function options

### `@InngestCron(id, cron, options?)`

Shorthand for scheduled/cron functions.

```typescript
@InngestCron('daily-cleanup', '0 2 * * *')
async dailyCleanup({ event, step }: { event: any; step: any }) {
  // Runs daily at 2 AM
}
```

**Parameters:**
- `id`: Function identifier
- `cron`: Cron expression
- `options`: Additional function options

## Middleware Decorators

These decorators add execution policies to your Inngest functions.

### `@Retries(count)`

Sets the number of retry attempts on function failure.

```typescript
@InngestFunction({ id: 'my-function', triggers: { event: 'test' } })
@Retries(3) // Will retry up to 3 times
async myFunction({ event, step }) {
  // Function logic
}
```

### `@Concurrency(limit, options?)`

Controls how many instances of the function can run concurrently.

```typescript
@InngestFunction({ id: 'my-function', triggers: { event: 'test' } })
@Concurrency(5) // Max 5 concurrent executions
async myFunction({ event, step }) {
  // Function logic
}

// Advanced concurrency with options
@Concurrency(10, { 
  key: 'event.data.userId',  // Concurrency per user
  scope: 'fn'                // Function-level scope
})
async processUser({ event, step }) {
  // Max 10 concurrent executions per user
}
```

**Options:**
- `key`: Expression to group concurrency (e.g., per user, per tenant)
- `scope`: 'fn' (function), 'env' (environment), or 'account' (account-wide)

### `@RateLimit(limit, period, key?)`

Limits the rate of function execution.

```typescript
@InngestFunction({ id: 'send-email', triggers: { event: 'email.send' } })
@RateLimit(100, '1m') // Max 100 executions per minute
async sendEmail({ event, step }) {
  // Email sending logic
}

// Rate limit per user
@RateLimit(10, '1h', 'event.data.userId') // 10 per hour per user
async processUserAction({ event, step }) {
  // User action processing
}
```

### `@Throttle(limit, period, options?)`

Smooths out function execution over time.

```typescript
@InngestFunction({ id: 'api-call', triggers: { event: 'api.request' } })
@Throttle(50, '1m', { burst: 10 }) // 50 per minute, allow 10 burst
async makeApiCall({ event, step }) {
  // API call logic
}
```

**Options:**
- `key`: Grouping key for throttling
- `burst`: Number of requests allowed in a burst

### `@Debounce(period, key?)`

Prevents rapid successive executions by waiting for a quiet period.

```typescript
@InngestFunction({ id: 'save-draft', triggers: { event: 'draft.updated' } })
@Debounce('5s', 'event.data.documentId') // Wait 5 seconds of quiet per document
async saveDraft({ event, step }) {
  // Save draft logic - only executes after 5s of no new events
}
```

### `@UseMiddleware(...middleware)`

Adds custom Inngest middleware to function execution. This applies function-level middleware that runs before the function handler.

```typescript
class AuthMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'auth';
}

class LoggingMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'logging';
}

@InngestFunction({ id: 'my-function', triggers: { event: 'test' } })
@UseMiddleware(AuthMiddleware, LoggingMiddleware)
async myFunction({ event, step }) {
  // Function with custom middleware that runs before this handler
}
```

**Note**: This is function-level middleware, which is different from client-level middleware. Function-level middleware only applies to the decorated function, while client-level middleware applies to all functions created by the client.

## Technical Implementation

### How Decorators Work

1. **Metadata Storage**: Decorators use `Reflect.defineMetadata()` to store configuration on the target method.

2. **Execution Order**: Decorators execute bottom-to-top:
   ```typescript
   @InngestFunction({...})  // 3. Executes last
   @Concurrency(5)          // 2. Executes second  
   @Retries(3)              // 1. Executes first
   ```

3. **Metadata Merging**: The `@InngestFunction` decorator preserves metadata from middleware decorators:
   ```typescript
   // Get existing metadata from middleware decorators
   const existingMetadata = Reflect.getMetadata(INNGEST_FUNCTION_METADATA, target, propertyKey) || {};
   
   // Merge with function configuration
   const metadata = {
     target, propertyKey, config,
     ...existingMetadata, // Preserve middleware settings
   };
   ```

### Decorator Compatibility

The decorators support both legacy and modern TypeScript decorator systems:

```typescript
function createDecorator(updateFn: (metadata: any) => void) {
  return (target: any, propertyKey?: string | symbol, descriptor?: PropertyDescriptor | any) => {
    if (typeof propertyKey === 'object' && propertyKey && 'kind' in propertyKey) {
      // Modern decorator (stage 3) - propertyKey is context object
      const context = propertyKey as any;
      const propertyName = context.name;
      // Handle modern decorator...
    } else {
      // Legacy decorator - propertyKey is the property name
      // Handle legacy decorator...
    }
  };
}
```

## Function Registration Process

### 1. Discovery Phase (`InngestExplorer`)

During NestJS application startup:

```typescript
async onModuleInit() {
  // 1. Get all providers and controllers
  const providers = this.discoveryService.getProviders();
  const controllers = this.discoveryService.getControllers();
  
  // 2. Scan each instance for decorated methods
  for (const wrapper of [...providers, ...controllers]) {
    await this.lookupFunctions(wrapper.instance);
  }
}
```

### 2. Method Scanning

For each class instance:

```typescript
async lookupFunctions(instance: any) {
  const prototype = Object.getPrototypeOf(instance);
  const methodNames = this.metadataScanner.getAllMethodNames(prototype);
  
  // Check each method for Inngest metadata
  for (const methodName of methodNames) {
    const metadata = Reflect.getMetadata(INNGEST_FUNCTION_METADATA, prototype, methodName);
    if (metadata) {
      await this.registerFunction(instance, prototype, methodName);
    }
  }
}
```

### 3. Function Registration

When a decorated method is found:

```typescript
async registerFunction(instance: any, prototype: any, methodName: string) {
  // 1. Get all metadata (including middleware decorators)
  const functionMetadata = Reflect.getMetadata(INNGEST_FUNCTION_METADATA, prototype, methodName);
  
  // 2. Extract @UseMiddleware decorator middleware
  const middlewareFromDecorator = Reflect.getMetadata(
    INNGEST_MIDDLEWARE_METADATA,
    prototype,
    methodName,
  ) || [];

  // 3. Build complete configuration generically
  // Extract core metadata properties and spread the rest as middleware properties
  const { target, propertyKey, config: metadataConfig, ...middlewareProperties } = functionMetadata;
  
  const fullConfig = {
    id: config.id,
    name: config.name,
    ...config,
    // Apply all middleware decorator properties generically
    ...middlewareProperties,
    // Add function-level middleware from @UseMiddleware decorator
    ...(middlewareFromDecorator.length > 0 && { middleware: middlewareFromDecorator }),
  };
  
  // 4. Create Inngest function with proper handler binding
  const inngestFunction = this.inngestService.createFunction(
    fullConfig,
    async ({ event, step, ctx }) => {
      const boundHandler = prototype[methodName].bind(instance);
      return await boundHandler({ event, step, ctx });
    }
  );
  
  // 5. Register with Inngest service
  this.inngestService.registerFunction(inngestFunction);
}
```

### Additional v4 Decorators

```typescript
@InngestFunction({ id: 'process-batch', triggers: { event: 'notification.batch' } })
@BatchEvents(50, '30s', { key: 'event.data.accountId', if: 'event.data.enabled == true' })
@CancelOn({ event: 'notification.batch.cancelled', match: 'data.accountId' })
@Singleton({ mode: 'skip', key: 'event.data.accountId' })
@Priority('event.data.priority')
@Idempotency('event.data.requestId')
@Timeouts({ start: '5m', finish: '30m' })
@OptimizeParallelism()
@Checkpointing({ maxRuntime: '2h', bufferedSteps: 20 })
@OnFailure('handleFailure')
async processBatch({ events, step }) {
  // ...
}
```

### 4. Inngest Function Creation

The `InngestService.createFunction()` method:

```typescript
createFunction(options: any, handler: any) {
  // Inngest v4 accepts the trigger configuration inside options.triggers
  const fn = this.inngestClient.createFunction(options, handler);
  this.registerFunction(fn);
  return fn;
}
```

## Usage Examples

### Basic Event Handler

```typescript
@Injectable()
export class UserService {
  @InngestFunction({
    id: 'welcome-user',
    name: 'Send Welcome Email',
    triggers: { event: 'user.registered' }
  })
  @Retries(3)
  async sendWelcomeEmail({ event, step }) {
    const { userId, email } = event.data;
    
    await step.run('send-email', async () => {
      // Send welcome email logic
      await this.emailService.sendWelcome(email);
    });
  }
}
```

### Scheduled Function with Rate Limiting

```typescript
@Injectable()
export class ReportService {
  @InngestCron('generate-daily-report', '0 9 * * *') // 9 AM daily
  @RateLimit(1, '1d') // Ensure only one per day
  @Retries(2)
  async generateDailyReport({ event, step }) {
    await step.run('collect-data', async () => {
      return await this.dataService.collectDailyMetrics();
    });
    
    await step.run('generate-report', async () => {
      await this.reportService.generateAndEmail();
    });
  }
}
```

### Complex Workflow with Multiple Policies

```typescript
@Injectable()
export class OrderService {
  @InngestEvent('process-order', 'order.created')
  @Concurrency(10, { key: 'event.data.customerId', scope: 'fn' })
  @Throttle(100, '1m')
  @Debounce('30s', 'event.data.orderId')
  @Retries(5)
  async processOrder({ event, step }) {
    const { orderId, customerId } = event.data;
    
    // Validate order
    const order = await step.run('validate-order', async () => {
      return await this.validateOrder(orderId);
    });
    
    // Process payment
    await step.run('process-payment', async () => {
      await this.paymentService.charge(order.amount, customerId);
    });
    
    // Update inventory
    await step.run('update-inventory', async () => {
      await this.inventoryService.reserve(order.items);
    });
    
    // Send confirmation
    await step.sendEvent('send-confirmation', {
      name: 'order.confirmed',
      data: { orderId, customerId }
    });
  }
}
```

### Error Handling Function

```typescript
@Injectable()
export class ErrorService {
  @InngestEvent('handle-error', 'app.error')
  @RateLimit(50, '1m') // Prevent error spam
  @Retries(1) // Only retry once for error handlers
  async handleError({ event, step }) {
    const { error, context } = event.data;
    
    await step.run('log-error', async () => {
      await this.logger.error(error, context);
    });
    
    if (error.severity === 'critical') {
      await step.run('alert-team', async () => {
        await this.alertService.sendCriticalAlert(error);
      });
    }
  }
}
```

## Best Practices

1. **Use descriptive IDs**: Make function IDs clear and unique
2. **Apply appropriate retries**: Use `@Retries()` based on function criticality
3. **Set concurrency limits**: Use `@Concurrency()` to prevent resource exhaustion
4. **Rate limit external calls**: Use `@RateLimit()` for API calls or expensive operations
5. **Debounce rapid events**: Use `@Debounce()` for events that might fire rapidly
6. **Combine decorators thoughtfully**: Each decorator adds overhead, use what you need
7. **Use object destructuring**: Access `{ event, step, ctx }` directly in function parameters

## Recent Changes and Deprecations

### Removed Decorators

The following decorators have been removed in favor of cleaner alternatives:

#### Parameter Injection Decorators (Removed)
- `@Step` - Use object destructuring instead: `({ event, step, ctx }) => {}`
- `@Event` - Use object destructuring instead: `({ event, step, ctx }) => {}`
- `@Context` - Use object destructuring instead: `({ event, step, ctx }) => {}`
- `@UseParameterInjection` - No longer needed with object destructuring

**Before:**
```typescript
@InngestFunction({ id: 'my-function', triggers: { event: 'test' } })
async myFunction(@Event() event: any, @Step() step: any, @Context() ctx: any) {
  // Function logic
}
```

**After (Recommended):**
```typescript
@InngestFunction({ id: 'my-function', triggers: { event: 'test' } })
async myFunction({ event, step, ctx }) {
  // Function logic - cleaner and more straightforward
}
```

#### Trigger Decorators (Removed)
- `@InngestTrigger` - Use `@InngestFunction` with trigger config instead
- `@Cron` - Use `@InngestCron` instead
- `@OnEvent` - Use `@InngestEvent` instead  
- `@OnEvents` - Use `@InngestFunction` with multiple triggers instead

**Before:**
```typescript
@InngestFunction({ id: 'my-function' })
@OnEvent('user.created')
async handleUser({ event, step, ctx }) {}
```

**After (Recommended):**
```typescript
@InngestEvent('handle-user', 'user.created')
async handleUser({ event, step, ctx }) {}
```

### Improved Features

#### Generic Function Registration
The function registration system now uses generic object destructuring instead of hardcoded middleware property extraction. This means any new middleware decorators will automatically work without needing code changes.

#### Complete @UseMiddleware Implementation
The `@UseMiddleware` decorator now fully supports Inngest function-level middleware, allowing you to add custom middleware that runs before your function handlers.

The decorator system provides a powerful, declarative way to configure Inngest functions while keeping your business logic clean and focused.
