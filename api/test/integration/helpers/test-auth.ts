import type { INestApplication } from '@nestjs/common';
import { ACCESS_TOKEN_SERVICE } from '../../../src/auth/auth.tokens';
import type { AccessTokenService } from '../../../src/auth/jwt/access-token.service';

/**
 * Mints a real access token via the app's own `AccessTokenService` instance
 * (same signing key `JwtAuthGuard` verifies against), bypassing
 * `/auth/login`'s password/Argon2id path — this slice's tests are about
 * assets/templates authorisation and scoping, not re-proving slice 2's login
 * flow, which `auth-flow.spec.ts` already covers.
 */
export async function mintAccessToken(
  app: INestApplication,
  userId: string,
  roles: string[],
): Promise<string> {
  const accessTokens = app.get<AccessTokenService>(ACCESS_TOKEN_SERVICE);
  const signed = await accessTokens.sign(userId, roles);
  return signed.token;
}

export function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}
