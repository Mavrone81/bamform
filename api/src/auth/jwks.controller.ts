import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { JWT_KEYS_SERVICE } from './jwt/jwt-keys.module';
import type { JwtKeysService } from './jwt/jwt-keys.service';

/**
 * `GET /.well-known/jwks.json` — PR-087. Combined with the global `api/v1`
 * prefix (`main.ts`), this serves at `/api/v1/.well-known/jwks.json`,
 * matching `api/openapi.yaml`'s literal `servers[].url` + `paths` composition.
 */
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(JWT_KEYS_SERVICE) private readonly jwtKeys: JwtKeysService) {}

  @Public()
  @Get('jwks.json')
  getJwks() {
    return this.jwtKeys.getJwks();
  }
}
