import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction } from '../../../../src/index';
import { InngestService } from '../../../../src/services/inngest.service';
import { InngestTracingService } from '../../../../src/tracing/tracing.service';

@Injectable()
export class TestService {
  private readonly logger = new Logger(TestService.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly tracingService: InngestTracingService
  ) {}

  /**
   * Handle simple test events - demonstrates basic step tracing
   */
  @InngestFunction({
    id: 'test-simple-handler',
    triggers: { event: 'test.simple' }
  })
  async handleSimpleTest({ event, step, ctx }: any) {
    const message = event.data?.message || event.message || 'default message';
    this.logger.log('Handling simple test event', {
      message,
      functionId: 'test-simple-handler',
      eventType: 'test.simple'
    });

    // Step 1: Validate the input
    const validation = await step.run('validate-input', () => {
      return {
        isValid: !!message,
        timestamp: new Date().toISOString(),
        messageLength: message?.length || 0,
        eventStructure: {
          hasData: !!event.data,
          dataKeys: event.data ? Object.keys(event.data) : [],
          eventKeys: Object.keys(event)
        }
      };
    });

    // Step 2: Process the data
    const processed = await step.run('process-data', () => {
      return {
        processedMessage: message?.toUpperCase() || 'NO MESSAGE',
        processedAt: new Date().toISOString(),
        userId: event.data?.userId || event.userId || 'anonymous'
      };
    });

    // Step 3: Log the result
    await step.run('log-result', () => {
      this.logger.log('Simple test processed successfully', {
        processedMessage: processed.processedMessage,
        step: 'log-result'
      });
      return { logged: true, timestamp: new Date().toISOString() };
    });

    return {
      success: true,
      validation,
      processed,
      completedAt: new Date().toISOString()
    };
  }

  /**
   * Handle workflow test events - demonstrates sendEvent tracing
   */
  @InngestFunction({
    id: 'test-workflow-handler',
    triggers: { event: 'test.workflow' }
  })
  async handleWorkflowTest({ event, step, ctx }: any) {
    this.logger.log('Handling workflow test event', {
      workflowId: event.data.workflowId,
      functionId: 'test-workflow-handler',
      eventType: 'test.workflow'
    });

    // Step 1: Initialize workflow
    const init = await step.run('initialize-workflow', () => {
      return {
        workflowId: event.data.workflowId,
        steps: event.data.steps || ['step1', 'step2'],
        startedAt: new Date().toISOString()
      };
    });

    // Step 2: Send follow-up event (demonstrates trace context propagation)
    await step.sendEvent('send-workflow-step', {
      name: 'test.workflow.step',
      data: {
        workflowId: init.workflowId,
        step: 'step1',
        parentData: event.data,
        timestamp: new Date().toISOString()
      }
    });

    // Step 3: Process workflow data
    const result = await step.run('process-workflow', () => {
      return {
        workflowId: init.workflowId,
        processedSteps: init.steps.length,
        metadata: event.data.metadata || {},
        completedAt: new Date().toISOString()
      };
    });

    return {
      success: true,
      workflowId: init.workflowId,
      result,
      followUpEventSent: true
    };
  }

  /**
   * Handle workflow step events (for trace context propagation testing)
   */
  @InngestFunction({
    id: 'test-workflow-step-handler',
    triggers: { event: 'test.workflow.step' }
  })
  async handleWorkflowStep({ event, step, ctx }: any) {
    this.logger.log('Handling workflow step', {
      step: event.data.step,
      workflowId: event.data.workflowId,
      functionId: 'test-workflow-step-handler',
      eventType: 'test.workflow.step'
    });

    // This function should inherit trace context from the parent workflow
    const stepResult = await step.run('execute-step', () => {
      return {
        step: event.data.step,
        workflowId: event.data.workflowId,
        executedAt: new Date().toISOString(),
        parentTrace: !!event.data.traceContext // Check if trace context was propagated
      };
    });

    // Conditionally send another event to test chaining
    if (event.data.enableChain) {
      await step.sendEvent('send-workflow-complete', {
        name: 'test.workflow.complete',
        data: {
          workflowId: event.data.workflowId,
          finalStep: true,
          chainedFrom: event.data.step,
          completedAt: new Date().toISOString()
        }
      });
    }

    return stepResult;
  }

