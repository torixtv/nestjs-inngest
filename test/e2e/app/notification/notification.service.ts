import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestService, 
  InngestFunction, 
  InngestEvent,
  Throttle,
  Debounce,
  RateLimit,
  Concurrency,
  Retries 
} from '../../../../src/index';
import { v4 as uuidv4 } from 'uuid';
import { AppEvents } from '../types';

interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

interface SentEmail {
  id: string;
  to: string;
  subject: string;
  template: string;
  sentAt: Date;
  messageId: string;
  status: 'sent' | 'failed' | 'bounced';
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  
  // In-memory storage for demo
  private sentEmails: Map<string, SentEmail> = new Map();
  private emailTemplates: Map<string, EmailTemplate> = new Map();

  constructor(private readonly inngestService: InngestService) {
    this.initializeEmailTemplates();
  }

  // ============================================================================
  // INNGEST FUNCTIONS
  // ============================================================================

  /**
   * Process individual email notifications with retries and throttling
   * Triggered by notification.email.send events
   */
  @InngestFunction({
    id: 'send-email-notification',
    name: 'Send Email Notification',
    triggers: { event: 'notification.email.send' },
  })
  @Throttle(50, '1m') // Max 50 emails per minute with burst support
  @Debounce('2s', 'event.data.to') // Debounce by recipient email for 2 seconds
  @Retries(3) // Retry up to 3 times on failure
  async sendEmailNotification({ event, step }: { event: AppEvents['notification.email.send']; step: any }) {
    const { to, subject, template, templateData, priority = 'normal' } = event.data;
    this.logger.log(`📧 Processing email notification to: ${to} (template: ${template})`);

    try {
      // Step 1: Validate email and template
      const validation = await step.run('validate-email-request', async () => {
        this.logger.log(`🔍 Validating email request for: ${to}`);
        await this.simulateDelay(100);
        
        if (!this.isValidEmail(to)) {
          throw new Error(`Invalid email address: ${to}`);
        }
        
        if (!this.emailTemplates.has(template)) {
          throw new Error(`Email template not found: ${template}`);
        }
        
        return { 
          valid: true, 
          recipient: to, 
          templateFound: true,
          validatedAt: new Date().toISOString(),
        };
      });

      // Step 2: Render email template with provided data
      const renderedEmail = await step.run('render-email-template', async () => {
        this.logger.log(`🎨 Rendering email template: ${template}`);
        await this.simulateDelay(200);
        
        const templateContent = this.emailTemplates.get(template)!;
        
        // Simple template rendering (replace {{variable}} with values)
        let renderedSubject = subject || templateContent.subject;
        let renderedHtml = templateContent.html;
        let renderedText = templateContent.text;
        
        // Replace template variables
        for (const [key, value] of Object.entries(templateData || {})) {
          const placeholder = `{{${key}}}`;
          renderedSubject = renderedSubject.replace(new RegExp(placeholder, 'g'), String(value));
          renderedHtml = renderedHtml.replace(new RegExp(placeholder, 'g'), String(value));
          renderedText = renderedText.replace(new RegExp(placeholder, 'g'), String(value));
        }
        
        return {
          subject: renderedSubject,
          html: renderedHtml,
          text: renderedText,
          templateUsed: template,
          renderedAt: new Date().toISOString(),
        };
      });

      // Step 3: Send email via email service (simulated)
      const emailResult = await step.run('send-via-email-service', async () => {
        this.logger.log(`📤 Sending email to: ${to}`);
        
        // Simulate sending based on priority
        const delay = priority === 'high' ? 300 : priority === 'normal' ? 500 : 800;
        await this.simulateDelay(delay);
        
        // Simulate occasional failures (5% failure rate)
        if (Math.random() < 0.05) {
          throw new Error(`Email service error: Failed to send to ${to}`);
        }
        
        const messageId = `msg_${uuidv4()}`;
        const emailRecord: SentEmail = {
          id: uuidv4(),
          to,
          subject: renderedEmail.subject,
          template,
          sentAt: new Date(),
          messageId,
          status: 'sent',
        };
        
        this.sentEmails.set(emailRecord.id, emailRecord);
        
        return {
          messageId,
          status: 'sent',
          sentAt: new Date().toISOString(),
          provider: 'mock-email-service',
        };
      });

      // Step 4: Log successful delivery
      await step.run('log-email-delivery', async () => {
        this.logger.log(`✅ Email sent successfully to ${to}: ${emailResult.messageId}`);
        await this.simulateDelay(50);
        
        // Send success event
        await this.inngestService.send({
          name: 'notification.email.sent',
          data: {
            to,
            messageId: emailResult.messageId,
            sentAt: emailResult.sentAt,
          },
        });
        
        return { 
          logged: true, 
          deliveryStatus: 'confirmed',
        };
      });

      return {
        success: true,
        messageId: emailResult.messageId,
        recipient: to,
        template,
        priority,
        sentAt: emailResult.sentAt,
      };

    } catch (error) {
      this.logger.error(`❌ Failed to send email to ${to}: ${error.message}`);
      
      // Log the failure
      await step.run('log-email-failure', async () => {
        await this.inngestService.send({
          name: 'notification.email.failed',
          data: {
            to,
            error: error.message,
            failedAt: new Date().toISOString(),
            retryCount: 0, // This would be tracked properly in production
          },
        });
        
        return { failureLogged: true };
      });
      
      throw error; // Re-throw to trigger retries
    }
  }

