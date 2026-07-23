import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../../src/app.module';

/** Boots the real app the way `main.ts` does (prefix + cookie parser), against real Postgres/Redis. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  await app.init();
  return app;
}