  /**
   * Handle workflow completion events (end of chain)
   */
  @InngestFunction({
    id: 'test-workflow-complete-handler',
    triggers: { event: 'test.workflow.complete' }
  })
  async handleWorkflowComplete({ event, step, ctx }: any) {
    this.logger.log('Completing workflow', {
      workflowId: event.data.workflowId,
      functionId: 'test-workflow-complete-handler',
      eventType: 'test.workflow.complete'
    });

    await step.run('finalize-workflow', () => {
      return {
        workflowId: event.data.workflowId,
        chainedFrom: event.data.chainedFrom,
        finalizedAt: new Date().toISOString(),
        traceContextReceived: !!event.data.traceContext
      };
    });

    return {
      success: true,
      workflowId: event.data.workflowId,
      completed: true
    };
  }

  /**
   * Handle complex multi-step events - demonstrates comprehensive step tracing
   */
  @InngestFunction({
    id: 'test-complex-handler',
    triggers: { event: 'test.complex' }
  })
  async handleComplexTest({ event, step, ctx }: any) {
    const iterations = event.data?.iterations || 3;
    const processingDelay = event.data?.delay || 10;
    
    this.logger.log('Handling complex test', {
      iterations,
      processingDelay,
      testId: event.data?.testId,
      functionId: 'test-complex-handler'
    });

    // Step 1: Initialize data processing with for loop (run inside the loop)
    const results: any[] = [];
    for (let i = 0; i < iterations; i++) {
      // Each initialization is a separate step.run for better tracing
      const item = await step.run(`initialize-data-item-${i + 1}`, async () => {
      await new Promise(resolve => setTimeout(resolve, processingDelay));
      return {
        id: `init_${i}`,
        value: Math.random() * 100,
        timestamp: new Date().toISOString()
      };
      });
      results.push(item);
    }
    this.logger.log('Initialized data items', {
      itemCount: results.length,
      iterations,
      step: 'initialize-data-processing'
    });
    const initData = {
      items: results,
      totalItems: results.length,
      processingStarted: new Date().toISOString()
    };

    // Step 2: Validate input parameters
    const validation = await step.run('validate-complex-input', () => {
      return {
        hasValidData: initData.items.length > 0,
        itemCount: initData.items.length,
        allItemsValid: initData.items.every((item: any) => item.value !== null),
        validationCompleted: new Date().toISOString()
      };
    });

    // Step 3: Process data with complex for loop operations
    const processedData = await step.run('process-complex-data', async () => {
      const processedItems: any[] = [];
      
      for (let i = 0; i < initData.items.length; i++) {
        const item = initData.items[i];
        
        // Simulate complex processing with nested operations
        await new Promise(resolve => setTimeout(resolve, processingDelay));
        
        const processedItem = {
          originalId: item.id,
          processedId: `processed_${i}`,
          originalValue: item.value,
          processedValue: item.value * 2 + Math.random() * 10,
          processingStep: i + 1,
          totalSteps: initData.items.length,
          processedAt: new Date().toISOString()
        };
        
        processedItems.push(processedItem);
      }
      
      this.logger.log('Processed complex items', {
        itemCount: processedItems.length,
        averageValue: processedItems.reduce((sum, item) => sum + item.processedValue, 0) / processedItems.length,
        step: 'process-complex-data'
      });
      return {
        processedItems,
        averageValue: processedItems.reduce((sum, item) => sum + item.processedValue, 0) / processedItems.length,
        processingCompleted: new Date().toISOString()
      };
    });

    // Step 4: Generate summary report with aggregation loop
    const summaryReport = await step.run('generate-summary-report', async () => {
      const report = {
        totalItemsProcessed: processedData.processedItems.length,
        averageProcessedValue: processedData.averageValue,
        minValue: Math.min(...processedData.processedItems.map((i: any) => i.processedValue)),
        maxValue: Math.max(...processedData.processedItems.map((i: any) => i.processedValue)),
        processingStats: {
          itemsAboveAverage: 0,
          itemsBelowAverage: 0,
          averageDeviation: 0
        },
        detailedBreakdown: [] as any[]
      };
      
      // Complex aggregation loop for statistical analysis
      for (let i = 0; i < processedData.processedItems.length; i++) {
        const item = processedData.processedItems[i];
        await new Promise(resolve => setTimeout(resolve, processingDelay / 2));
        
        // Calculate statistics
        const deviation = Math.abs(item.processedValue - report.averageProcessedValue);
        
        report.detailedBreakdown.push({
          itemIndex: i,
          originalValue: item.originalValue,
          processedValue: item.processedValue,
          deviation,
          isAboveAverage: item.processedValue > report.averageProcessedValue
        });
      }
      
      report.processingStats = {
        itemsAboveAverage: report.detailedBreakdown.filter((i: any) => i.isAboveAverage).length,
        itemsBelowAverage: report.detailedBreakdown.filter((i: any) => !i.isAboveAverage).length,
        averageDeviation: report.detailedBreakdown.reduce((sum: any, i: any) => sum + i.deviation, 0) / report.detailedBreakdown.length
      };
      
      this.logger.log('Generated summary report', {
        itemsAnalyzed: report.detailedBreakdown.length,
        averageValue: report.averageProcessedValue,
        itemsAboveAverage: report.processingStats.itemsAboveAverage,
        itemsBelowAverage: report.processingStats.itemsBelowAverage,
        step: 'generate-summary-report'
      });
      return report;
    });

    // Step 5: Finalize and cleanup
    const finalResult = await step.run('finalize-complex-processing', () => {
      return {
        success: true,
        totalExecutionTime: Date.now() - new Date(initData.processingStarted).getTime(),
        itemsInitialized: initData.totalItems,
        itemsProcessed: processedData.processedItems.length,
        itemsAnalyzed: summaryReport.detailedBreakdown.length,
        finalAverageValue: summaryReport.averageProcessedValue,
        processingEfficiency: summaryReport.processingStats.averageDeviation,
        completedAt: new Date().toISOString()
      };
    });

    this.logger.log('Complex processing completed', {
      itemsProcessed: finalResult.itemsProcessed,
      totalExecutionTime: finalResult.totalExecutionTime,
      finalAverageValue: finalResult.finalAverageValue,
      processingEfficiency: finalResult.processingEfficiency,
      functionId: 'test-complex-handler',
      success: true
    });

    return {
      success: true,
      initData: {
        itemCount: initData.totalItems,
        processingStarted: initData.processingStarted
      },
      validation,
      processedData: {
        itemCount: processedData.processedItems.length,
        averageValue: processedData.averageValue
      },
      summaryReport: {
        totalAnalyzed: summaryReport.detailedBreakdown.length,
        stats: summaryReport.processingStats
      },
      finalResult,
      metadata: {
        requestedIterations: iterations,
        requestedDelay: processingDelay,
        actualExecutionTime: finalResult.totalExecutionTime
      }
    };
  }

