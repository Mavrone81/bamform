import { Module } from '@nestjs/common';
import { ApprovalRoutesController } from './approval-routes.controller';
import { AssetTypesController } from './asset-types.controller';
import { AssetTypesService } from './asset-types.service';

@Module({
  controllers: [AssetTypesController, ApprovalRoutesController],
  providers: [AssetTypesService],
})
export class AssetTypesModule {}
