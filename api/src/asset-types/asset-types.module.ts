import { Module } from '@nestjs/common';
import { AssetTypesController } from './asset-types.controller';
import { AssetTypesService } from './asset-types.service';

@Module({
  controllers: [AssetTypesController],
  providers: [AssetTypesService],
})
export class AssetTypesModule {}
