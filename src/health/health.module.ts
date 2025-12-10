import { Module } from '@nestjs/common';
import { InngestHealthService } from './health.service';

/**
 * Health module that provides InngestHealthService
 *
 * Note: InngestHealthIndicator is exported separately and requires @nestjs/terminus.
 * Users who want to use InngestHealthIndicator should:
 * 1. Import TerminusModule in their health module
 * 2. Add InngestHealthIndicator to their providers
 *
 * @example
 * ```typescript
 * import { Module } from '@nestjs/common';
 * import { TerminusModule } from '@nestjs/terminus';
 * import { InngestHealthIndicator } from '@torixtv/nestjs-inngest';
 *
 * @Module({
 *   imports: [TerminusModule],
 *   providers: [InngestHealthIndicator],
 * })
 * export class HealthModule {}
 * ```
 */
@Module({
  providers: [InngestHealthService],
  exports: [InngestHealthService],
})
export class InngestHealthModule {}
