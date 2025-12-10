import { Module, DynamicModule, Global, Provider } from '@nestjs/common';
import { ConfigurableModuleBuilder } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  InngestModuleOptions,
  InngestModuleAsyncOptions,
  InngestOptionsFactory,
} from '../interfaces';
import { InngestService } from '../services/inngest.service';
import { InngestExplorer } from '../services/inngest.explorer';
import { createInngestController, InngestController } from '../services/inngest.controller';
import { INNGEST_MODULE_OPTIONS } from '../constants';
import { validateConfig, mergeWithDefaults } from '../config/validation';
import { InngestHealthModule } from '../health/health.module';
import { InngestMonitoringModule } from '../monitoring/monitoring.module';
import { InngestTracingModule } from '../tracing/tracing.module';
import { InngestHealthService } from '../health/health.service';
import { InngestMonitoringService } from '../monitoring/metrics.service';

// Note: We're not using the ConfigurableModuleBuilder pattern anymore
// since we need custom validation logic
// const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
//   new ConfigurableModuleBuilder<InngestModuleOptions>()
//     .setExtras(
//       {
//         isGlobal: false,
//       },
//       (definition, extras) => ({
//         ...definition,
//         global: extras.isGlobal,
//       }),
//     )
//     .setClassMethodName('forRoot')
//     .build();

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [InngestService, InngestExplorer],
  controllers: [InngestController],
  exports: [InngestService],
})
export class InngestModule {
  static forRoot(options: InngestModuleOptions): DynamicModule {
    // Merge with environment defaults and validate
    const mergedOptions = mergeWithDefaults(options);
    const validatedOptions = validateConfig(mergedOptions);

    // Determine if we're in connect mode (no controller needed)
    const isConnectMode = validatedOptions.mode === 'connect';

    // Create dynamic controller with configured path (only for serve mode)
    const controllers = isConnectMode
      ? []
      : [createInngestController(validatedOptions.path)];

    const imports = [DiscoveryModule];

    // Conditionally add health module
    if (validatedOptions.health?.enabled !== false) {
      imports.push(InngestHealthModule);
    }

    // Conditionally add monitoring module
    if (validatedOptions.monitoring?.enabled !== false) {
      imports.push(InngestMonitoringModule);
    }

    // Always add tracing module (it gracefully handles missing OpenTelemetry deps)
    imports.push(InngestTracingModule);

    // Build exports array dynamically based on what's enabled
    const exports: any[] = [InngestService, INNGEST_MODULE_OPTIONS];

    if (validatedOptions.health?.enabled !== false) {
      exports.push(InngestHealthModule);
    }

    if (validatedOptions.monitoring?.enabled !== false) {
      exports.push(InngestMonitoringModule);
    }

    // Always export tracing module
    exports.push(InngestTracingModule);

    return {
      module: InngestModule,
      global: validatedOptions.isGlobal ?? false,
      imports,
      providers: [
        {
          provide: INNGEST_MODULE_OPTIONS,
          useValue: validatedOptions,
        },
        InngestService,
        InngestExplorer,
      ],
      controllers, // Empty array for connect mode, controller for serve mode
      exports,
    };
  }

  /**
   * Async configuration for InngestModule
   *
   * Note: For forRootAsync, the controller is always included because the mode
   * is not known at module definition time. In connect mode, the controller
   * endpoints simply won't be called by Inngest (it uses WebSocket instead).
   * This has no performance impact - the routes just exist but are unused.
   */
  static forRootAsync(options: InngestModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [];

    if (options.useFactory) {
      providers.push({
        provide: INNGEST_MODULE_OPTIONS,
        useFactory: async (...args: any[]) => {
          const config = await options.useFactory!(...args);
          const mergedConfig = mergeWithDefaults(config);
          return validateConfig(mergedConfig);
        },
        inject: options.inject || [],
      });
    } else if (options.useClass) {
      providers.push(
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: INNGEST_MODULE_OPTIONS,
          useFactory: async (optionsFactory: InngestOptionsFactory) => {
            const config = await optionsFactory.createInngestOptions();
            const mergedConfig = mergeWithDefaults(config);
            return validateConfig(mergedConfig);
          },
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      providers.push({
        provide: INNGEST_MODULE_OPTIONS,
        useFactory: async (optionsFactory: InngestOptionsFactory) => {
          const config = await optionsFactory.createInngestOptions();
          const mergedConfig = mergeWithDefaults(config);
          return validateConfig(mergedConfig);
        },
        inject: [options.useExisting],
      });
    }

    // Always include health, monitoring, and tracing modules for async configurations (health/monitoring can be disabled via config)
    const imports = [
      DiscoveryModule,
      InngestHealthModule,
      InngestMonitoringModule,
      InngestTracingModule,
      ...(options.imports || []),
    ];

    return {
      module: InngestModule,
      global: options.isGlobal ?? false,
      imports,
      providers: [...providers, InngestService, InngestExplorer],
      controllers: [InngestController],
      exports: [
        InngestService,
        INNGEST_MODULE_OPTIONS,
        InngestHealthModule,
        InngestMonitoringModule,
        InngestTracingModule,
      ],
    };
  }

  static forFeature(): DynamicModule {
    return {
      module: InngestModule,
      imports: [DiscoveryModule],
      providers: [InngestExplorer],
      exports: [],
    };
  }
}
