import { Test, TestingModule } from '@nestjs/testing';
import { 
  createInngestTestingModule, 
  MockInngestService,
  createMockInngestContext 
} from '../../src/utils/testing';
import { InngestService } from '../../src';

// Example service to test
import { Injectable } from '@nestjs/common';
import { InngestFunction } from '../../src';

@Injectable()
class UserService {
  constructor(private readonly inngestService: InngestService) {}

  @InngestFunction({
    id: 'welcome-new-user',
    trigger: { event: 'user.created' },
  })
  async welcomeNewUser({ event, step }: { event: any; step: any }) {
    const { userId, email } = event.data;

    // Step 1: Send welcome email
    await step.run('send-welcome-email', async () => {
      return { emailSent: true, to: email };
    });

    // Step 2: Create user record
    const userRecord = await step.run('create-user-record', async () => {
      return { userId, status: 'active', createdAt: new Date() };
    });

    // Step 3: Send follow-up event
    await step.sendEvent('send-follow-up', {
      name: 'user.welcomed',
      data: { userId, email },
    });

    return { success: true, userId };
  }

  async createUser(userData: { email: string; name: string }) {
    const userId = `user-${Date.now()}`;
    
    await this.inngestService.send({
      name: 'user.created',
      data: { userId, ...userData },
    });

    return { userId, ...userData };
  }
}

describe('UserService with Inngest', () => {
  let service: UserService;
  let inngestService: InngestService;
  let module: TestingModule;

  describe('with real InngestService', () => {
    beforeEach(async () => {
      module = await createInngestTestingModule(
        {
          id: 'test-app',
          eventKey: 'test-key',
        },
        [UserService],
      );

      service = module.get<UserService>(UserService);
      inngestService = module.get<InngestService>(InngestService);
    });

    afterEach(async () => {
      await module.close();
    });

    it('should send user.created event when creating a user', async () => {
      // Mock the send method to avoid network calls
      const sendSpy = jest
        .spyOn(inngestService, 'send')
        .mockResolvedValue({ ids: ['test-event-id'] });

      const result = await service.createUser({
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result.userId).toMatch(/^user-\d+$/);
      expect(sendSpy).toHaveBeenCalledWith({
        name: 'user.created',
        data: {
          userId: result.userId,
          email: 'test@example.com',
          name: 'Test User',
        },
      });
    });
  });

  describe('with MockInngestService', () => {
    let mockInngestService: MockInngestService;

    beforeEach(async () => {
      mockInngestService = new MockInngestService();

      module = await Test.createTestingModule({
        providers: [
          UserService,
          {
            provide: InngestService,
            useValue: mockInngestService,
          },
        ],
      }).compile();

      service = module.get<UserService>(UserService);
    });

    afterEach(async () => {
      await module.close();
    });

    it('should track sent events with mock service', async () => {
      await service.createUser({
        email: 'mock@example.com',
        name: 'Mock User',
      });

      const events = mockInngestService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('user.created');
      expect(events[0].data.email).toBe('mock@example.com');
    });

    it('should test function handler directly', async () => {
      const mockContext = createMockInngestContext({
        event: {
          name: 'user.created',
          data: {
            userId: 'test-123',
            email: 'direct@example.com',
          },
        },
      });

      // Call the handler directly
      const result = await service.welcomeNewUser(mockContext);

      expect(result.success).toBe(true);
      expect(result.userId).toBe('test-123');

      // Verify step calls
      expect(mockContext.step.run).toHaveBeenCalledWith(
        'send-welcome-email',
        expect.any(Function),
      );
      expect(mockContext.step.run).toHaveBeenCalledWith(
        'create-user-record',
        expect.any(Function),
      );
      expect(mockContext.step.sendEvent).toHaveBeenCalledWith(
        'send-follow-up',
        {
          name: 'user.welcomed',
          data: { userId: 'test-123', email: 'direct@example.com' },
        },
      );
    });
  });

  describe('step function testing', () => {
    it('should test individual steps', async () => {
      const mockContext = createMockInngestContext({
        event: {
          name: 'user.created',
          data: { userId: 'test-123', email: 'test@example.com' },
        },
      });

      // Test the send-welcome-email step
      let emailResult: any;
      mockContext.step.run.mockImplementation(async (id: string, fn: () => any) => {
        if (id === 'send-welcome-email') {
          emailResult = await fn();
          return emailResult;
        }
        return await fn();
      });

      await service.welcomeNewUser(mockContext);

      expect(emailResult).toEqual({
        emailSent: true,
        to: 'test@example.com',
      });
    });

    it('should handle step failures', async () => {
      const mockContext = createMockInngestContext();

      // Make the first step fail
      mockContext.step.run.mockImplementation(async (id: string, fn: () => any) => {
        if (id === 'send-welcome-email') {
          throw new Error('Email service unavailable');
        }
        return await fn();
      });

      await expect(service.welcomeNewUser(mockContext)).rejects.toThrow(
        'Email service unavailable',
      );

      // Ensure subsequent steps weren't called
      expect(mockContext.step.run).toHaveBeenCalledTimes(1);
    });
  });
});