  /**
   * Handle error test events - demonstrates error tracing
   */
  @InngestFunction({
    id: 'test-error-handler',
    triggers: { event: 'test.error' }
  })
  async handleErrorTest({ event, step, ctx }: any) {
    this.logger.log('Handling error test event', {
      shouldFail: event.data.shouldFail,
      errorType: event.data.errorType || 'validation',
      functionId: 'test-error-handler',
      eventType: 'test.error'
    });

    // Step 1: Validate input (this should succeed)
    const validation = await step.run('validate-error-test', () => {
      return {
        shouldFail: event.data.shouldFail,
        errorType: event.data.errorType || 'validation',
        timestamp: new Date().toISOString()
      };
    });

    // Step 2: Conditionally fail (this might fail to test error tracing)
    if (event.data.shouldFail) {
      try {
        await step.run('failing-step', () => {
          const errorType = event.data.errorType || 'validation';
          const message = event.data.message || 'Test error';
          
          switch (errorType) {
            case 'validation':
              throw new Error(`Validation Error: ${message}`);
            case 'network':
              throw new Error(`Network Error: ${message}`);
            case 'timeout':
              throw new Error(`Timeout Error: ${message}`);
            default:
              throw new Error(`Unknown Error: ${message}`);
          }
        });
      } catch (error) {
        // Log the error but don't rethrow - let the step handle it
        this.logger.error(`Step failed as expected: ${error.message}`);
        
        // Add a recovery step
        await step.run('error-recovery', () => {
          return {
            errorHandled: true,
            originalError: error.message,
            recoveredAt: new Date().toISOString()
          };
        });

        return {
          success: false,
          validation,
          error: error.message,
          recovered: true
        };
      }
    }

    // Step 3: Success path
    await step.run('success-step', () => {
      this.logger.log('Error test completed successfully (no error thrown)', {
        functionId: 'test-error-handler',
        step: 'success-step'
      });
      return {
        completed: true,
        timestamp: new Date().toISOString()
      };
    });

    return {
      success: true,
      validation,
      errorExpected: event.data.shouldFail,
      actuallyFailed: false
    };
  }

