import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // api/openapi.yaml composes every path under servers[].url (…/api/v1),
  // including the literal `/.well-known/jwks.json` entry — the contract is
  // authoritative (BUILD_HANDOFF §1), so the prefix applies with no
  // exclusions.
  app.setGlobalPrefix('api/v1');
  // Refresh token arrives as an HttpOnly cookie (PR-085) — needed to read
  // `bf_refresh` on /auth/refresh and /auth/logout.
  app.use(cookieParser());
  // 3000 is the container-internal port (api/Dockerfile EXPOSE 3000,
  // docker-compose.yml maps it to ${API_PORT}). Not user-configurable.
  await app.listen(3000);
}

void bootstrap();
