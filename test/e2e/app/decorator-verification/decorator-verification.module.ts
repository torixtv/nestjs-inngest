import { Module } from '@nestjs/common';
import { DecoratorStateService } from './decorator-state.service';
import { DecoratorVerificationController } from './decorator-verification.controller';
import { DecoratorVerificationService } from './decorator-verification.service';

@Module({
  controllers: [DecoratorVerificationController],
  providers: [DecoratorStateService, DecoratorVerificationService],
  exports: [DecoratorStateService],
})
export class DecoratorVerificationModule {}
