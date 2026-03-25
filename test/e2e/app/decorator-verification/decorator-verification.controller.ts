import { Body, Controller, Get, Logger, Post } from '@nestjs/common';
import { InngestService } from '../../../../src';
import { DecoratorStateService } from './decorator-state.service';

@Controller('test/decorators')
export class DecoratorVerificationController {
  private readonly logger = new Logger(DecoratorVerificationController.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly state: DecoratorStateService,
  ) {}

  @Post('reset')
  reset() {
    this.state.reset();
    return { success: true };
  }

  @Get('state')
  stateSnapshot() {
    return this.state.snapshot();
  }

  @Get('config')
  sdkConfigSnapshot() {
    const functions = (((this.inngestService as any).functions || []) as Array<any>)
      .filter((fn) => String(fn?.name || '').startsWith('Decorator Verification'))
      .map((fn) => ({
        name: String(fn?.name || 'unknown'),
        opts: {
          idempotency: fn?.opts?.idempotency,
          optimizeParallelism: fn?.opts?.optimizeParallelism,
          checkpointing: fn?.opts?.checkpointing,
          middlewareCount: Array.isArray(fn?.opts?.middleware) ? fn.opts.middleware.length : 0,
        },
        computed: {
          optimizeParallelism:
            typeof fn?.shouldOptimizeParallelism === 'function'
              ? fn.shouldOptimizeParallelism()
              : undefined,
          checkpointing:
            typeof fn?.shouldAsyncCheckpoint === 'function'
              ? fn.shouldAsyncCheckpoint(false, 'decorator-verification', false)
              : undefined,
        },
      }));

    return { functions };
  }

  @Post('multi-trigger')
  async triggerMultiTrigger(@Body() body: { variant?: 'a' | 'b' }) {
    const variant = body?.variant === 'b' ? 'b' : 'a';
    const eventName =
      variant === 'b' ? 'decorator.verify.multi.b' : 'decorator.verify.multi.a';

    this.logger.log(`Triggering decorator verification event ${eventName}`);

    await this.inngestService.send({
      name: eventName,
      data: {
        variant,
        triggeredAt: new Date().toISOString(),
      },
    });

    return { success: true, eventName };
  }

  @Post('failure')
  async triggerFailure(@Body() body: { message?: string }) {
    const message = body?.message || 'Decorator verification failure';

    this.logger.log('Triggering decorator verification failure event');

    await this.inngestService.send({
      name: 'decorator.verify.failure',
      data: {
        message,
        triggeredAt: new Date().toISOString(),
      },
    });

    return { success: true, message };
  }
}
