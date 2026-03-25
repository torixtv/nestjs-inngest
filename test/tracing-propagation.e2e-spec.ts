import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './e2e/app/app.module';
import * as otelApi from '@opentelemetry/api';
import { InngestService } from '../src';

// Import tracing setup before starting tests
import {
  clearTraceLogBuffer,
  getTraceLogBuffer,
  sdk,
} from './e2e/tracing';

describe('TraceId Propagation Integration (e2e)', () => {
  let app: INestApplication;
  let consoleSpy: jest.SpyInstance;
  const port = 3101;

  async function waitForTraceLogs(
    predicate: (logs: string[]) => boolean,
    timeoutMs: number = 10000,
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const logs = getTraceLogBuffer();
      if (predicate(logs)) {
        return logs;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return getTraceLogBuffer();
  }

  beforeAll(async () => {
    // Spy on console.log to capture trace output
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(port, '127.0.0.1');

    await app
      .get(InngestService)
      .registerWithDevServer({ serveOrigin: 'http://127.0.0.1', servePort: port });

    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  afterAll(async () => {
    consoleSpy.mockRestore();
    await app.close();
    await sdk.shutdown();
  });

  beforeEach(() => {
    consoleSpy.mockClear();
    clearTraceLogBuffer();
  });

  describe('Client → Function TraceId Propagation', () => {
    it('should export trace metadata for requests with custom trace headers', async () => {
      // Generate a custom trace ID following OpenTelemetry format (32 chars hex)
      const customTraceId = '12345678901234567890123456789012';
      const customSpanId = '1234567890123456';
      
      // Send event with custom trace context in headers
      const response = await request(app.getHttpServer())
        .post('/api/test/simple')
        .set('traceparent', `00-${customTraceId}-${customSpanId}-01`)
        .send({ 
          message: 'test trace propagation',
          userId: 'user-trace-123',
          traceTest: true
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs((entries) =>
        entries.some((line) => line.includes('Trace:') || line.includes('traceparent:')),
      );

      expect(logs.some((line) => line.includes('Trace:') || line.includes('traceparent:'))).toBe(
        true,
      );
    });

    it('should include trace metadata when trace context is passed in event data', async () => {
      // Generate custom trace context
      const customTraceId = '98765432109876543210987654321098';
      
      // Send event with trace context in event data
      const response = await request(app.getHttpServer())
        .post('/api/test/simple')
        .send({ 
          message: 'test data trace propagation',
          userId: 'user-data-trace-456',
          traceContext: {
            traceId: customTraceId,
            spanId: '9876543210987654',
            traceFlags: 1
          }
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs((entries) =>
        entries.some((line) => line.includes('Trace:') || line.includes('traceref:')),
      );

      expect(logs.some((line) => line.includes('Trace:') || line.includes('traceref:'))).toBe(
        true,
      );
    });
  });

  describe('Function → Function TraceId Propagation via sendEvent', () => {
    it('should export execution spans when a function uses step.sendEvent', async () => {
      // Start a workflow that will send events to other functions
      const response = await request(app.getHttpServer())
        .post('/api/test/user-onboarding')
        .send({ 
          userId: 'user-workflow-789',
          email: 'test@example.com',
          enableEmailNotification: true
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const allLogs = (
        await waitForTraceLogs(
          (entries) => entries.some((line) => line.includes('inngest.execution')),
          15000,
        )
      ).join(' ');
      const traceIdMatches = allLogs.match(/Trace: ([a-f0-9]{32})/gi) || [];
      const traceIds = traceIdMatches.map(match => match.split(': ')[1]);

      expect(traceIds.length).toBeGreaterThan(1);
      expect(allLogs).toContain('inngest.execution');
    });

    it('should emit multiple traces across complex workflow chains', async () => {
      // Generate a specific trace context for this test
      const testTraceId = 'aaaabbbbccccddddeeeeffff11112222';
      
      // Trigger a complex workflow with custom trace
      const response = await request(app.getHttpServer())
        .post('/api/test/workflow')
        .set('traceparent', `00-${testTraceId}-1234567890123456-01`)
        .send({ 
          workflowId: 'complex-chain-test',
          data: { 
            enableChain: true, 
            steps: 3,
            userId: 'user-complex-chain'
          }
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs(
        (entries) => entries.filter((line) => line.includes('Trace:')).length > 1,
        15000,
      );
      const traceCount = logs.filter((line) => line.includes('Trace:')).length;

      expect(traceCount).toBeGreaterThan(1);
    });
  });

  describe('Error Scenarios with TraceId Propagation', () => {
    it('should emit error-related spans for failing executions', async () => {
      const errorTraceId = '11112222333344445555666677778888';
      
      // Trigger a function that will throw an error
      const response = await request(app.getHttpServer())
        .post('/api/test/error')
        .set('traceparent', `00-${errorTraceId}-9999888877776666-01`)
        .send({ 
          shouldFail: true,
          userId: 'user-error-test'
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const allLogs = (
        await waitForTraceLogs(
          (entries) =>
            entries.some((line) => line.includes('SpanId:') || line.includes('Trace:')),
          15000,
        )
      ).join(' ');

      expect(allLogs.includes('SpanId:') || allLogs.includes('Trace:')).toBe(true);
    });
  });

  describe('Performance and Context Validation', () => {
    it('should export traces without leaking event payload data by default', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/test/simple')
        .send({ 
          message: 'business context test',
          userId: 'business-user-123',
          tenantId: 'tenant-456',
          metadata: {
            source: 'test-suite',
            version: '1.0.0'
          }
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const allLogs = (
        await waitForTraceLogs((entries) => entries.some((line) => line.includes('SpanId:')))
      ).join(' ');

      expect(allLogs).toContain('SpanId:');
      expect(allLogs).not.toContain('business-user-123');
      expect(allLogs).not.toContain('tenant-456');
    });

    it('should measure trace propagation performance', async () => {
      const startTime = Date.now();
      
      // Send multiple concurrent requests to test performance
      const promises = Array.from({ length: 5 }, (_, i) => 
        request(app.getHttpServer())
          .post('/api/test/simple')
          .send({ 
            message: `concurrent test ${i}`,
            userId: `perf-user-${i}`,
            requestId: i
          })
      );

      const responses = await Promise.all(promises);
      const endTime = Date.now();
      
      responses.forEach(response => {
        expect(response.status).toBe(201);
      });

      await waitForTraceLogs((entries) => entries.some((line) => line.includes('SpanId:')), 15000);
      const executionTime = endTime - startTime;
      const totalSpans = getTraceLogBuffer().filter((line) => line.includes('SpanId:')).length;

      console.log('⚡ Performance Metrics:', {
        concurrentRequests: 5,
        executionTime: `${executionTime}ms`,
        totalSpans,
        avgTimePerSpan: `${(executionTime / Math.max(totalSpans, 1)).toFixed(2)}ms`
      });

      // Basic performance validation
      expect(executionTime).toBeLessThan(10000); // Should complete within 10 seconds
      expect(totalSpans).toBeGreaterThan(0);
    });
  });

  describe('Trace Context Extraction and Injection', () => {
    it('should export manual parent spans alongside request spans', async () => {
      // Test that we can create a manual trace context
      const tracer = otelApi.trace.getTracer('test-tracer');
      
      await tracer.startActiveSpan('manual-test-span', async (span) => {
        const spanContext = span.spanContext();
        const testTraceId = spanContext.traceId;
        
        // Make a request within this span context
        const response = await request(app.getHttpServer())
          .post('/api/test/simple')
          .send({ 
            message: 'manual trace context test',
            userId: 'manual-trace-user'
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        
        span.end();
        
        const allLogs = (
          await waitForTraceLogs(
            (entries) =>
              entries.some((line) => line.includes('manual-test-span')) &&
              entries.some((line) => line.includes('SpanId:')),
            15000,
          )
        ).join(' ');

        expect(allLogs).toContain('manual-test-span');
        expect(allLogs).toContain('SpanId:');
      });
    });
  });
});
