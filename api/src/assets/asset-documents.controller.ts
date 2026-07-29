import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  assetDocumentCreateSchema,
  assetDocumentUpdateSchema,
  type AssetDocumentCreate,
  type AssetDocumentUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AssetDocumentsService } from './asset-documents.service';

/**
 * Slice 27-ASSETDOC §4.6 — `api/openapi.yaml`
 * `/assets/{assetId}/documents` and `/asset-documents/{id}`.
 *
 * Deliberately NO DELETE route: INV-16 forbids DELETE on record tables, and a
 * document that has generated jobs must remain resolvable. `PATCH { active:
 * false }` is the removal.
 */
@Controller('assets/:assetId/documents')
@UseGuards(RolesGuard)
export class AssetDocumentsController {
  constructor(private readonly documents: AssetDocumentsService) {}

  /**
   * Deliberately carries NO `@Roles()`: this is the maintainer's form picker
   * (owner's process step 4 — "select the form to start"), so every
   * authenticated user who can see the machine can read it. Area-scoped inside
   * the service, exactly as `GET /assets/{assetId}/schedule` is.
   *
   * Named `getDocuments`, not `list*`: it returns a small, fixed-cardinality
   * set scoped to ONE already-in-scope-checked machine, not a tenant-wide
   * paginated collection (the `test:scope-coverage` `list*` convention).
   */
  @Get()
  getDocuments(@Param('assetId') assetId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.documents.list(user.sub, assetId);
  }

  /** Tagging a document to a machine is an ADMIN act (owner's process step 2). */
  @Post()
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  tag(
    @Param('assetId') assetId: string,
    @Body(new ZodValidationPipe(assetDocumentCreateSchema)) dto: AssetDocumentCreate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.documents.create(user.sub, assetId, dto, {
      actorId: user.sub,
      ...requestMeta(req),
    });
  }
}

/** Separate controller only because the path is not nested under an asset. */
@Controller('asset-documents')
@UseGuards(RolesGuard)
export class AssetDocumentPatchController {
  constructor(private readonly documents: AssetDocumentsService) {}

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assetDocumentUpdateSchema)) dto: AssetDocumentUpdate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.documents.update(user.sub, id, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
