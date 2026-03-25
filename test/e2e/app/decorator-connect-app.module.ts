import { Global, Logger, Module } from '@nestjs/common';
import { InngestModule } from '../../../src';
import { DecoratorVerificationModule } from './decorator-verification/decorator-verification.module';

@Global()
@Module({
  imports: [
    InngestModule.forRoot({
      id: 'nestjs-integration-connect-test-v4',
      baseUrl: 'http://localhost:8288',
      eventKey: 'test-event-key',
      signingKey: undefined,
      isGlobal: true,
      logger: undefined,
      mode: 'connect',
      disableAutoRegistration: true,
      clientOptions: {
        isDev: true,
      },
      connect: {
        instanceId: 'decorator-connect-worker',
        handleShutdownSignals: [],
        isolateExecution: false,
      },
    }),
    DecoratorVerificationModule,
  ],
})
export class DecoratorConnectAppModule {
  private readonly logger = new Logger(DecoratorConnectAppModule.name);

  constructor() {
    this.logger.log('Decorator connect test app initialized', {
      appType: 'e2e-connect-test',
      clientId: 'nestjs-integration-connect-test-v4',
    });
  }
}
