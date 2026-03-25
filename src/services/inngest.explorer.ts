import { Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InngestService } from './inngest.service';
import { InngestMonitoringService } from '../monitoring/metrics.service';
import {
  INNGEST_FUNCTION_METADATA,
  INNGEST_HANDLER_METADATA,
  INNGEST_MIDDLEWARE_METADATA,
} from '../constants';
import { InngestFunctionConfig, InngestFunctionMetadata } from '../interfaces';

@Injectable()
export class InngestExplorer implements OnModuleInit {
  private readonly logger = new Logger(InngestExplorer.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly inngestService: InngestService,
    @Optional() private readonly monitoringService?: InngestMonitoringService,
  ) {}

  async onModuleInit() {
    this.logger.log('🔍 Starting Inngest function discovery...');
    await this.explore();
  }

  async explore() {
    try {
      this.logger.log('📡 Starting function discovery with DiscoveryService...');

      const providers = this.discoveryService.getProviders();
      const controllers = this.discoveryService.getControllers();
      const instances = [...providers, ...controllers];

      this.logger.log(`🔎 Found ${instances.length} instances to scan`);

      let functionsFound = 0;
      for (const wrapper of instances) {
        const { instance } = wrapper;
        if (!instance || !Object.getPrototypeOf(instance)) {
          continue;
        }

        const functionCount = await this.lookupFunctions(instance);
        functionsFound += functionCount;
      }

      this.logger.log(
        `✅ Function discovery complete. Found ${functionsFound} decorated functions`,
      );
    } catch (error) {
      this.logger.error('Failed to explore functions:', error.message, error.stack);
    }
  }

  async lookupFunctions(instance: any): Promise<number> {
    const prototype = Object.getPrototypeOf(instance);
    const methodNames = this.metadataScanner.getAllMethodNames(prototype);

    let functionCount = 0;
    for (const methodName of methodNames) {
      const wasRegistered = await this.registerFunction(instance, prototype, methodName);
      if (wasRegistered) {
        functionCount++;
      }
    }
    return functionCount;
  }

  private resolveOnFailureHandler(
    instance: any,
    prototype: any,
    methodName: string,
    onFailureMethod?: string | symbol,
  ) {
    if (!onFailureMethod) {
      return undefined;
    }

    const failureHandler = prototype[onFailureMethod];
    if (typeof failureHandler !== 'function') {
      throw new Error(
        `@OnFailure on ${methodName} references missing method "${String(onFailureMethod)}"`,
      );
    }

    return failureHandler.bind(instance);
  }

  private async registerFunction(
    instance: any,
    prototype: any,
    methodName: string,
  ): Promise<boolean> {
    const functionMetadata: InngestFunctionMetadata = Reflect.getMetadata(
      INNGEST_FUNCTION_METADATA,
      prototype,
      methodName,
    );

    if (!functionMetadata) {
      return false;
    }

    const { config } = functionMetadata;
    const handler = prototype[methodName];

    if (!handler) {
      this.logger.warn(`Handler not found for function: ${methodName}`);
      return false;
    }

    try {
      // Extract @UseMiddleware decorator middleware
      const middlewareFromDecorator =
        Reflect.getMetadata(INNGEST_MIDDLEWARE_METADATA, prototype, methodName) || [];

      // The functionMetadata should already contain all the middleware decorator data
      // since they modify the same metadata object

      // Merge all configuration including middleware decorator metadata
      // Extract core metadata properties and spread the rest as middleware properties
      const {
        target,
        propertyKey,
        config: metadataConfig,
        onFailureMethod,
        ...middlewareProperties
      } = functionMetadata;
      const onFailure = this.resolveOnFailureHandler(
        instance,
        prototype,
        methodName,
        onFailureMethod,
      );
      const configMiddleware = config.middleware || [];
      const functionMiddleware = [...configMiddleware, ...middlewareFromDecorator];

      const fullConfig: InngestFunctionConfig = {
        id: config.id || `${instance.constructor.name}.${methodName}`,
        name: config.name || methodName,
        ...config,
        // Apply all middleware decorator properties generically
        ...middlewareProperties,
        ...(functionMiddleware.length > 0 && { middleware: functionMiddleware }),
        ...(onFailure && { onFailure }),
      };

      // Create the Inngest function with proper binding and monitoring
      const inngestFunction = this.inngestService.createFunction(
        fullConfig,
        async (inngestContext: any) => {
          const functionId = fullConfig.id || `${instance.constructor.name}.${methodName}`;
          const startTime = Date.now();
          let success = false;
          let error: Error | undefined;

          try {
            // Extract standard parameters from Inngest context
            const { event, step } = inngestContext;

            // Bind the handler to the instance to maintain 'this' context
            const boundHandler = handler.bind(instance);

            // Check if the handler expects individual parameters or a context object
            const handlerMetadata = Reflect.getMetadata(
              INNGEST_HANDLER_METADATA,
              prototype,
              methodName,
            );

            // Create enhanced context with ALL middleware properties dynamically
            // Extract only middleware-added properties (exclude standard Inngest context keys)
            const standardInngestKeys = ['event', 'step', 'events', 'runId', 'attempt', 'logger'];
            const middlewareProperties = Object.fromEntries(
              Object.entries(inngestContext).filter(([key]) => !standardInngestKeys.includes(key)),
            );

            // The inngestContext already contains all middleware enhancements
            // We just need to extract the non-standard properties for the ctx parameter
            const enhancedCtx = middlewareProperties;

            let result;
            if (handlerMetadata?.useContext) {
              // Pass as context object with enhanced context
              result = await boundHandler({ event, step, ctx: enhancedCtx });
            } else {
              // Pass as individual parameters with enhanced context
              result = await boundHandler(event, step, enhancedCtx);
            }

            success = true;
            return result;
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err));
            success = false;
            throw error;
          } finally {
            const executionTime = Date.now() - startTime;

            // Record metrics if monitoring service is available
            if (this.monitoringService) {
              try {
                this.monitoringService.recordFunctionExecution(
                  functionId,
                  executionTime,
                  success,
                  error,
                );
              } catch (metricsError) {
                this.logger.error(
                  `Failed to record metrics for ${functionId}: ${metricsError.message}`,
                );
              }
            }

            // Log execution details
            const logLevel = success ? 'log' : 'error';
            this.logger[logLevel](
              `Function ${functionId} executed in ${executionTime}ms (success: ${success})${
                error ? ` - Error: ${error.message}` : ''
              }`,
            );
          }
        },
      );

      // Register function with monitoring service for tracking
      if (this.monitoringService) {
        try {
          const configuredFunctionId = fullConfig.id || `${instance.constructor.name}.${methodName}`;
          this.monitoringService.registerFunction(
            configuredFunctionId,
            fullConfig.name || methodName,
            fullConfig,
          );
        } catch (monitoringError) {
          this.logger.error(
            `Failed to register function with monitoring service: ${monitoringError.message}`,
          );
        }
      }

      this.logger.log(
        `✅ Registered Inngest function: ${inngestFunction.id} from ${instance.constructor.name}.${methodName}`,
      );
      this.logger.log(`🔧 Function config: ${JSON.stringify(fullConfig, null, 2)}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to register function ${methodName}: ${error.message}`, error.stack);
      return false;
    }
  }
}
