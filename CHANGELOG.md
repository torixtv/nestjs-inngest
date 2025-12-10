# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2024-XX-XX

### Added

- **Connect Mode Support**: New `mode` configuration option to switch between HTTP webhooks (`serve`) and WebSocket-based (`connect`) communication with Inngest
  - `mode: 'serve'` (default) - Traditional HTTP webhook-based approach where Inngest calls your app
  - `mode: 'connect'` - Persistent WebSocket connection where your app connects to Inngest
- **Connect Mode Options**: New `connect` configuration object with the following options:
  - `instanceId` - Unique identifier for the worker instance (auto-generated UUID if not provided)
  - `maxConcurrency` - Maximum concurrent function executions
  - `shutdownTimeout` - Time in milliseconds to wait for graceful shutdown (default: 30000)
  - `handleShutdownSignals` - Array of process signals to handle for graceful shutdown (default: `['SIGTERM', 'SIGINT']`)
- **Connection State API**: New methods on `InngestService`:
  - `getConnectionState()` - Returns current connection state (`'ACTIVE'`, `'CONNECTING'`, `'RECONNECTING'`, `'PAUSED'`, `'CLOSING'`, `'CLOSED'`, or `'NOT_APPLICABLE'` for serve mode)
  - `isConnected()` - Returns `true` only when connection state is `'ACTIVE'`
- **Environment Variable Support**: `INNGEST_MODE` environment variable to configure connection mode
- **Connection-Aware Health Checks**: Health service now reports connection state when using connect mode
- **Graceful Shutdown**: Automatic handling of shutdown signals in connect mode with configurable timeout
- **Type Exports**: New exports for `InngestConnectionMode`, `InngestConnectOptions`, and `ConnectOptionsSchema`
- **@nestjs/terminus Integration**: New `InngestHealthIndicator` for use with `@nestjs/terminus` health checks
  - `isHealthy(key)` - Check if Inngest client is healthy (connection state for connect mode)
  - `isReady(key)` - Check if Inngest is ready with functions registered
  - Compatible with Kubernetes readiness/liveness probes
  - `@nestjs/terminus` is an optional peer dependency

### Changed

- Health check endpoint now includes `mode` and `connectionState` fields when applicable
- Module conditionally includes HTTP controller based on connection mode (controller only registered in serve mode)

### Documentation

- Added comprehensive "Connection Modes" section to README
- Updated API Reference with new configuration options and methods
- Added Kubernetes deployment examples for connect mode
- Updated Configuration Options table with `mode` and `connect` options

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
