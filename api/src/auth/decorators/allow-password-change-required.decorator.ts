import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_REQUIRED_KEY = 'allowPasswordChangeRequired';

/**
 * Brief §7: while `app_user.must_change_password` is true, EVERY endpoint
 * except `/auth/me`, `/auth/password` and `/auth/logout` returns
 * `403 /errors/password-change-required`.
 *
 * `PasswordChangeRequiredGuard` is deny-by-default: a handler is blocked
 * unless it carries this decorator, so a new endpoint added in a later slice
 * is closed to a forced-change user automatically, without anyone
 * remembering to think about it.
 */
export const AllowPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true);
