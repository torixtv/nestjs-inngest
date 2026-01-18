# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.3] - 2026-01-18

### Fixed

- **Tracing**: Fixed compatibility with OpenTelemetry SDK v2.x
  - In SDK v2.x, `addSpanProcessor` was removed from `BasicTracerProvider`
  - Now accesses internal `MultiSpanProcessor._spanProcessors` array directly
  - Includes fallback for older SDK versions that still have `addSpanProcessor`

## [0.11.2] - 2026-01-18

### Fixed

- **Tracing**: Fixed `addSpanProcessor` detection for inherited methods
  - The `in` operator doesn't work correctly with methods inherited from prototype chain
  - Now uses direct `typeof` check which works properly with `NodeTracerProvider`

## [0.11.1] - 2026-01-18

### Fixed

- **Tracing**: Fixed InngestSpanProcessor not being added when using NodeSDK
  - The Inngest SDK's `extendProvider` doesn't handle OpenTelemetry's ProxyTracerProvider pattern
  - Now correctly uses `getDelegate()` to access the actual provider
  - Traces now export to both your OTLP endpoint (Tempo/Grafana) AND Inngest dashboard

## [0.11.0] - 2026-01-18

### Changed

- **Tracing**: Replaced custom tracing middleware with SDK's `extendedTracesMiddleware` from `inngest/experimental`
  - Integrates with existing OpenTelemetry provider using `behaviour: 'extendProvider'` (no separate configuration needed)
  - SDK uses `startActiveSpan()` for proper context propagation
  - Logs from Pino and other OTel-instrumented loggers now automatically include `traceId` and `spanId`
  - Spans are exported to both your OTLP endpoint AND Inngest dashboard

### Fixed

- **Log Correlation**: Fixed logs from Inngest functions not containing trace context
  - The custom middleware was creating non-active spans that didn't propagate context
  - Using SDK's built-in tracing which properly uses `startActiveSpan()` ensures Pino sees trace context

### Deprecated

- `InngestTracingService.createTracingMiddleware()` is now deprecated and returns `null`
  - The SDK's `extendedTracesMiddleware` is used instead for proper OTel integration

## [0.10.0] - 2026-01-18

### Added

- **`servePath` Configuration Option**: New option to specify a separate callback path for Inngest to use when sending events back to your application
  - Allows decoupling the internal serve endpoint from the external callback URL
  - Useful for scenarios with reverse proxies, API gateways, or custom routing configurations
  - Example: `serveHost: 'https://api.example.com'`, `servePath: '/webhooks/inngest'`

### Fixed

- **Zod Schema Validation**: Added `disableAutoRegistration` to the Zod configuration schema

## [0.5.0] - 2026-01-15

### Added

- **Connect Mode Support**: New `mode` configuration option to switch between HTTP webhooks (`serve`) and WebSocket-based (`connect`) communication with Inngest
  - `mode: 'serve'` (default) - Traditional HTTP webhook-based approach where Inngest calls your app
  - `mode: 'connect'` - Persistent WebSocket connection where your app connects to Inngest
- **Connect Mode Options**: New `connect` configuration object with the following options:
  - `instanceId` - Unique identifier for the worker instance (auto-generated UUID if not provided)
  - `maxWorkerConcurrency` - Maximum concurrent requests the worker will handle (new in inngest v3.45.1)
  - `maxConcurrency` - (deprecated) Use `maxWorkerConcurrency` instead
  - `shutdownTimeout` - Time in milliseconds to wait for graceful shutdown (default: 30000)
  - `handleShutdownSignals` - Array of process signals to handle for graceful shutdown (default: `['SIGTERM', 'SIGINT']`)
- **Accurate Connection Health Checks**: New `getConnectionHealth()` method on `InngestService` that inspects SDK internals to detect stale connections
  - Checks WebSocket `readyState` for actual TCP connection state
  - Monitors `pendingHeartbeats` counter (≥2 indicates failing connection)
  - Falls back gracefully to SDK state if internals are inaccessible
  - Returns detailed `ConnectionHealthInfo` with diagnostic data
