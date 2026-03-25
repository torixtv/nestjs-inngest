import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { InngestService } from '../../src';
import { AppModule } from './app/app.module';
import { DecoratorConnectAppModule } from './app/decorator-connect-app.module';

export const DECORATOR_TEST_APP_ID = 'nestjs-integration-test-v4';
export const DECORATOR_TEST_DEV_SERVER_URL = 'http://127.0.0.1:8288';
export const DECORATOR_TEST_PORT = 3101;
export const CONNECT_DECORATOR_TEST_APP_ID = 'nestjs-integration-connect-test-v4';
export const CONNECT_DECORATOR_TEST_PORT = 3102;

export interface DevServerFunctionRecord {
  name: string;
  slug: string;
  config: string;
  failureHandler?: {
    name: string;
    slug: string;
  } | null;
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

export async function bootstrapDecoratorTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  await app.listen(DECORATOR_TEST_PORT, '127.0.0.1');

  await deleteRegisteredApp(DECORATOR_TEST_APP_ID);

  await app.get(InngestService).registerWithDevServer({
    serveOrigin: 'http://127.0.0.1',
    servePort: DECORATOR_TEST_PORT,
  });

  return app;
}

export async function bootstrapConnectDecoratorTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [DecoratorConnectAppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  await app.listen(CONNECT_DECORATOR_TEST_PORT, '127.0.0.1');

  await deleteRegisteredApp(CONNECT_DECORATOR_TEST_APP_ID);
  await app.get(InngestService).establishConnection();

  return app;
}

export async function queryDevServer<TData>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const response = await fetch(`${DECORATOR_TEST_DEV_SERVER_URL}/v0/gql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dev server GraphQL request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GraphQLResponse<TData>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }

  if (!payload.data) {
    throw new Error('Dev server GraphQL request returned no data');
  }

  return payload.data;
}

export async function fetchRegisteredFunctionsByAppId(
  appId: string,
): Promise<DevServerFunctionRecord[]> {
  const data = await queryDevServer<{
    apps: Array<{
      externalID: string;
      functions: DevServerFunctionRecord[];
    }>;
  }>(`
    query DecoratorVerificationApps {
      apps {
        externalID
        functions {
          name
          slug
          config
          failureHandler {
            name
            slug
          }
        }
      }
    }
  `);

  return data.apps.find((app) => app.externalID === appId)?.functions || [];
}

export async function fetchRegisteredFunctions(): Promise<DevServerFunctionRecord[]> {
  return fetchRegisteredFunctionsByAppId(DECORATOR_TEST_APP_ID);
}

export async function deleteRegisteredApp(name: string) {
  try {
    await queryDevServer<{
      deleteAppByName: boolean;
    }>(
      `
        mutation DeleteDecoratorVerificationApp($name: String!) {
          deleteAppByName(name: $name)
        }
      `,
      { name },
    );
  } catch (error) {
    // The app may not exist yet; deletion is best-effort cleanup for deterministic tests.
  }
}

export async function waitForRegisteredFunctions(
  expectedNames: string[],
  timeoutMs: number = 20000,
): Promise<DevServerFunctionRecord[]> {
  return waitForRegisteredFunctionsForApp(DECORATOR_TEST_APP_ID, expectedNames, timeoutMs);
}

export async function waitForRegisteredFunctionsForApp(
  appId: string,
  expectedNames: string[],
  timeoutMs: number = 20000,
): Promise<DevServerFunctionRecord[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const functions = await fetchRegisteredFunctionsByAppId(appId);
    const names = new Set(functions.map((fn) => fn.name));

    if (expectedNames.every((name) => names.has(name))) {
      return functions;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const functions = await fetchRegisteredFunctionsByAppId(appId);
  throw new Error(
    `Timed out waiting for decorator verification functions for ${appId}. Saw: ${functions
      .map((fn) => fn.name)
      .join(', ')}`,
  );
}

export function parseFunctionConfig(functionRecord: DevServerFunctionRecord): any {
  return JSON.parse(functionRecord.config);
}

export async function resetDecoratorState(app: INestApplication) {
  await request(app.getHttpServer()).post('/api/test/decorators/reset').expect(201);
}

export async function fetchDecoratorSdkConfig(app: INestApplication) {
  const response = await request(app.getHttpServer())
    .get('/api/test/decorators/config')
    .expect(200);

  return response.body as {
    functions: Array<{
      name: string;
      opts: {
        idempotency?: string;
        optimizeParallelism?: boolean;
        checkpointing?: boolean | Record<string, any>;
        middlewareCount?: number;
      };
      computed: {
        optimizeParallelism?: boolean;
        checkpointing?: Record<string, any>;
      };
    }>;
  };
}

export async function fetchDecoratorState(app: INestApplication) {
  const response = await request(app.getHttpServer())
    .get('/api/test/decorators/state')
    .expect(200);

  return response.body;
}

export async function waitForDecoratorState(
  app: INestApplication,
  predicate: (state: any) => boolean,
  timeoutMs: number = 15000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await fetchDecoratorState(app);
    if (predicate(state)) {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return fetchDecoratorState(app);
}

export async function waitForConnectHealth(
  app: INestApplication,
  predicate: (health: ReturnType<InngestService['getConnectionHealth']>) => boolean,
  timeoutMs: number = 20000,
) {
  const service = app.get(InngestService);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const health = service.getConnectionHealth();
    if (predicate(health)) {
      return health;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return service.getConnectionHealth();
}
