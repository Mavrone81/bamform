import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Seam for later slices' authorisation, per PR-090 ("RBAC shall be enforced
 * by a service-layer guard on every handler"). No slice-2 endpoint attaches
 * this — login/refresh/jwks are public and logout/step-up/me require only
 * authentication, not a specific role — but the mechanism is built now so
 * PR-090 has somewhere to attach without a later slice inventing its own.
 */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
