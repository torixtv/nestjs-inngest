import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestService, 
  InngestFunction, 
  InngestCron, 
  InngestEvent,
  UseMiddleware,
  Concurrency,
  RateLimit,
  Retries
} from '../../src';
import { Middleware } from 'inngest';
import { createUserEvent } from '../../src/utils/types';

// Define your event types for better type safety
interface UserEvents {
  'user.created': {
    data: {
      userId: string;
      email: string;
      name: string;
    };
  };
  'user.updated': {
    data: {
      userId: string;
      changes: Record<string, any>;
    };
  };
  'user.deleted': {
    data: {
      userId: string;
    };
  };
}

class LoggingMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'request-logging';

  override transformFunctionInput(arg: Middleware.TransformFunctionInputArgs) {
    console.log(`🚀 [MIDDLEWARE] Starting function: ${arg.fn.id()}`);
    console.log(`📦 [MIDDLEWARE] Event data:`, JSON.stringify(arg.ctx.event, null, 2));

    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        middlewareExecuted: [
          ...(((arg.ctx as any).middlewareExecuted as string[] | undefined) || []),
          'logging',
        ],
      } as typeof arg.ctx,
    };
  }
}

class ValidationMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'event-validation';

  override transformFunctionInput(arg: Middleware.TransformFunctionInputArgs) {
    console.log(`🔍 [MIDDLEWARE] Validating event for function: ${arg.fn.id()}`);

    if (!arg.ctx.event.data) {
      throw new Error('Event data is required');
    }

    console.log(`✅ [MIDDLEWARE] Event validated successfully`);

    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        middlewareExecuted: [
          ...(((arg.ctx as any).middlewareExecuted as string[] | undefined) || []),
          'validation',
        ],
        validatedAt: new Date().toISOString(),
      } as typeof arg.ctx,
    };
  }
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly inngestService: InngestService) {}

  // Event-triggered function with step-based workflow
  @InngestFunction({
    id: 'onboard-new-user',
    name: 'Onboard New User',
    triggers: { event: 'user.created' },
  })
  @Concurrency(5) // Limit to 5 concurrent executions
  async onboardNewUser({ event, step }: { event: UserEvents['user.created']; step: any }) {
    const { userId, email, name } = event.data;

    this.logger.log(`Starting onboarding for user: ${userId}`);

    // Step 1: Send welcome email
    await step.run('send-welcome-email', async () => {
      this.logger.log(`Sending welcome email to: ${email}`);
      // Simulate email sending
      await this.simulateDelay(1000);
      return { emailSent: true };
    });

    // Step 2: Create user profile
    const profile = await step.run('create-user-profile', async () => {
      this.logger.log(`Creating profile for: ${userId}`);
      await this.simulateDelay(500);
      return {
        profileId: `profile-${userId}`,
        createdAt: new Date(),
      };
    });

    // Step 3: Set up initial preferences
    await step.run('setup-preferences', async () => {
      this.logger.log(`Setting up preferences for: ${userId}`);
      await this.simulateDelay(300);
      return { preferencesSet: true };
    });

    // Step 4: Wait for user verification (with timeout)
    const verification = await step.waitForEvent('wait-for-verification', {
      event: 'user.verified',
      timeout: '7d',
      match: 'data.userId',
    });

    if (verification) {
      // Step 5: Complete onboarding
      await step.run('complete-onboarding', async () => {
        this.logger.log(`Completing onboarding for verified user: ${userId}`);
        await this.simulateDelay(200);
        return { onboardingComplete: true };
      });

      // Send completion event
      await step.sendEvent('send-completion-event', {
        name: 'user.onboarding.completed',
        data: { userId, profileId: profile.profileId },
      });
    } else {
      this.logger.warn(`User verification timeout for: ${userId}`);
    }

    return {
      success: verification !== null,
      userId,
      profileId: profile.profileId,
    };
  }

  // Rate-limited function for user updates
  @InngestEvent('process-user-update', 'user.updated')
  @RateLimit(100, '1m') // Max 100 updates per minute
  async processUserUpdate({ event, step }: { event: UserEvents['user.updated']; step: any }) {
    const { userId, changes } = event.data;

    this.logger.log(`Processing update for user: ${userId}`);

    // Step 1: Validate changes
    const validation = await step.run('validate-changes', async () => {
      // Simulate validation logic
      await this.simulateDelay(200);
      return { valid: true, processedFields: Object.keys(changes) };
    });

    if (!validation.valid) {
      throw new Error('Invalid user update data');
    }

    // Step 2: Update user record
    await step.run('update-user-record', async () => {
      this.logger.log(`Updating user record: ${userId}`);
      await this.simulateDelay(300);
      return { updated: true };
    });

    // Step 3: Send update notification
    await step.sendEvent('send-update-notification', {
      name: 'notification.user.updated',
      data: { userId, changes: validation.processedFields },
    });

    return { success: true, userId };
  }

  // Scheduled cleanup function
  @InngestCron('cleanup-inactive-users', '0 2 * * *') // Daily at 2 AM
  async cleanupInactiveUsers({ event, step }: { event: any; step: any }) {
    this.logger.log('Starting cleanup of inactive users');

    // Step 1: Find inactive users
    const inactiveUsers = await step.run('find-inactive-users', async () => {
      // Simulate database query
      await this.simulateDelay(1000);
      return [
        { userId: 'user1', lastActive: '2024-01-01' },
        { userId: 'user2', lastActive: '2024-01-15' },
      ];
    });

    // Step 2: Process each inactive user
    for (const user of inactiveUsers) {
      await step.run(`cleanup-user-${user.userId}`, async () => {
        this.logger.log(`Cleaning up inactive user: ${user.userId}`);
        await this.simulateDelay(500);
        return { cleaned: true };
      });
    }

    this.logger.log(`Cleanup completed. Processed ${inactiveUsers.length} inactive users`);
    return { cleanedUsers: inactiveUsers.length };
  }

  // Integration test function with middleware
  @InngestFunction({
    id: 'middleware-test-function',
    name: 'Test Function with Middleware',
    triggers: { event: 'test.middleware' },
  })
  @UseMiddleware(LoggingMiddleware, ValidationMiddleware)
  @Retries(2)
  @Concurrency(3)
  async testMiddleware({ event, step, ctx }: { event: any; step: any; ctx: any }) {
    this.logger.log(`🎯 Handler started for middleware test`);
    
    // Log what middleware executed
    this.logger.log(`🔗 Middleware executed: ${JSON.stringify(ctx.middlewareExecuted)}`);
    this.logger.log(`📅 Validated at: ${ctx.validatedAt}`);
    
    // Step 1: Process with middleware context
    const result = await step.run('process-with-middleware', async () => {
      this.logger.log(`🔄 Processing with middleware context available`);
      await this.simulateDelay(100);
      
      return {
        middlewareWorked: true,
        middlewareExecuted: ctx.middlewareExecuted,
        validatedAt: ctx.validatedAt,
        eventData: event.data,
      };
    });
    
    // Step 2: Send confirmation event
    await step.sendEvent('send-middleware-confirmation', {
      name: 'test.middleware.completed',
      data: {
        originalEventId: event.id,
        middlewareResult: result,
        processingComplete: true,
      },
    });
    
    this.logger.log(`✅ Middleware test function completed successfully`);
    
    return {
      success: true,
      middlewareExecuted: ctx.middlewareExecuted,
      validatedAt: ctx.validatedAt,
      result,
    };
  }

  // Helper method to test middleware functionality
  async testMiddlewareFunction() {
    const testEventId = `test-${Date.now()}`;
    
    // Send test event to trigger middleware function
    await this.inngestService.send({
      name: 'test.middleware',
      data: {
        testId: testEventId,
        message: 'Testing middleware functionality',
        timestamp: new Date().toISOString(),
      },
    });

    this.logger.log(`🧪 Middleware test event sent: ${testEventId}`);
    return { testEventId };
  }

  // Helper method to create users (demonstrates sending events)
  async createUser(userData: { email: string; name: string }) {
    const userId = `user-${Date.now()}`;
    
    // Send user created event with proper user context
    const event = createUserEvent(
      'user.created',
      {},
      {
        userId,
        email: userData.email,
        name: userData.name,
        role: 'user',
      },
    );
    
    await this.inngestService.send(event);

    this.logger.log(`User created: ${userId}`);
    return { userId, ...userData };
  }

  // Helper method to simulate async operations
  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