- **Connection State API**: New methods on `InngestService`:
  - `getConnectionState()` - Returns current connection state (`'ACTIVE'`, `'CONNECTING'`, `'RECONNECTING'`, `'PAUSED'`, `'CLOSING'`, `'CLOSED'`, or `'NOT_APPLICABLE'` for serve mode)
  - `isConnected()` - Returns `true` only when connection state is `'ACTIVE'`
  - `getConnectionHealth()` - Returns detailed health info including WebSocket state and heartbeat status
- **New Type Exports**:
  - `ConnectionHealthInfo` - Interface for detailed connection health information
  - `WebSocketReadyState` - Enum for WebSocket ready states (CONNECTING, OPEN, CLOSING, CLOSED)
  - `ConnectionState` - Re-exported from `inngest/connect` for type-safe state comparisons
  - `InngestConnectionMode`, `InngestConnectOptions`, `ConnectOptionsSchema`
- **Environment Variable Support**: `INNGEST_MODE` environment variable to configure connection mode
- **Graceful Shutdown**: Automatic handling of shutdown signals in connect mode with configurable timeout
- **@nestjs/terminus Integration**: New `InngestHealthIndicator` for use with `@nestjs/terminus` health checks
  - `isHealthy(key)` - Uses `getConnectionHealth()` for accurate status in connect mode
  - `isReady(key)` - Check if Inngest is ready with functions registered
  - Compatible with Kubernetes readiness/liveness probes
  - `@nestjs/terminus` is an optional peer dependency

### Changed

- **Updated to Inngest SDK v3.49.1**: Minimum required version is now v3.49.1
- Health check endpoint now includes detailed connection diagnostics: `wsReadyState`, `pendingHeartbeats`, `usingInternalCheck`
- Module conditionally includes HTTP controller based on connection mode (controller only registered in serve mode)
- `InngestHealthIndicator` now uses internal SDK inspection for reliable health status

### Fixed

- **Stale Connection Detection**: Health checks no longer report "ACTIVE" when WebSocket connection is actually dead
- **Log Spam Prevention**: SDK internal access warnings are now logged only once per service instance

### Documentation

- Added SDK compatibility notes to `getConnectionHealth()` JSDoc (tested with v3.40.2 - v3.49.1)
- Added comprehensive "Connection Modes" section to README
- Updated API Reference with new configuration options and methods
- Added Kubernetes deployment examples for connect mode

## [0.4.3] - 2024-XX-XX

### Changed

- Enhanced environment configuration handling with additional keys for base URL, event key, signing key, and app version

## [0.4.2] - 2024-XX-XX

### Fixed

- Moved testing utilities to separate entry point (`@torixtv/nestjs-inngest/testing`) to prevent production dependency on `@nestjs/testing`

## [0.4.1] - 2024-XX-XX

### Changed

- Enhanced configuration handling with environment variables and manual registration options

## [0.4.0] - 2024-XX-XX

### Added

- Signing key support for function registration
- OpenTelemetry tracing integration
- Health check module with comprehensive health indicators
- Monitoring module with metrics collection

### Changed

- Improved module configuration with Zod validation
- Enhanced auto-registration with dev server

## [0.3.0] - 2024-XX-XX

### Added

- `@InngestCron` decorator for scheduled functions
- `@InngestEvent` decorator for event-triggered functions
- Flow control decorators: `@Throttle`, `@Debounce`, `@RateLimit`, `@Concurrency`, `@Retries`
- `@UseMiddleware` decorator for custom middleware
- Testing utilities: `createInngestTestingModule`, `MockInngestService`, `createMockInngestContext`

## [0.2.0] - 2024-XX-XX

### Added

- `forRootAsync` method for async module configuration
- `forFeature` method for feature modules
- Dependency injection support in function handlers

## [0.1.0] - 2024-XX-XX

### Added

- Initial release
- `InngestModule` with `forRoot` configuration
- `@InngestFunction` decorator
- `InngestService` for sending events
- Basic step function support