  /**
   * Test function for traceId propagation - sends events to trigger other functions
   */
  @InngestFunction({
    id: 'trace-propagation-test',
    name: 'TraceId Propagation Test Function',
    triggers: { event: 'test.trace.propagation' },
    retries: 1
  })
  async handleTracePropagationTest({ event, step, ctx }: any) {
    const { userId, testId, chainDepth = 2 } = event.data || {};
    
    this.logger.log('Starting trace propagation test', {
      testId,
      userId,
      chainDepth,
      functionId: 'trace-propagation-test',
      eventName: event.name
    });

    // Step 1: Get current trace context
    const traceContext = await step.run('get-trace-context', () => {
      const currentTrace = this.tracingService?.getCurrentTraceContext();
      return {
        hasTrace: !!currentTrace,
        traceId: currentTrace?.traceId,
        spanId: currentTrace?.spanId,
        timestamp: new Date().toISOString()
      };
    });

    // Step 2: Send event with automatic trace propagation
    await step.run('send-with-auto-trace', async () => {
      await this.inngestService.send({
        name: 'test.trace.child',
        data: {
          parentTestId: testId,
          userId,
          step: 1,
          chainDepth: chainDepth - 1,
          propagationType: 'automatic',
          parentTrace: traceContext.traceId
        }
      });
      
      return { eventSent: true, method: 'automatic' };
    });

    // Step 3: Send event with explicit trace context (if we have one)
    if (traceContext.hasTrace) {
      await step.run('send-with-explicit-trace', async () => {
        await this.inngestService.sendWithTraceId(
          {
            name: 'test.trace.child',
            data: {
              parentTestId: testId,
              userId,
              step: 2,
              chainDepth: chainDepth - 1,
              propagationType: 'explicit',
              parentTrace: traceContext.traceId
            }
          },
          {
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            traceFlags: 1
          }
        );
        
        return { eventSent: true, method: 'explicit' };
      });
    }

    return {
      success: true,
      testId,
      traceContext,
      eventsSent: 2
    };
  }

  /**
   * Child function for trace propagation testing
   */
  @InngestFunction({
    id: 'trace-child-handler',
    name: 'Trace Child Handler',
    triggers: { event: 'test.trace.child' },
    retries: 1
  })
  async handleTraceChild({ event, step, ctx }: any) {
    const { parentTestId, userId, step: stepNum, chainDepth, propagationType, parentTrace } = event.data || {};
    
    this.logger.log('Handling trace child event', {
      parentTestId,
      stepNum,
      chainDepth,
      propagationType,
      parentTrace,
      functionId: 'trace-child-handler'
    });

    // Step 1: Verify trace context was received
    const traceValidation = await step.run('validate-trace-context', () => {
      const currentTrace = this.tracingService?.getCurrentTraceContext();
      const eventTraceContext = event.data?.traceContext;
      
      return {
        hasCurrentTrace: !!currentTrace,
        currentTraceId: currentTrace?.traceId,
        hasEventTraceContext: !!eventTraceContext,
        eventTraceId: eventTraceContext?.traceId,
        tracesMatch: currentTrace?.traceId === eventTraceContext?.traceId,
        parentTraceMatch: currentTrace?.traceId === parentTrace,
        propagationType
      };
    });

    // Step 2: Continue the chain if depth > 0
    if (chainDepth > 0) {
      await step.run('continue-chain', async () => {
        await this.inngestService.send({
          name: 'test.trace.child',
          data: {
            parentTestId,
            userId,
            step: stepNum + 1,
            chainDepth: chainDepth - 1,
            propagationType: 'continued',
            parentTrace
          }
        });
        
        return { chainContinued: true, remainingDepth: chainDepth - 1 };
      });
    }

    // Step 3: Log final results
    await step.run('log-trace-results', () => {
      this.logger.log('Trace propagation step completed', {
        parentTestId,
        stepNum,
        traceValidation,
        isChainEnd: chainDepth <= 0
      });
      
      return {
        completed: true,
        timestamp: new Date().toISOString(),
        traceValidation
      };
    });

    return {
      success: true,
      parentTestId,
      stepNum,
      traceValidation,
      chainDepth
    };
  }

