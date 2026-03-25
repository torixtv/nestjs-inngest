import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestService, 
  InngestFunction, 
  InngestEvent,
  InngestCron,
  Concurrency,
  RateLimit,
  Retries,
  Debounce 
} from '../../../../src/index';
import { v4 as uuidv4 } from 'uuid';
import { AppEvents, User, UserProfile } from '../types';
import { createUserEvent } from '../../../../src/utils/types';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  
  // In-memory storage for demo purposes
  private users: Map<string, User> = new Map();
  private profiles: Map<string, UserProfile> = new Map();

  constructor(private readonly inngestService: InngestService) {}

  // ============================================================================
  // INNGEST FUNCTIONS
  // ============================================================================

  /**
   * Complete user onboarding workflow with multiple steps
   * Triggered when a user is created
   */
  @InngestFunction({
    id: 'user-onboarding-workflow',
    name: 'User Onboarding Workflow',
    triggers: { event: 'user.created' },
  })
  @Concurrency(5) // Process max 5 onboarding workflows concurrently
  @Retries(3) // Retry up to 3 times on failure
  async onboardUser({ event, step }: { event: AppEvents['user.created']; step: any }) {
    const { id: userId, email, name } = event.user;
    this.logger.log(`🎯 Starting onboarding workflow for user: ${userId}`);

    try {
      // Step 1: Send welcome email
      const emailResult = await step.run('send-welcome-email', async () => {
        this.logger.log(`📧 Sending welcome email to: ${email}`);
        await this.simulateDelay(1000);
        
        // Trigger email notification with proper user context
        const emailEvent = createUserEvent(
          'notification.email.send',
          {
            to: email,
            subject: 'Welcome to our platform!',
            template: 'welcome',
            templateData: { 
              name, 
              userId,
              loginUrl: `https://app.example.com/login`,
            },
            priority: 'high',
          },
          {
            userId,
            email,
            name,
            role: 'user',
          },
        );
        
        await this.inngestService.send(emailEvent);

        return { emailSent: true, sentAt: new Date().toISOString() };
      });

      // Step 2: Create user profile
      const profile = await step.run('create-user-profile', async () => {
        this.logger.log(`👤 Creating profile for user: ${userId}`);
        await this.simulateDelay(500);
        
        const profileId = `profile_${uuidv4()}`;
        const newProfile: UserProfile = {
          id: profileId,
          userId,
          preferences: {
            emailNotifications: true,
            pushNotifications: false,
            theme: 'system',
          },
          createdAt: new Date(),
        };
        
        this.profiles.set(profileId, newProfile);
        
        // Update user with profile ID
        const user = this.users.get(userId);
        if (user) {
          user.profileId = profileId;
          this.users.set(userId, user);
        }
        
        return { profileId, createdAt: newProfile.createdAt.toISOString() };
      });

      // Step 3: Set up user preferences and initial data
      await step.run('setup-initial-data', async () => {
        this.logger.log(`⚙️ Setting up initial data for: ${userId}`);
        await this.simulateDelay(300);
        
        // Simulate setting up user preferences, default settings, etc.
        return { 
          preferencesSet: true, 
          defaultSettings: {
            language: 'en',
            timezone: 'UTC',
          }
        };
      });

      // Step 4: Wait for email verification (with timeout)
      this.logger.log(`⏳ Waiting for user verification: ${userId}`);
      const verification = await step.waitForEvent('wait-for-verification', {
        event: 'user.verified',
        timeout: '7d', // Wait up to 7 days for verification
        match: 'data.userId', // Match on userId field
      });

      let onboardingStatus = 'partial';
      
      if (verification) {
        // Step 5: Complete onboarding after verification
        await step.run('complete-onboarding', async () => {
          this.logger.log(`✅ Completing onboarding for verified user: ${userId}`);
          await this.simulateDelay(200);
          
          // Mark user as verified
          const user = this.users.get(userId);
          if (user) {
            user.isVerified = true;
            this.users.set(userId, user);
          }
          
          return { onboardingComplete: true, verifiedAt: new Date().toISOString() };
        });
        
        onboardingStatus = 'completed';
        
        // Send completion event
        await step.sendEvent('send-completion-event', {
          name: 'user.onboarding.completed',
          data: { 
            userId, 
            profileId: profile.profileId,
            completedAt: new Date().toISOString(),
          },
        });
        
      } else {
        this.logger.warn(`⚠️ User verification timeout for: ${userId}`);
        
        // Send reminder email for unverified users
        await step.sendEvent('send-reminder-email', {
          name: 'notification.email.send',
          data: {
            to: email,
            subject: 'Please verify your account',
            template: 'verification-reminder',
            templateData: { name, userId },
            priority: 'normal',
          },
        });
      }

      this.logger.log(`🎉 Onboarding workflow completed for ${userId} with status: ${onboardingStatus}`);

      return {
        success: true,
        userId,
        profileId: profile.profileId,
        status: onboardingStatus,
        emailSent: emailResult.emailSent,
        verified: verification !== null,
        completedAt: new Date().toISOString(),
      };

    } catch (error) {
      this.logger.error(`❌ Onboarding workflow failed for ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Process user updates with validation and notification
   * Triggered when a user is updated
   */
  @InngestEvent('process-user-update', 'user.updated')
  @RateLimit(100, '1m') // Max 100 updates per minute
  @Debounce('5s', 'event.user.id') // Debounce by user ID for 5 seconds
  async processUserUpdate({ event, step }: { event: AppEvents['user.updated']; step: any }) {
    const { id: userId } = event.user;
    const { changes, updatedAt } = event.data;
    this.logger.log(`🔄 Processing update for user: ${userId}`);

    // Step 1: Validate changes
    const validation = await step.run('validate-user-changes', async () => {
      this.logger.log(`🔍 Validating changes for user: ${userId}`);
      await this.simulateDelay(200);
      
      const user = this.users.get(userId);
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      
      // Validate email format if email is being changed
      if (changes.email && !this.isValidEmail(changes.email)) {
        throw new Error('Invalid email format');
      }
      
      // Validate name length if name is being changed
      if (changes.name && (changes.name.length < 2 || changes.name.length > 100)) {
        throw new Error('Name must be between 2 and 100 characters');
      }
      
      return { 
        valid: true, 
        processedFields: Object.keys(changes),
        validatedAt: new Date().toISOString(),
      };
    });

    // Step 2: Apply changes to user record
    const updateResult = await step.run('apply-user-changes', async () => {
      this.logger.log(`💾 Applying changes to user: ${userId}`);
      await this.simulateDelay(300);
      
      const user = this.users.get(userId);
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      
      // Apply changes
      const updatedUser = { 
        ...user, 
        ...changes, 
        updatedAt: new Date(),
      };
      
      // If email changed, mark as unverified
      if (changes.email && changes.email !== user.email) {
        updatedUser.isVerified = false;
      }
      
      this.users.set(userId, updatedUser);
      
      return { 
        updated: true, 
        previousValues: { email: user.email, name: user.name },
        newValues: changes,
        requiresVerification: changes.email && changes.email !== user.email,
      };
    });

    // Step 3: Send notification about the update
    await step.run('send-update-notification', async () => {
      this.logger.log(`📨 Sending update notification for user: ${userId}`);
      await this.simulateDelay(100);
      
      const user = this.users.get(userId);
      if (!user) return { skipped: true, reason: 'user_not_found' };
      
      await this.inngestService.send({
        name: 'notification.email.send',
        data: {
          to: user.email,
          subject: 'Your profile has been updated',
          template: 'profile-updated',
          templateData: {
            name: user.name,
            changes: validation.processedFields,
            updatedAt,
          },
          priority: 'normal',
        },
      });
      
      return { notificationSent: true };
    });

    // Step 4: If email changed, send verification email
    if (updateResult.requiresVerification) {
      await step.run('send-verification-email', async () => {
        this.logger.log(`🔐 Sending verification email for new email: ${changes.email}`);
        await this.simulateDelay(200);
        
        await this.inngestService.send({
          name: 'notification.email.send',
          data: {
            to: changes.email!,
            subject: 'Please verify your new email address',
            template: 'email-verification',
            templateData: {
              name: changes.name || 'there',
              userId,
              verificationUrl: `https://app.example.com/verify?token=${uuidv4()}`,
            },
            priority: 'high',
          },
        });
        
        return { verificationEmailSent: true };
      });
    }

    return {
      success: true,
      userId,
      changesApplied: validation.processedFields,
      requiresVerification: updateResult.requiresVerification,
    };
  }

  /**
   * Cleanup inactive users - scheduled daily
   * Runs every day at 2:00 AM
   */
  @InngestCron('cleanup-inactive-users', '0 2 * * *')
  async cleanupInactiveUsers({ event, step }: { event: any; step: any }) {
    this.logger.log('🧹 Starting cleanup of inactive users');

    // Step 1: Find inactive users (not verified after 30 days)
    const inactiveUsers = await step.run('find-inactive-users', async () => {
      this.logger.log('🔍 Finding inactive users...');
      await this.simulateDelay(1000);
      
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const inactive: User[] = [];
      for (const user of this.users.values()) {
        if (!user.isVerified && user.createdAt < thirtyDaysAgo) {
          inactive.push(user);
        }
      }
      
      this.logger.log(`Found ${inactive.length} inactive users`);
      return inactive.map(u => ({ 
        userId: u.id, 
        email: u.email, 
        createdAt: u.createdAt.toISOString(),
      }));
    });

    // Step 2: Send final warning emails
    if (inactiveUsers.length > 0) {
      await step.run('send-final-warning-emails', async () => {
        this.logger.log(`📧 Sending final warning emails to ${inactiveUsers.length} users`);
        await this.simulateDelay(500);
        
        for (const user of inactiveUsers) {
          await this.inngestService.send({
            name: 'notification.email.send',
            data: {
              to: user.email,
              subject: 'Final notice: Account will be deleted',
              template: 'account-deletion-warning',
              templateData: {
                userId: user.userId,
                createdAt: user.createdAt,
                deletionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              },
              priority: 'high',
            },
          });
        }
        
        return { warningEmailsSent: inactiveUsers.length };
      });

      // Step 3: Wait 7 days before actual deletion
      await step.sleep('wait-before-deletion', '7d');

      // Step 4: Delete users who still haven't verified
      const deletionResult = await step.run('delete-inactive-users', async () => {
        this.logger.log('🗑️ Deleting users who still have not verified...');
        await this.simulateDelay(500);
        
        let deletedCount = 0;
        const deletedUserIds: string[] = [];
        
        for (const inactiveUser of inactiveUsers) {
          const currentUser = this.users.get(inactiveUser.userId);
          if (currentUser && !currentUser.isVerified) {
            // Delete user and profile
            this.users.delete(inactiveUser.userId);
            if (currentUser.profileId) {
              this.profiles.delete(currentUser.profileId);
            }
            
            deletedCount++;
            deletedUserIds.push(inactiveUser.userId);
            
            // Send deletion event
            await this.inngestService.send({
              name: 'user.deleted',
              data: {
                userId: inactiveUser.userId,
                deletedAt: new Date().toISOString(),
              },
            });
          }
        }
        
        return { deletedCount, deletedUserIds };
      });

      this.logger.log(`🎯 Cleanup completed: ${deletionResult.deletedCount} users deleted`);
    }

    return {
      success: true,
      inactiveUsersFound: inactiveUsers.length,
      usersDeleted: inactiveUsers.length > 0 ? (await step.run('get-deletion-count', async () => {
        return this.users.size; // This is just for demo, in real scenario we'd track this properly
      })) : 0,
      completedAt: new Date().toISOString(),
    };
  }

  // ============================================================================
  // REGULAR SERVICE METHODS (for REST API)
  // ============================================================================

  async createUser(userData: { email: string; name: string }): Promise<User> {
    const userId = uuidv4();
    const user: User = {
      id: userId,
      email: userData.email,
      name: userData.name,
      isVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.set(userId, user);

    // Trigger onboarding workflow with proper user context
    const event = createUserEvent(
      'user.created',
      {
        createdAt: user.createdAt.toISOString(),
      },
      {
        userId,
        email: userData.email,
        name: userData.name,
        role: 'user',
      },
    );
    
    await this.inngestService.send(event);

    this.logger.log(`✅ User created: ${userId} (${userData.email})`);
    return user;
  }

  async updateUser(userId: string, changes: { email?: string; name?: string }): Promise<User> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    // Trigger update workflow with proper user context
    const updateEvent = createUserEvent(
      'user.updated',
      {
        changes,
        updatedAt: new Date().toISOString(),
      },
      {
        userId,
        email: user.email,
        name: user.name,
        role: 'user',
      },
    );
    
    await this.inngestService.send(updateEvent);

    this.logger.log(`🔄 User update triggered: ${userId}`);
    
    // Return current user (changes will be applied by the workflow)
    return this.users.get(userId) || user;
  }

  async deleteUser(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    // Remove from storage
    this.users.delete(userId);
    if (user.profileId) {
      this.profiles.delete(user.profileId);
    }

    // Trigger deletion event
    await this.inngestService.send({
      name: 'user.deleted',
      data: {
        userId,
        deletedAt: new Date().toISOString(),
      },
    });

    this.logger.log(`🗑️ User deleted: ${userId}`);
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.get(userId) || null;
  }

  async verifyUser(userId: string, verificationToken: string): Promise<User> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    user.isVerified = true;
    user.updatedAt = new Date();
    this.users.set(userId, user);

    // Trigger verification event (this will complete onboarding workflows)
    await this.inngestService.send({
      name: 'user.verified',
      data: {
        userId,
        verificationToken,
        verifiedAt: new Date().toISOString(),
      },
    });

    this.logger.log(`✅ User verified: ${userId}`);
    return user;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  // Get all users (for debugging)
  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  // Get all profiles (for debugging)
  getAllProfiles(): UserProfile[] {
    return Array.from(this.profiles.values());
  }
}