  /**
   * Process batch notifications efficiently
   * Triggered by notification.batch.process events
   */
  @InngestFunction({
    id: 'process-notification-batch',
    name: 'Process Notification Batch',
    triggers: { event: 'notification.batch.process' },
    batchEvents: {
      maxSize: 10, // Process up to 10 batch events at once
      timeout: '5m', // Wait max 5 minutes to collect batch
    },
  })
  @Concurrency(3) // Max 3 batch processors running simultaneously
  async processNotificationBatch({ events, step }: { events: AppEvents['notification.batch.process'][]; step: any }) {
    const totalNotifications = events.reduce((sum, event) => sum + event.data.notifications.length, 0);
    this.logger.log(`📦 Processing batch of ${events.length} batch events containing ${totalNotifications} notifications`);

    // Step 1: Flatten and categorize notifications
    const categorizedNotifications = await step.run('categorize-notifications', async () => {
      this.logger.log(`📊 Categorizing ${totalNotifications} notifications`);
      await this.simulateDelay(200);
      
      const byType: Record<string, any[]> = {};
      const byPriority: Record<string, any[]> = { high: [], normal: [], low: [] };
      
      for (const event of events) {
        for (const notification of event.data.notifications) {
          // Group by type
          if (!byType[notification.type]) {
            byType[notification.type] = [];
          }
          byType[notification.type].push(notification);
          
          // Group by priority
          const priority = notification.data.priority || 'normal';
          byPriority[priority].push(notification);
        }
      }
      
      return {
        byType,
        byPriority,
        totalCount: totalNotifications,
        typeCount: Object.keys(byType).length,
      };
    });

    // Step 2: Process high priority notifications first
    if (categorizedNotifications.byPriority.high.length > 0) {
      await step.run('process-high-priority-notifications', async () => {
        this.logger.log(`⚡ Processing ${categorizedNotifications.byPriority.high.length} high priority notifications`);
        await this.simulateDelay(500);
        
        for (const notification of categorizedNotifications.byPriority.high) {
          if (notification.type === 'email') {
            await this.inngestService.send({
              name: 'notification.email.send',
              data: {
                to: notification.recipient,
                subject: notification.data.subject,
                template: notification.data.template || 'generic',
                templateData: notification.data.templateData || {},
                priority: 'high',
              },
            });
          }
        }
        
        return { 
          processed: categorizedNotifications.byPriority.high.length,
          priority: 'high',
        };
      });
    }

    // Step 3: Process normal and low priority notifications
    const results: Array<{ processed: number; priority: string }> = [];
    for (const [priority, notifications] of Object.entries(categorizedNotifications.byPriority)) {
      const typedNotifications = notifications as any[];
      if (priority === 'high' || typedNotifications.length === 0) continue;
      
      const result = await step.run(`process-${priority}-priority-notifications`, async () => {
        this.logger.log(`📋 Processing ${typedNotifications.length} ${priority} priority notifications`);
        await this.simulateDelay(typedNotifications.length * 50);
        
        let processedCount = 0;
        for (const notification of typedNotifications) {
          if (notification.type === 'email') {
            await this.inngestService.send({
              name: 'notification.email.send',
              data: {
                to: notification.recipient,
                subject: notification.data.subject,
                template: notification.data.template || 'generic',
                templateData: notification.data.templateData || {},
                priority: priority as 'normal' | 'low',
              },
            });
            processedCount++;
          }
        }
        
        return { 
          processed: processedCount,
          priority,
        };
      });
      
      results.push(result);
    }

    // Step 4: Generate batch processing report
    const report = await step.run('generate-batch-report', async () => {
      this.logger.log(`📈 Generating batch processing report`);
      await this.simulateDelay(100);
      
      const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0) +
                            (categorizedNotifications.byPriority.high.length || 0);
      
      return {
        batchId: `batch_${uuidv4()}`,
        eventsProcessed: events.length,
        notificationsProcessed: totalProcessed,
        byType: Object.keys(categorizedNotifications.byType).map(type => ({
          type,
          count: categorizedNotifications.byType[type].length,
        })),
        processingTime: new Date().toISOString(),
        success: true,
      };
    });

