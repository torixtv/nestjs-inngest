import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestFunction, 
  Throttle, 
  Debounce 
} from '../../src';

interface NotificationEvents {
  'notification.user.updated': {
    data: {
      userId: string;
      changes: string[];
    };
  };
  'notification.email.send': {
    data: {
      to: string;
      subject: string;
      template: string;
      data: Record<string, any>;
    };
  };
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  // Throttled notification processor
  @InngestFunction({
    id: 'process-user-update-notification',
    triggers: { event: 'notification.user.updated' },
  })
  @Throttle(50, '1m') // Max 50 notifications per minute with burst support
  async processUserUpdateNotification({ 
    event, 
    step 
  }: { 
    event: NotificationEvents['notification.user.updated']; 
    step: any;
  }) {
    const { userId, changes } = event.data;

    this.logger.log(`Processing update notification for user: ${userId}`);

    // Step 1: Get user preferences
    const preferences = await step.run('get-user-preferences', async () => {
      // Simulate fetching user notification preferences
      await this.simulateDelay(200);
      return {
        emailEnabled: true,
        pushEnabled: false,
        emailAddress: `user-${userId}@example.com`,
      };
    });

    if (!preferences.emailEnabled) {
      this.logger.log(`Email notifications disabled for user: ${userId}`);
      return { skipped: true, reason: 'email_disabled' };
    }

    // Step 2: Generate notification content
    const content = await step.run('generate-notification-content', async () => {
      await this.simulateDelay(100);
      return {
        subject: `Your profile has been updated`,
        body: `The following fields were updated: ${changes.join(', ')}`,
        template: 'user-update',
      };
    });

    // Step 3: Send email notification
    await step.run('send-email-notification', async () => {
      this.logger.log(`Sending email to: ${preferences.emailAddress}`);
      await this.simulateDelay(300);
      return { sent: true };
    });

    return {
      success: true,
      userId,
      notificationSent: true,
    };
  }

  // Debounced email sender (prevents spam)
  @InngestFunction({
    id: 'send-email-notification',
    triggers: { event: 'notification.email.send' },
  })
  @Debounce('30s', 'event.data.to') // Debounce by email address
  async sendEmailNotification({ 
    event, 
    step 
  }: { 
    event: NotificationEvents['notification.email.send']; 
    step: any;
  }) {
    const { to, subject, template, data } = event.data;

    this.logger.log(`Sending email to: ${to}`);

    // Step 1: Render email template
    const renderedEmail = await step.run('render-email-template', async () => {
      await this.simulateDelay(200);
      return {
        html: `<h1>${subject}</h1><p>Template: ${template}</p>`,
        text: `${subject}\nTemplate: ${template}`,
      };
    });

    // Step 2: Send via email service
    const result = await step.run('send-via-email-service', async () => {
      // Simulate email service API call
      await this.simulateDelay(500);
      return {
        messageId: `msg-${Date.now()}`,
        status: 'sent',
      };
    });

    // Step 3: Log delivery
    await step.run('log-email-delivery', async () => {
      this.logger.log(`Email sent successfully: ${result.messageId}`);
      await this.simulateDelay(50);
      return { logged: true };
    });

    return {
      success: true,
      messageId: result.messageId,
      recipient: to,
    };
  }

  // Batch notification processor
  @InngestFunction({
    id: 'process-notification-batch',
    triggers: { event: 'notification.batch.process' },
    batchEvents: {
      maxSize: 10,
      timeout: '5m',
    },
  })
  async processNotificationBatch({ events, step }: { events: any[]; step: any }) {
    this.logger.log(`Processing batch of ${events.length} notifications`);

    // Step 1: Group notifications by type
    const grouped = await step.run('group-notifications', async () => {
      const groups: Record<string, any[]> = {};
      events.forEach(event => {
        const type = event.name.split('.').pop();
        if (!groups[type]) groups[type] = [];
        groups[type].push(event);
      });
      return groups;
    });

    // Step 2: Process each group
    const results = [];
    for (const [type, typeEvents] of Object.entries(grouped)) {
      const result = await step.run(`process-${type}-notifications`, async () => {
        this.logger.log(`Processing ${typeEvents.length} ${type} notifications`);
        await this.simulateDelay(typeEvents.length * 100);
        return {
          type,
          count: typeEvents.length,
          processed: true,
        };
      });
      results.push(result);
    }

    return {
      success: true,
      totalEvents: events.length,
      processedGroups: results,
    };
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
