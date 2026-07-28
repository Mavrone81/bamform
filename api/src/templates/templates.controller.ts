import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { createTemplateRequestSchema, type CreateTemplateRequest } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TemplatesService } from './templates.service';

/**
 * PR-021 `form_template`. Reads are open to any authenticated user;
 * `POST` (slice 13-TL) exists solely for BAMFORM-TLP-001's template load —
 * see `templates.service.ts`'s header — and is gated to ENGINEER/
 * DOC_CONTROLLER, mirroring the revision-authoring endpoints
 * (`revisions.controller.ts`) that carry the template's actual content.
 */
@Controller('templates')
@UseGuards(RolesGuard)
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

  @Post()
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createTemplateRequestSchema)) dto: CreateTemplateRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.templates.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
