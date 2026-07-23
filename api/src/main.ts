import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 3000 is the container-internal port (api/Dockerfile EXPOSE 3000,
  // docker-compose.yml maps it to ${API_PORT}). Not user-configurable.
  await app.listen(3000);
}

void bootstrap();
