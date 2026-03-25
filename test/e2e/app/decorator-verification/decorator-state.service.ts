import { Injectable } from '@nestjs/common';

interface MultiTriggerExecution {
  eventName: string;
  recordedAt: string;
}

interface FailureHandlerExecution {
  eventName: string;
  error: string;
  recordedAt: string;
}

@Injectable()
export class DecoratorStateService {
  private multiTriggerExecutions: MultiTriggerExecution[] = [];
  private failureHandlerExecutions: FailureHandlerExecution[] = [];

  reset() {
    this.multiTriggerExecutions = [];
    this.failureHandlerExecutions = [];
  }

  recordMultiTrigger(eventName: string) {
    this.multiTriggerExecutions.push({
      eventName,
      recordedAt: new Date().toISOString(),
    });
  }

  recordFailureHandler(eventName: string, error: string) {
    this.failureHandlerExecutions.push({
      eventName,
      error,
      recordedAt: new Date().toISOString(),
    });
  }

  snapshot() {
    return {
      multiTriggerExecutions: [...this.multiTriggerExecutions],
      failureHandlerExecutions: [...this.failureHandlerExecutions],
      counts: {
        multiTriggerExecutions: this.multiTriggerExecutions.length,
        failureHandlerExecutions: this.failureHandlerExecutions.length,
      },
    };
  }
}