    this.logger.log(`✅ Batch processing completed: ${report.notificationsProcessed} notifications sent`);

    return report;
  }

  /**
   * Handle email delivery failures and implement retry logic
   * Triggered by notification.email.failed events
   */
  @InngestEvent('handle-email-failure', 'notification.email.failed')
  @RateLimit(20, '1m') // Limit failure handling to prevent spam
  async handleEmailFailure({ event, step }: { event: AppEvents['notification.email.failed']; step: any }) {
    const { to, error, failedAt, retryCount } = event.data;
    this.logger.log(`❌ Handling email failure for: ${to} (retry: ${retryCount})`);

    // Step 1: Analyze failure type
    const failureAnalysis = await step.run('analyze-email-failure', async () => {
      this.logger.log(`🔍 Analyzing failure for: ${to}`);
      await this.simulateDelay(100);
      
      let failureType: 'temporary' | 'permanent' | 'rate_limit' = 'temporary';
      let shouldRetry = true;
      let retryDelay = '5m';
      
      if (error.includes('invalid email') || error.includes('not found')) {
        failureType = 'permanent';
        shouldRetry = false;
      } else if (error.includes('rate limit') || error.includes('throttled')) {
        failureType = 'rate_limit';
        retryDelay = '15m';
      } else if (retryCount >= 3) {
        shouldRetry = false;
      }
      
      return {
        failureType,
        shouldRetry,
        retryDelay,
        retryCount,
        maxRetries: 3,
      };
    });

    if (failureAnalysis.shouldRetry) {
      // Step 2: Schedule retry
      await step.run('schedule-retry', async () => {
        this.logger.log(`🔄 Scheduling retry for: ${to} in ${failureAnalysis.retryDelay}`);
        await this.simulateDelay(100);
        
        // In a real implementation, you'd schedule the retry
        // For demo, we'll just log the retry intent
        return {
          retryScheduled: true,
          retryAfter: failureAnalysis.retryDelay,
          attempt: retryCount + 1,
        };
      });
    } else {
      // Step 3: Mark as permanently failed
      await step.run('mark-permanent-failure', async () => {
        this.logger.log(`💀 Marking as permanent failure: ${to}`);
        await this.simulateDelay(50);
        
        // Log permanent failure
        // In production, you might want to notify admins or update user preferences
        return {
          permanentFailure: true,
          reason: failureAnalysis.failureType,
          finalAttempt: retryCount,
        };
      });
    }

    return {
      success: true,
      recipient: to,
      action: failureAnalysis.shouldRetry ? 'retry_scheduled' : 'permanent_failure',
      failureType: failureAnalysis.failureType,
    };
  }

  // ============================================================================
  // SERVICE METHODS
  // ============================================================================

  async sendBatchNotifications(notifications: Array<{
    type: string;
    recipient: string;
    data: Record<string, any>;
  }>): Promise<void> {
    const batchId = uuidv4();
    
    await this.inngestService.send({
      name: 'notification.batch.process',
      data: {
        batchId,
        notifications,
      },
    });
    
    this.logger.log(`📦 Batch notification triggered: ${batchId} (${notifications.length} notifications)`);
  }

  getSentEmails(): SentEmail[] {
    return Array.from(this.sentEmails.values());
  }

  getEmailStats(): {
    totalSent: number;
    successRate: number;
    byTemplate: Record<string, number>;
    byStatus: Record<string, number>;
  } {
    const emails = Array.from(this.sentEmails.values());
    const totalSent = emails.length;
    const successful = emails.filter(e => e.status === 'sent').length;
    
    const byTemplate: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    
    for (const email of emails) {
      byTemplate[email.template] = (byTemplate[email.template] || 0) + 1;
      byStatus[email.status] = (byStatus[email.status] || 0) + 1;
    }
    
    return {
      totalSent,
      successRate: totalSent > 0 ? (successful / totalSent) * 100 : 0,
      byTemplate,
      byStatus,
    };
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private initializeEmailTemplates(): void {
    // Welcome email template
    this.emailTemplates.set('welcome', {
      subject: 'Welcome to our platform, {{name}}!',
      html: `
        <h1>Welcome {{name}}!</h1>
        <p>Thanks for joining our platform. We're excited to have you on board!</p>
        <p>Your user ID is: <strong>{{userId}}</strong></p>
        <p><a href="{{loginUrl}}">Click here to get started</a></p>
        <p>Best regards,<br>The Team</p>
      `,
      text: `
        Welcome {{name}}!
        
        Thanks for joining our platform. We're excited to have you on board!
        
        Your user ID is: {{userId}}
        
        Visit {{loginUrl}} to get started.
        
        Best regards,
        The Team
      `,
    });

    // Profile updated template
    this.emailTemplates.set('profile-updated', {
      subject: 'Your profile has been updated',
      html: `
        <h1>Profile Updated</h1>
        <p>Hi {{name}},</p>
        <p>Your profile has been successfully updated.</p>
        <p>Changes made: {{changes}}</p>
        <p>Updated on: {{updatedAt}}</p>
        <p>If you didn't make these changes, please contact support.</p>
      `,
      text: `
        Profile Updated
        
        Hi {{name}},
        
        Your profile has been successfully updated.
        Changes made: {{changes}}
        Updated on: {{updatedAt}}
        
        If you didn't make these changes, please contact support.
      `,
    });

    // Email verification template
    this.emailTemplates.set('email-verification', {
      subject: 'Please verify your email address',
      html: `
        <h1>Verify Your Email</h1>
        <p>Hi {{name}},</p>
        <p>Please verify your new email address by clicking the link below:</p>
        <p><a href="{{verificationUrl}}">Verify Email Address</a></p>
        <p>If you didn't request this change, please contact support immediately.</p>
      `,
      text: `
        Verify Your Email
        
        Hi {{name}},
        
        Please verify your new email address by visiting:
        {{verificationUrl}}
        
        If you didn't request this change, please contact support immediately.
      `,
    });

    // Verification reminder template
    this.emailTemplates.set('verification-reminder', {
      subject: 'Please verify your account',
      html: `
        <h1>Account Verification Reminder</h1>
        <p>Hi {{name}},</p>
        <p>You created an account with us, but haven't verified your email yet.</p>
        <p>Please verify your account to complete your registration.</p>
        <p>Your user ID is: {{userId}}</p>
      `,
      text: `
        Account Verification Reminder
        
        Hi {{name}},
        
        You created an account with us, but haven't verified your email yet.
        Please verify your account to complete your registration.
        
        Your user ID is: {{userId}}
      `,
    });

    // Account deletion warning template
    this.emailTemplates.set('account-deletion-warning', {
      subject: 'Final notice: Account will be deleted',
      html: `
        <h1>Account Deletion Warning</h1>
        <p>Your account ({{userId}}) created on {{createdAt}} will be deleted on {{deletionDate}} due to inactivity.</p>
        <p>To prevent deletion, please verify your account immediately.</p>
        <p><strong>This is your final warning.</strong></p>
      `,
      text: `
        Account Deletion Warning
        
        Your account ({{userId}}) created on {{createdAt}} will be deleted on {{deletionDate}} due to inactivity.
        
        To prevent deletion, please verify your account immediately.
        
        This is your final warning.
      `,
    });

    // Generic template
    this.emailTemplates.set('generic', {
      subject: '{{subject}}',
      html: '<p>{{message}}</p>',
      text: '{{message}}',
    });

    this.logger.log(`📧 Initialized ${this.emailTemplates.size} email templates`);
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}
