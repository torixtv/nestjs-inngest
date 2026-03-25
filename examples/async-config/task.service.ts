import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestFunction, 
  InngestCron,
  Retries,
  InngestService 
} from '../../src';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(private readonly inngestService: InngestService) {}

  // Complex workflow with multiple steps and error handling
  @InngestFunction({
    id: 'process-data-pipeline',
    triggers: { event: 'data.pipeline.start' },
  })
  @Retries(3)
  async processDataPipeline({ event, step }: { event: any; step: any }) {
    const { pipelineId, dataSource } = event.data;

    this.logger.log(`Starting data pipeline: ${pipelineId}`);

    try {
      // Step 1: Validate data source
      const validation = await step.run('validate-data-source', async () => {
        this.logger.log(`Validating data source: ${dataSource}`);
        await this.delay(500);
        
        if (dataSource === 'invalid') {
          throw new Error('Invalid data source provided');
        }
        
        return { valid: true, recordCount: 1000 };
      });

      // Step 2: Extract data
      const extractedData = await step.run('extract-data', async () => {
        this.logger.log(`Extracting ${validation.recordCount} records`);
        await this.delay(2000);
        return {
          records: validation.recordCount,
          extractedAt: new Date(),
        };
      });

      // Step 3: Transform data
      const transformedData = await step.run('transform-data', async () => {
        this.logger.log(`Transforming ${extractedData.records} records`);
        await this.delay(3000);
        return {
          ...extractedData,
          transformedRecords: extractedData.records * 0.95, // Some records might be filtered
          transformedAt: new Date(),
        };
      });

      // Step 4: Load data
      await step.run('load-data', async () => {
        this.logger.log(`Loading ${transformedData.transformedRecords} records`);
        await this.delay(1500);
        return { loaded: true, loadedAt: new Date() };
      });

      // Step 5: Send success notification
      await step.sendEvent('send-success-notification', {
        name: 'data.pipeline.completed',
        data: {
          pipelineId,
          success: true,
          recordsProcessed: transformedData.transformedRecords,
        },
      });

      return {
        success: true,
        pipelineId,
        recordsProcessed: transformedData.transformedRecords,
      };

    } catch (error) {
      this.logger.error(`Pipeline error: ${error.message}`, error.stack);
      
      // Send failure notification
      await step.sendEvent('send-failure-notification', {
        name: 'data.pipeline.failed',
        data: {
          pipelineId,
          success: false,
          error: error.message,
        },
      });

      throw error; // Re-throw to trigger retries
    }
  }

  // Scheduled health check
  @InngestCron('health-check', '*/5 * * * *') // Every 5 minutes
  async performHealthCheck({ event, step }: { event: any; step: any }) {
    this.logger.log('Performing system health check');

    // Step 1: Check database connectivity
    const dbHealth = await step.run('check-database', async () => {
      await this.delay(200);
      return {
        status: Math.random() > 0.1 ? 'healthy' : 'unhealthy',
        responseTime: Math.floor(Math.random() * 100),
      };
    });

    // Step 2: Check external APIs
    const apiHealth = await step.run('check-external-apis', async () => {
      await this.delay(300);
      return {
        status: Math.random() > 0.05 ? 'healthy' : 'unhealthy',
        checkedServices: ['payment-service', 'notification-service'],
      };
    });

    // Step 3: Check system resources
    const resourceHealth = await step.run('check-system-resources', async () => {
      await this.delay(100);
      return {
        cpuUsage: Math.floor(Math.random() * 100),
        memoryUsage: Math.floor(Math.random() * 100),
        diskUsage: Math.floor(Math.random() * 100),
      };
    });

    const overallHealth = 
      dbHealth.status === 'healthy' && 
      apiHealth.status === 'healthy' &&
      resourceHealth.cpuUsage < 80 &&
      resourceHealth.memoryUsage < 80;

    // Step 4: Send alert if unhealthy
    if (!overallHealth) {
      await step.sendEvent('send-health-alert', {
        name: 'system.health.alert',
        data: {
          status: 'unhealthy',
          checks: {
            database: dbHealth,
            apis: apiHealth,
            resources: resourceHealth,
          },
          timestamp: new Date(),
        },
      });
    }

    return {
      status: overallHealth ? 'healthy' : 'unhealthy',
      checks: {
        database: dbHealth,
        apis: apiHealth,
        resources: resourceHealth,
      },
    };
  }

  // Manual trigger for data pipeline
  async startDataPipeline(dataSource: string) {
    const pipelineId = `pipeline-${Date.now()}`;
    
    await this.inngestService.send({
      name: 'data.pipeline.start',
      data: {
        pipelineId,
        dataSource,
        triggeredBy: 'manual',
        startedAt: new Date(),
      },
    });

    this.logger.log(`Data pipeline started: ${pipelineId}`);
    return { pipelineId };
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
