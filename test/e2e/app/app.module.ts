import { Module, Logger, Global } from '@nestjs/common';
import { InngestModule } from '../../../src/index';

// Feature modules
import { UserModule } from './user/user.module';
import { NotificationModule } from './notification/notification.module';
import { HealthModule } from './health/health.module';
import { MiddlewareModule } from './middleware/middleware.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { TestModule } from './test/test.module';
import { DecoratorVerificationModule } from './decorator-verification/decorator-verification.module';

// Test controller
import { TestController } from './test.controller';

@Global()
@Module({
  imports: [
    // Configure Inngest to connect to local dev server
    InngestModule.forRoot({
      id: 'nestjs-integration-test-v4',
      
      // Connect to local Inngest dev server
      baseUrl: 'http://localhost:8288',
      serveOrigin: 'http://127.0.0.1:3101',
      servePort: 3101,
      path: 'inngest',
      servePath: 'api/inngest',
      
      // No signing key needed for local development
      signingKey: undefined,
      
      // Inngest v4 requires an event key even against the local dev server
      eventKey: 'test-event-key',
      
      // Make module global so all services can use InngestService
      isGlobal: true,
      
      // Use NestJS logger instead of console
      logger: undefined,
      
      // Additional client options
      clientOptions: {
        isDev: true,
      },
      
      // Enable tracing for e2e testing
      tracing: {
        enabled: true,
        includeEventData: false,
        includeStepData: false,
        defaultAttributes: {
          'test.environment': 'e2e',
          'test.app': 'nestjs-inngest'
        },
        contextInjection: {
          enabled: true,
          fieldName: 'traceContext'
        }
      },
    }),
    
    // Feature modules
    UserModule,
    NotificationModule,
    HealthModule,
    MiddlewareModule,
    MonitoringModule,
    TestModule,
    DecoratorVerificationModule,
  ],
  controllers: [TestController],
})
export class AppModule {
  private readonly logger = new Logger(AppModule.name);

  constructor() {
    this.logger.log('NestJS Integration Test App initialized', {
      appType: 'e2e-test',
      port: 3001
    });
    this.logger.log('Inngest module configured for local dev server', {
      devServerUrl: 'localhost:8288',
      clientId: 'nestjs-integration-test-v4'
    });
    this.logger.log('Inngest function discovery enabled', {
      autoDiscovery: true,
      tracingEnabled: true
    });
  }
}
