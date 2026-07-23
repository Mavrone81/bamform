import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsRepository } from './assets.repository';
import { AssetsService } from './assets.service';

/** `AreaScopeService` is provided globally by `CommonModule` — see `app.module.ts`. */
@Module({
  controllers: [AssetsController],
  providers: [AssetsService, AssetsRepository],
})
export class AssetsModule {}
