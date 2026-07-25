import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../../../src/worker.module';

/**
 * Boots the REAL `bamform-worker` module graph (`WorkerModule` — the same
 * one `worker.ts` bootstraps in production), so PDF-render/export
 * integration tests exercise the actual two-process topology
 * (`api` enqueues via BullMQ, `worker` consumes and renders with real
 * Chromium — PR-117) rather than calling the render service in-process.
 * `PdfWorkerService`/`NotificationWorkerService` start their BullMQ
 * `Worker`s automatically on `onModuleInit` (NestJS lifecycle), exactly as
 * they would in the real `bamform-worker` container — no extra wiring
 * needed here beyond creating the application context.
 */
export async function createTestWorkerApp(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
}
