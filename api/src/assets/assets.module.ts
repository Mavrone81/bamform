import { Module } from '@nestjs/common';
import {
  AssetDocumentPatchController,
  AssetDocumentsController,
} from './asset-documents.controller';
import { AssetDocumentsService } from './asset-documents.service';
import { AssetsController } from './assets.controller';
import { AssetsRepository } from './assets.repository';
import { AssetsService } from './assets.service';

/** `AreaScopeService` is provided globally by `CommonModule` — see `app.module.ts`. */
@Module({
  controllers: [AssetsController, AssetDocumentsController, AssetDocumentPatchController],
  providers: [AssetsService, AssetsRepository, AssetDocumentsService],
})
export class AssetsModule {}
