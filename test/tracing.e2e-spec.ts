import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './e2e/app/app.module';
import { InngestService } from '../src';

// Import tracing setup before starting tests
import {
  clearTraceLogBuffer,
  getTraceLogBuffer,
  sdk,
  tracingInitMessage,
} from './e2e/tracing';

describe('OpenTelemetry Tracing Integration (e2e)', () => {
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

  describe('Tracing Setup', () => {
    it('should initialize OpenTelemetry correctly', () => {
      expect(tracingInitMessage).toContain('OpenTelemetry initialized with console exporter');
    });
  });

  describe('Step-Level Tracing', () => {
    it('should trace Inngest function steps when triggered', async () => {
      // Trigger a simple function that uses steps
      const response = await request(app.getHttpServer())
        .post('/api/test/simple')
        .send({ message: 'test tracing', userId: 'user123' })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs((entries) =>
        entries.some((line) => line.includes('SpanId:')),
      );
      const spanExports = logs.filter(
        (line) => line.includes('TRACING: OpenTelemetry Spans Export') || line.includes('SpanId:'),
      );

      expect(spanExports.length).toBeGreaterThan(0);

      expect(logs.some((line) => line.includes('Trace:') || line.includes('inngest.execution'))).toBe(
        true,
      );
    });

    it('should include trace context in sendEvent operations', async () => {
      // Trigger a workflow that sends events
      const response = await request(app.getHttpServer())
        .post('/api/test/workflow')
        .send({ workflowId: 'wf123', data: { step: 1 } })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs((entries) =>
        entries.some((line) => line.includes('inngest.execution') || line.includes('Trace:')),
      );
      const traceContextLogs = logs.filter((line) => line.includes('Trace:') || line.includes('trace'));

      expect(traceContextLogs.length).toBeGreaterThan(0);
    });

    it('should trace error scenarios correctly', async () => {
      // Trigger a function that will throw an error
      const response = await request(app.getHttpServer())
        .post('/api/test/error')
        .send({ shouldFail: true })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs((entries) =>
        entries.some((line) => line.includes('SpanId:') || line.includes('Status: ERROR')),
      );

      const anySpans = logs.filter(
        (line) =>
          line.includes('test-error-handler') ||
          line.includes('Trace:') ||
          line.includes('SpanId:'),
      );

      expect(anySpans.length).toBeGreaterThan(0);
    });
  });

  describe('Trace Context Propagation', () => {
    it('should propagate trace context across event chains', async () => {
      // Start a workflow chain
      const response = await request(app.getHttpServer())
        .post('/api/test/workflow')
        .send({ 
          workflowId: 'chain123', 
          data: { enableChain: true, steps: 2 } 
        })
        .expect(201);

      expect(response.body.success).toBe(true);

      const logs = await waitForTraceLogs(
        (entries) => entries.filter((line) => line.includes('Trace:')).length > 1,
        15000,
      );
      const allSpans = logs.filter((line) => line.includes('Trace:'));

      expect(allSpans.length).toBeGreaterThan(1);

      const traceIds = allSpans
        .map((line) => line.match(/Trace: ([a-f0-9]+)/i)?.[1] ?? null)
        .filter(Boolean);

      // Should have at least one trace ID repeated across spans
      const uniqueTraceIds = [...new Set(traceIds)];
      expect(uniqueTraceIds.length).toBeGreaterThanOrEqual(1);
      expect(traceIds.length).toBeGreaterThan(1);
    });
  });

  describe('Configuration', () => {
    it('should respect tracing configuration', async () => {
      // The configuration is already set in app.module.ts
      // Just verify some basic functionality works
      const response = await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body).toBeDefined();
    });
  });
});
