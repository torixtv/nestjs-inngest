import { z } from 'zod';
import { InngestModuleOptions, InngestModuleAsyncOptions } from '../interfaces';

/**
 * Base configuration validation schema
 */
export const InngestConfigSchema = z.object({
  id: z.string().min(1, 'App ID is required'),
  eventKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  isGlobal: z.boolean().default(false),
  middleware: z.array(z.any()).optional(),
  clientOptions: z.object({}).passthrough().optional(),
  path: z.string().default('/api/inngest'),
  servePort: z.number().min(1).max(65535).optional(),
  serveHost: z.string().optional(),
  signingKey: z.string().optional(),
  logger: z.any().optional(),

  // Environment configuration
  environment: z.enum(['development', 'staging', 'production', 'test']).default('development'),

  // Monitoring configuration
  monitoring: z
    .object({
      enabled: z.boolean(),
      collectMetrics: z.boolean(),
      metricsInterval: z.number().min(1000),
      healthCheckInterval: z.number().min(1000),
      enableTracing: z.boolean(),
      tracingConfig: z
        .object({
          serviceName: z.string().optional(),
          spanProcessor: z.enum(['simple', 'batch']),
          exporterType: z.enum(['console', 'jaeger', 'zipkin', 'otlp']),
          exporterConfig: z.object({}).passthrough().optional(),
        })
        .optional(),
    })
    .optional(),

  // Performance configuration (minimal - only memoryLimit implemented)
  performance: z
    .object({
      memoryLimit: z.number().min(128).optional(),
    })
    .optional(),

  // Health check configuration
  health: z
    .object({
      enabled: z.boolean(),
      path: z.string(),
      includeDetails: z.boolean(),
      enableMetrics: z.boolean(),
      enableLiveness: z.boolean(),
      enableReadiness: z.boolean(),
      checkInterval: z.number().min(1000),
    })
    .optional(),

  // Tracing configuration
  tracing: z
    .object({
      enabled: z.boolean().optional(),
      includeEventData: z.boolean().optional(),
      includeStepData: z.boolean().optional(),
      defaultAttributes: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
      contextInjection: z
        .object({
          enabled: z.boolean().optional(),
          fieldName: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Environment-specific configuration validation
 */
export const DevelopmentConfigSchema = InngestConfigSchema.extend({
  environment: z.enum(['development', 'test']),
  baseUrl: z.string().url().default('http://localhost:8288'),
  monitoring: z
    .object({
      enabled: z.boolean().default(true),
      collectMetrics: z.boolean().default(true),
      metricsInterval: z.number().default(10000), // More frequent in dev
      healthCheckInterval: z.number().default(5000),
      enableTracing: z.boolean().default(true),
    })
    .optional(),
});

export const ProductionConfigSchema = InngestConfigSchema.extend({
  environment: z.literal('production'),
  eventKey: z.string().min(1, 'Event key is required in production'),
  signingKey: z.string().min(1, 'Signing key is required in production'),
  monitoring: z
    .object({
      enabled: z.literal(true),
      collectMetrics: z.literal(true),
      enableTracing: z.boolean().default(true),
    })
    .required(),
});

/**
 * Validate configuration based on environment
 */
export function validateConfig(config: any): InngestModuleOptions {
  try {
    // Determine which schema to use based on environment
    const env = config.environment || process.env.NODE_ENV || 'development';

    let schema: z.ZodSchema<any>;
    switch (env) {
      case 'production':
        schema = ProductionConfigSchema;
        break;
      case 'development':
      case 'test':
        schema = DevelopmentConfigSchema;
        break;
      default:
        schema = InngestConfigSchema;
    }

    const validated = schema.parse(config);

    // Additional business logic validation
    if (validated.performance?.memoryLimit && validated.performance.memoryLimit < 128) {
      throw new Error('Memory limit must be at least 128MB');
    }

    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid Inngest configuration: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Create environment-specific default configurations
 */
export const createDefaultConfig = (
  environment: 'development' | 'staging' | 'production' | 'test' = 'development',
): Partial<InngestModuleOptions> => {
  const baseConfig = {
    environment,
    isGlobal: true,
    path: '/api/inngest',
  };

  switch (environment) {
    case 'development':
    case 'test':
      return {
        ...baseConfig,
        baseUrl: 'http://localhost:8288',
        monitoring: {
          enabled: true,
          collectMetrics: true,
          metricsInterval: 10000,
          healthCheckInterval: 5000,
          enableTracing: true,
        },
      };

    case 'production':
      return {
        ...baseConfig,
        monitoring: {
          enabled: true,
          collectMetrics: true,
          metricsInterval: 30000,
          healthCheckInterval: 10000,
          enableTracing: true,
        },
      };

    default:
      return baseConfig;
  }
};

/**
 * Read configuration values from environment variables
 * These act as fallbacks between defaults and explicit config
 */
function readEnvironmentConfig(): Partial<InngestModuleOptions> {
  const envConfig: Partial<InngestModuleOptions> = {};

  // Read baseUrl from INNGEST_BASE_URL
  if (process.env.INNGEST_BASE_URL) {
    envConfig.baseUrl = process.env.INNGEST_BASE_URL;
  }

  // Read eventKey from INNGEST_EVENT_KEY
  if (process.env.INNGEST_EVENT_KEY) {
    envConfig.eventKey = process.env.INNGEST_EVENT_KEY;
  }

  // Read signingKey from INNGEST_SIGNING_KEY
  if (process.env.INNGEST_SIGNING_KEY) {
    envConfig.signingKey = process.env.INNGEST_SIGNING_KEY;
  }

  // Read servePort from INNGEST_SERVE_PORT or PORT
  if (process.env.INNGEST_SERVE_PORT) {
    const port = parseInt(process.env.INNGEST_SERVE_PORT, 10);
    if (!isNaN(port)) {
      envConfig.servePort = port;
    }
  } else if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    if (!isNaN(port)) {
      envConfig.servePort = port;
    }
  }

  // Read serveHost from INNGEST_SERVE_HOST
  if (process.env.INNGEST_SERVE_HOST) {
    envConfig.serveHost = process.env.INNGEST_SERVE_HOST;
  }

  // Read path from INNGEST_PATH
  if (process.env.INNGEST_PATH) {
    envConfig.path = process.env.INNGEST_PATH;
  }

  // Read appVersion from INNGEST_APP_VERSION or npm_package_version
  if (process.env.INNGEST_APP_VERSION) {
    if (!envConfig.clientOptions) {
      envConfig.clientOptions = {};
    }
    envConfig.clientOptions.appVersion = process.env.INNGEST_APP_VERSION;
  } else if (process.env.npm_package_version) {
    if (!envConfig.clientOptions) {
      envConfig.clientOptions = {};
    }
    envConfig.clientOptions.appVersion = process.env.npm_package_version;
  }

  return envConfig;
}

/**
 * Merge user configuration with environment defaults
 * Configuration precedence (highest to lowest):
 * 1. Explicit userConfig
 * 2. Environment variables:
 *    - INNGEST_BASE_URL: Base URL for Inngest server
 *    - INNGEST_EVENT_KEY: Event key for sending events
 *    - INNGEST_SIGNING_KEY: Signing key for authentication
 *    - INNGEST_SERVE_PORT or PORT: Port where app is running
 *    - INNGEST_SERVE_HOST: Host where app is accessible
 *    - INNGEST_PATH: Path for Inngest endpoint
 *    - INNGEST_APP_VERSION or npm_package_version: Application version
 * 3. Package defaults
 */
export function mergeWithDefaults(userConfig: any, environment?: string): any {
  const env = environment || userConfig.environment || process.env.NODE_ENV || 'development';
  const defaults = createDefaultConfig(env as any);
  const envConfig = readEnvironmentConfig();

  // Apply precedence: defaults < envConfig < userConfig
  // Special handling for nested clientOptions to preserve env vars like appVersion
  const merged = {
    ...defaults,
    ...envConfig,
    ...userConfig,
    environment: env,
  };

  // Deep merge clientOptions to preserve env-based values unless explicitly overridden
  if (defaults.clientOptions || envConfig.clientOptions || userConfig.clientOptions) {
    merged.clientOptions = {
      ...defaults.clientOptions,
      ...envConfig.clientOptions,
      ...userConfig.clientOptions,
    };
  }

  return merged;
}