  /**
   * Complex workflow test with multiple sendEvent operations
   */
  @InngestFunction({
    id: 'complex-workflow-trace-test',
    name: 'Complex Workflow Trace Test',
    triggers: { event: 'test.complex.workflow' },
    retries: 2
  })
  async handleComplexWorkflowTrace({ event, step, ctx }: any) {
    const { workflowId, userId, branches = 3 } = event.data || {};
    
    this.logger.log('Starting complex workflow trace test', {
      workflowId,
      userId,
      branches,
      functionId: 'complex-workflow-trace-test'
    });

    // Step 1: Initialize workflow
    const initResult = await step.run('initialize-workflow', () => {
      const traceContext = this.tracingService?.getCurrentTraceContext();
      return {
        workflowId,
        startTime: new Date().toISOString(),
        traceId: traceContext?.traceId,
        plannedBranches: branches
      };
    });

    // Step 2: Send parallel events (simulating fan-out pattern)
    await step.run('fan-out-events', async () => {
      const eventPromises = Array.from({ length: branches }, (_, i) => 
        this.inngestService.send({
          name: 'test.workflow.branch',
          data: {
            workflowId,
            userId,
            branchId: `branch-${i}`,
            branchIndex: i,
            totalBranches: branches,
            parentTraceId: initResult.traceId
          }
        })
      );

      await Promise.all(eventPromises);
      return { eventsSent: branches, pattern: 'fan-out' };
    });

    // Step 3: Send aggregation event
    await step.run('send-aggregation-event', async () => {
      // Wait a bit for branches to potentially process
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await this.inngestService.send({
        name: 'test.workflow.aggregate',
        data: {
          workflowId,
          userId,
          expectedBranches: branches,
          aggregationType: 'final',
          parentTraceId: initResult.traceId
        }
      });
      
      return { aggregationSent: true };
    });

    return {
      success: true,
      workflowId,
      initResult,
      branchesSent: branches
    };
  }

  /**
   * Workflow branch handler for complex tracing
   */
  @InngestFunction({
    id: 'workflow-branch-handler',
    name: 'Workflow Branch Handler',
    triggers: { event: 'test.workflow.branch' },
    retries: 1
  })
  async handleWorkflowBranch({ event, step, ctx }: any) {
    const { workflowId, branchId, branchIndex, totalBranches, parentTraceId } = event.data || {};
    
    // Simulate some work with multiple steps
    const branchResult = await step.run('process-branch', async () => {
      const traceContext = this.tracingService?.getCurrentTraceContext();
      
      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 50 + branchIndex * 10));
      
      return {
        branchId,
        branchIndex,
        processedAt: new Date().toISOString(),
        traceId: traceContext?.traceId,
        traceMatchesParent: traceContext?.traceId === parentTraceId,
        processingTime: 50 + branchIndex * 10
      };
    });

    // Send completion event
    await step.run('send-branch-completion', async () => {
      await this.inngestService.send({
        name: 'test.workflow.branch.complete',
        data: {
          workflowId,
          branchId,
          branchIndex,
          branchResult,
          parentTraceId
        }
      });
      
      return { completionSent: true };
    });

    return {
      success: true,
      workflowId,
      branchResult
    };
  }

  /**
   * Error handling test with trace context preservation
   */
  @InngestFunction({
    id: 'error-trace-test',
    name: 'Error Trace Test Function',
    triggers: { event: 'test.error.trace' },
    retries: 3
  })
  async handleErrorTrace({ event, step, ctx }: any) {
    const { testId, userId, shouldRecover = false } = event.data || {};
    
    try {
      // Step 1: Log initial trace context
      const initialTrace = await step.run('log-initial-trace', () => {
        const traceContext = this.tracingService?.getCurrentTraceContext();
        return {
          testId,
          traceId: traceContext?.traceId,
          spanId: traceContext?.spanId,
          timestamp: new Date().toISOString()
        };
      });

      // Step 2: Intentionally fail
      await step.run('intentional-failure', () => {
        throw new Error(`Intentional error for trace test: ${testId}`);
      });

      // This should not be reached
      return { success: true, shouldNotReach: true };
      
    } catch (error) {
      // Step 3: Error recovery with trace preservation
      if (shouldRecover) {
        const recoveryResult = await step.run('error-recovery', async () => {
          const traceContext = this.tracingService?.getCurrentTraceContext();
          
          // Send recovery event
          await this.inngestService.send({
            name: 'test.error.recovered',
            data: {
              originalTestId: testId,
              userId,
              error: error.message,
              recoveryTraceId: traceContext?.traceId,
              recoveredAt: new Date().toISOString()
            }
          });
          
          return {
            recovered: true,
            traceId: traceContext?.traceId,
            error: error.message
          };
        });

        return {
          success: true,
          recovered: true,
          recoveryResult
        };
      }
      
      // Re-throw if not recovering
      throw error;
    }
  }
}
