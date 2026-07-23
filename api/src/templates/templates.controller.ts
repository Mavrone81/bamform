import { Controller, Get, Param, Query } from '@nestjs/common';
import { TemplatesService } from './templates.service';

/** PR-021 `form_template` — read-only (see `templates.service.ts` header). */
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.templates.list({ limit, cursor });
  }

  @Get(':templateId')
  get(@Param('templateId') templateId: string) {
    return this.templates.get(templateId);
  }
}
