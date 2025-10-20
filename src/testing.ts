/**
 * Testing utilities for @torixtv/nestjs-inngest
 *
 * Import from '@torixtv/nestjs-inngest/testing' in your test files
 * to avoid loading @nestjs/testing in production builds.
 */

export {
  createInngestTestingModule,
  MockInngestService,
  createMockInngestContext,
} from './utils/testing';
