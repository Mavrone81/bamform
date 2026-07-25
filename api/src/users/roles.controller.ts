import { Controller, Get, Query } from '@nestjs/common';
import { RolesService } from './roles.service';

/** UR-073 `role` catalogue — any authenticated user (see `roles.service.ts`). */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.roles.list({ limit, cursor });
  }
}
