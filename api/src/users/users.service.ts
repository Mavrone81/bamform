import { Inject, Injectable } from '@nestjs/common';
import { AuditActionT, Prisma, UserStatusT } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { User, UserAreaScopeSet, UserCreate, UserUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { BLIND_INDEX_KEY } from '../auth/auth.tokens';
import { computeEmailBlindIndex, computeEmployeeIdBlindIndex } from '../auth/crypto/blind-index';
import { decodeIdentityField, encodeIdentityField } from '../auth/crypto/identity-codec';
import { PasswordPolicyConfig } from '../auth/password/password-policy.config';
import { PasswordService } from '../auth/password/password.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  conflictProblem,
  notFoundProblem,
  validationFailedProblem,
} from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { toBytes } from '../common/prisma-bytes';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { toUser, toUserAuditView, type AppUserWithRoles } from './users.mapper';

export interface ListUsersParams {
  limit?: unknown;
  cursor?: string;
  roleCode?: string;
  active?: string;
}

export interface BootstrapAdminInput {
  fullName: string;
  email: string;
  password: string;
}

const USER_ROLES_INCLUDE = {
  userRoles: { where: { active: true }, include: { role: true } },
  // Slice 13-UI-B (SYS-10): `active: false` rows are soft-removed scopes —
  // never reported as held (same contract as `userRoles` above).
  userAreaScopes: { where: { active: true } },
} satisfies Prisma.AppUserInclude;

/**
 * PR-037/UR-072 `app_user` administration — ADMIN only (enforced by
 * `@Roles('ADMIN')` on `UsersController`, UR-074's server-side re-check).
 * Reuses slice-2/3's real crypto path (`field-encryption.ts` +
 * `auth/crypto/identity-codec.ts` + `auth/crypto/blind-index.ts`) exactly the
 * way the integration test helper `createLoginableUser`
 * (`api/test/integration/helpers/auth-fixtures.ts`) does — this is that same
 * shape, now reachable through the real API instead of only test fixtures.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly passwordPolicy: PasswordPolicyConfig,
    private readonly audit: AuditEventService,
    @Inject(BLIND_INDEX_KEY) private readonly blindIndexKey: Buffer,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  async list(params: ListUsersParams): Promise<Page<User>> {
    const limit = normaliseLimit(params.limit);
    const afterId = decodeCursor(params.cursor);

    const where: Prisma.AppUserWhereInput = {
      id: afterId ? { gt: afterId } : undefined,
      status:
        params.active === 'false'
          ? { not: UserStatusT.active }
          : params.active === 'true'
            ? UserStatusT.active
            : undefined,
      userRoles: params.roleCode
        ? { some: { active: true, role: { code: params.roleCode } } }
        : undefined,
    };

    const rows = await this.prisma.appUser.findMany({
      where,
      include: USER_ROLES_INCLUDE,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = paginate(rows, limit);
    return { data: page.data.map((row) => toUser(row, this.fieldEncryption)), page: page.page };
  }

  async get(id: string): Promise<User> {
    const row = await this.findOrThrow(id);
    return toUser(row, this.fieldEncryption);
  }

  /**
   * Admin-created-user password mechanism: ADMIN-SET, not a generated
   * temp-password/invite-email flow (there is still no SMTP wiring).
   * `dto.password` is required, hashed with the same
   * `PasswordService`/Argon2id as a normal login password, and NEVER echoed
   * back in the response (`User` — `shared/src/user.ts` — has no password
   * field at all).
   *
   * Slice 13-MFA §7 closes the gap slice 13a's report flagged as a concern:
   * the created user gets `must_change_password = true`, so the admin-known
   * credential is only good for the one round trip that replaces it
   * (`POST /auth/password`).
   *
   * ...but only when `FORCE_PASSWORD_CHANGE_ENABLED` is on, and it defaults
   * OFF (review finding I-3, `PasswordPolicyConfig`). The password-change
   * SCREEN ships in slice 13-UI, so forcing the change before then would give
   * the first user created after deploy a 403 on every page and no way to
   * clear it. Same hazard, same mitigation, same default as `MFA_ENABLED`.
   */
  async create(dto: UserCreate, actor: ActorMeta): Promise<User> {
    const roles = await this.rolesByCode(dto.roleCodes);

    const userId = uuidv7();
    const passwordHash = await this.passwordService.hash(dto.password);
    const emailBidx = computeEmailBlindIndex(dto.email, this.blindIndexKey);
    const fullName = encodeIdentityField(
      dto.fullName,
      { column: 'full_name_ct', rowId: userId },
      this.fieldEncryption,
    );
    const email = encodeIdentityField(
      dto.email,
      { column: 'email_ct', rowId: userId },
      this.fieldEncryption,
    );
    const employeeId = dto.employeeId
      ? encodeIdentityField(
          dto.employeeId,
          { column: 'employee_id_ct', rowId: userId },
          this.fieldEncryption,
        )
      : undefined;
    const employeeIdBidx = dto.employeeId
      ? computeEmployeeIdBlindIndex(dto.employeeId, this.blindIndexKey)
      : undefined;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.appUser.create({
          data: {
            id: userId,
            fullNameCt: toBytes(fullName.ciphertext),
            emailCt: toBytes(email.ciphertext),
            emailBidx: toBytes(emailBidx),
            employeeIdCt: employeeId ? toBytes(employeeId.ciphertext) : undefined,
            employeeIdBidx: employeeIdBidx ? toBytes(employeeIdBidx) : undefined,
            passwordHash,
            // Slice 13-MFA §7 — the admin chose this password, so the admin
            // knows it. The user is authenticated normally but blocked from
            // every endpoint except /auth/me, /auth/password and
            // /auth/logout until they change it
            // (`PasswordChangeRequiredGuard`). Only ever set for users
            // created FROM NOW ON: the column defaults to false and no
            // migration back-fills it, so existing accounts — including the
            // live production admin — are untouched.
            //
            // Gated on FORCE_PASSWORD_CHANGE_ENABLED (default false) until
            // slice 13-UI ships a password-change screen — see the method
            // comment and `PasswordPolicyConfig`.
            mustChangePassword: this.passwordPolicy.forceChangeOnAdminCreatedUsers,
            dekVersion: fullName.dekVersion,
            status: UserStatusT.active,
          },
        });

        for (const role of roles) {
          await tx.userRole.create({
            data: { userId: row.id, roleId: role.id, grantedBy: actor.actorId },
          });
        }

        const withRoles: AppUserWithRoles = {
          ...row,
          userRoles: roles.map((role) => ({
            userId: row.id,
            roleId: role.id,
            grantedBy: actor.actorId,
            grantedAt: new Date(),
            active: true,
            role,
          })),
          // A user is created UNRESTRICTED; scopes are assigned afterwards
          // via `PUT /users/{userId}/area-scopes` (SYS-10).
          userAreaScopes: [],
        };
        const after = toUser(withRoles, this.fieldEncryption);

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'user',
          entityId: row.id,
          // CR-5/PR-SEC-02 — NEVER the decrypted `User` object: audit rows
          // are append-only, 7-year-retained JSON, so a decrypted name/email
          // written here is a permanent plaintext copy. The audit view holds
          // non-personal fields + ciphertext digests only.
          after: toUserAuditView(withRoles),
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return after;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem('A user with this email already exists.');
      }
      throw error;
    }
  }

  /**
   * One-time first-ADMIN bootstrap (design 2026-07-31). BamForm seeds roles
   * but no users, and `POST /users` needs an ADMIN — so a fresh system has
   * no way to make its first account. This is the only path that creates a
   * user with no acting admin, run once by an operator via
   * `dist/bootstrap-admin.js`.
   *
   * Fail-closed: refuses if ANY user exists. The count check, the insert,
   * the role grant, and the audit write all share one transaction, so the
   * guard and the write commit atomically — a tripped guard rolls the whole
   * thing back and writes nothing. That is NOT the same as race-freedom:
   * Prisma runs at Postgres' default READ COMMITTED (no isolationLevel is
   * configured here), and `count()` takes no predicate/range lock, so two
   * genuinely concurrent invocations could both observe zero users and both
   * insert. This is deliberately left undefended — bootstrap is a manual,
   * one-shot CLI run once by a human operator against an empty system, not
   * a concurrent-request code path, so hardening it with locking or
   * SERIALIZABLE isolation would be defending against a scenario that does
   * not occur. The ADMIN role is self-attributed
   * (`granted_by = the new user's own id`) because `user_role.granted_by`
   * is NOT NULL and there is no external actor. `must_change_password` is
   * false: the operator chose this password at a prompt, so the
   * admin-known-temporary-credential rationale (see `create`) does not apply.
   *
   * Reuses the exact crypto path `create` uses so the row is a valid,
   * loginable account; assumes `dto` is already validated by the caller
   * (the CLI validates against the same policy as `userCreateSchema`).
   */
  async bootstrapFirstAdmin(dto: BootstrapAdminInput): Promise<User> {
    const roles = await this.rolesByCode(['ADMIN']);

    const userId = uuidv7();
    const passwordHash = await this.passwordService.hash(dto.password);
    const emailBidx = computeEmailBlindIndex(dto.email, this.blindIndexKey);
    const fullName = encodeIdentityField(
      dto.fullName,
      { column: 'full_name_ct', rowId: userId },
      this.fieldEncryption,
    );
    const email = encodeIdentityField(
      dto.email,
      { column: 'email_ct', rowId: userId },
      this.fieldEncryption,
    );

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appUser.count();
      if (existing > 0) {
        throw new Error(
          `Bootstrap refused: ${existing} user(s) already exist. ` +
            'The first-admin bootstrap only runs on an empty system.',
        );
      }

      const row = await tx.appUser.create({
        data: {
          id: userId,
          fullNameCt: toBytes(fullName.ciphertext),
          emailCt: toBytes(email.ciphertext),
          emailBidx: toBytes(emailBidx),
          passwordHash,
          mustChangePassword: false,
          dekVersion: fullName.dekVersion,
          status: UserStatusT.active,
        },
      });

      await tx.userRole.create({
        // Self-grant: no external actor exists for the very first user.
        data: { userId: row.id, roleId: roles[0].id, grantedBy: row.id },
      });

      const withRoles: AppUserWithRoles = {
        ...row,
        userRoles: [
          {
            userId: row.id,
            roleId: roles[0].id,
            grantedBy: row.id,
            grantedAt: new Date(),
            active: true,
            role: roles[0],
          },
        ],
        userAreaScopes: [],
      };
      const after = toUser(withRoles, this.fieldEncryption);

      await this.audit.record(tx, {
        actorId: row.id,
        action: AuditActionT.create,
        entityType: 'user',
        entityId: row.id,
        after: toUserAuditView(withRoles),
      });

      return after;
    });
  }

  /**
   * PR-039/UR-075: no hard delete — `active: false` is the only removal
   * mechanism (sets `status: deactivated` + `deactivatedAt`). `roleCodes`,
   * when present, REPLACES the role set: `bamform_app` has no `DELETE` grant
   * on any table (INV-16), so a role dropped from the set is soft-revoked
   * (`user_role.active = false`, upserted, never deleted) rather than
   * removed — matching `delegation.revokedAt` / `template_item.active`'s
   * existing soft-remove convention. Produces a separate
   * `permission_change` audit event (API_SPECIFICATION.md §10.9) distinct
   * from the `update` event any other field change produces.
   */
  async update(id: string, dto: UserUpdate, actor: ActorMeta): Promise<User> {
    const existing = await this.findOrThrow(id);
    const before = toUser(existing, this.fieldEncryption);

    const personalFieldsChanged = dto.fullName !== undefined || dto.email !== undefined;
    const activeChanged = dto.active !== undefined;

    // SYS-11 (slice 15-SYSWIRE) — with one admin in production, a single
    // mistaken self-PATCH (deactivate, or drop own ADMIN role) is instant
    // total admin lockout; 13a's enforcement makes it bite at the next token
    // refresh and recovery is psql surgery on the box. Guard: acting on
    // YOURSELF in a way that removes your admin capability is rejected when
    // no OTHER active user holds an active ADMIN role. Deliberately
    // last-admin-scoped, not a blanket self-deactivation ban — with a second
    // admin present, deactivating yourself is legitimate (and the MFA
    // runbook's "create a second ADMIN first" advice becomes enforced).
    const isSelfDeactivation = id === actor.actorId && dto.active === false;
    const dropsOwnAdmin =
      id === actor.actorId &&
      dto.roleCodes !== undefined &&
      before.roles.includes('ADMIN') &&
      !dto.roleCodes.includes('ADMIN');
    const needsLastAdminGuard = isSelfDeactivation || dropsOwnAdmin;

    const currentEmployeeId = existing.employeeIdCt
      ? decodeIdentityField(
          existing.employeeIdCt,
          existing.dekVersion,
          { column: 'employee_id_ct', rowId: id },
          this.fieldEncryption,
        )
      : undefined;

    // `dek_version` is ONE column shared by all three ciphertext columns
    // (field-encryption.ts's header) — touching just one of fullName/email
    // requires re-encrypting ALL of them under the CURRENT version together,
    // or a rotation that happened between row-creation and this PATCH would
    // leave the untouched column(s) encrypted under a version this row no
    // longer claims to use.
    const fullNameEnc = personalFieldsChanged
      ? encodeIdentityField(
          dto.fullName ?? before.fullName,
          { column: 'full_name_ct', rowId: id },
          this.fieldEncryption,
        )
      : undefined;
    const emailEnc = personalFieldsChanged
      ? encodeIdentityField(
          dto.email ?? before.email,
          { column: 'email_ct', rowId: id },
          this.fieldEncryption,
        )
      : undefined;
    const employeeIdEnc =
      personalFieldsChanged && currentEmployeeId
        ? encodeIdentityField(
            currentEmployeeId,
            { column: 'employee_id_ct', rowId: id },
            this.fieldEncryption,
          )
        : undefined;
    const emailBidx =
      dto.email !== undefined ? computeEmailBlindIndex(dto.email, this.blindIndexKey) : undefined;

    const requestedRoleCodes = dto.roleCodes;
    const desiredRoles = requestedRoleCodes
      ? await this.rolesByCode(requestedRoleCodes)
      : undefined;
    const existingActiveRoleCodes = [...before.roles].sort();
    const rolesChanged =
      requestedRoleCodes !== undefined &&
      JSON.stringify([...requestedRoleCodes].sort()) !== JSON.stringify(existingActiveRoleCodes);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // SYS-11 (slice 15-SYSWIRE) + review finding W-1: with one admin in
        // production, a single mistaken self-PATCH (deactivate, or drop own
        // ADMIN role) is instant total admin lockout; 13a's enforcement makes
        // it bite at the next token refresh and recovery is psql surgery on
        // the box. Guard: acting on YOURSELF in a way that removes your admin
        // capability is rejected when no OTHER active user holds an active
        // ADMIN role. Deliberately last-admin-scoped — with a second admin
        // present, deactivating yourself is legitimate (and the MFA runbook's
        // "create a second ADMIN first" advice becomes enforced).
        //
        // The check runs INSIDE the transaction with FOR UPDATE row locks:
        // the original outside-the-transaction count was raceable — the
        // reviewer proved two concurrent self-deactivations of the last TWO
        // admins both passed the count and reached zero active admins.
        // Locking every currently-active admin row (ORDER BY id, so two
        // racers acquire locks in the same order and serialise instead of
        // deadlocking) forces the second racer to wait for the first commit,
        // after which its recount sees no other admin and 409s. A concurrent
        // admin-role revocation by someone else serialises the same way: it
        // must update this same app_user row, whose lock we hold.
        if (needsLastAdminGuard) {
          const otherActiveAdmins = await tx.$queryRaw<{ id: string }[]>`
            SELECT u."id"
              FROM "app_user" u
             WHERE u."status" = 'active'
               AND EXISTS (
                     SELECT 1
                       FROM "user_role" ur
                       JOIN "role" r ON r."id" = ur."role_id"
                      WHERE ur."user_id" = u."id"
                        AND ur."active"
                        AND r."code" = 'ADMIN'
                   )
             ORDER BY u."id"
               FOR UPDATE OF u`;
          if (!otherActiveAdmins.some((row) => row.id !== id)) {
            throw conflictProblem(
              'You are the last active ADMIN — deactivating yourself or dropping your own ADMIN role would lock all administrative access out of the system (SYS-11). Create another active ADMIN first.',
            );
          }
        }

        const row = await tx.appUser.update({
          where: { id },
          data: {
            fullNameCt: fullNameEnc ? toBytes(fullNameEnc.ciphertext) : undefined,
            emailCt: emailEnc ? toBytes(emailEnc.ciphertext) : undefined,
            emailBidx: emailBidx ? toBytes(emailBidx) : undefined,
            employeeIdCt: employeeIdEnc ? toBytes(employeeIdEnc.ciphertext) : undefined,
            dekVersion: personalFieldsChanged ? this.fieldEncryption.currentDekVersion : undefined,
            status: activeChanged
              ? dto.active
                ? UserStatusT.active
                : UserStatusT.deactivated
              : undefined,
            deactivatedAt: activeChanged ? (dto.active ? null : new Date()) : undefined,
          },
        });

        if (desiredRoles) {
          const desiredRoleIds = new Set(desiredRoles.map((role) => role.id));
          for (const role of desiredRoles) {
            await tx.userRole.upsert({
              where: { userId_roleId: { userId: id, roleId: role.id } },
              create: { userId: id, roleId: role.id, grantedBy: actor.actorId },
              update: { active: true, grantedBy: actor.actorId, grantedAt: new Date() },
            });
          }
          const toRevoke = existing.userRoles.filter(
            (userRole) => userRole.active && !desiredRoleIds.has(userRole.roleId),
          );
          for (const userRole of toRevoke) {
            await tx.userRole.update({
              where: { userId_roleId: { userId: id, roleId: userRole.roleId } },
              data: { active: false },
            });
          }
        }

        const refreshed = await tx.appUser.findUniqueOrThrow({
          where: { id },
          include: USER_ROLES_INCLUDE,
        });
        const after = toUser(refreshed, this.fieldEncryption);

        if (personalFieldsChanged || activeChanged) {
          await this.audit.record(tx, {
            actorId: actor.actorId,
            action: AuditActionT.update,
            entityType: 'user',
            entityId: row.id,
            // CR-5/PR-SEC-02 — see `toUserAuditView`: ciphertext digests,
            // never decrypted personal fields, in the append-only audit
            // payload. A changed field is still evident (its digest differs
            // between `before` and `after`).
            before: toUserAuditView(existing),
            after: toUserAuditView(refreshed),
            sourceIp: actor.sourceIp,
            requestId: actor.requestId,
          });
        }
        if (rolesChanged) {
          await this.audit.record(tx, {
            actorId: actor.actorId,
            action: AuditActionT.permission_change,
            entityType: 'user',
            entityId: row.id,
            before: { roles: before.roles },
            after: { roles: after.roles },
            sourceIp: actor.sourceIp,
            requestId: actor.requestId,
          });
        }

        return after;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem('A user with this email already exists.');
      }
      throw error;
    }
  }

  /**
   * Slice 13-UI-B (SYS-10) — `PUT /users/{userId}/area-scopes`, the write
   * path that makes PR-API-10's read-side scoping reachable. REPLACES the
   * user's area-scope set wholesale (the `UserUpdate.roleCodes` convention):
   * every requested area is upserted `active: true`, every currently-active
   * scope NOT in the request is soft-removed (`active: false` — INV-16:
   * `bamform_app` has no DELETE grant, same convention as `user_role.active`).
   * `[]` clears every scope, returning the user to unrestricted.
   *
   * Audited `permission_change` in the SAME transaction (INV-09), only when
   * the effective set changed. The payload is `{ areaIds }` before/after —
   * area ids are non-personal, so CR-5/PR-SEC-02's ciphertext-digest rule for
   * person-fields is not triggered (and no decrypted person-field is ever
   * written here regardless).
   */
  async setAreaScopes(id: string, dto: UserAreaScopeSet, actor: ActorMeta): Promise<User> {
    const desiredAreaIds = [...new Set(dto.areaIds)];

    // Every read that informs the write happens INSIDE the transaction
    // (review B-5, the W-1 lesson): the audit event's `before` and the
    // changed-set decision are derived from rows read under the same
    // transaction that writes, so a concurrent PUT cannot make this event
    // record a `before` that was already stale when the write committed.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appUser.findUnique({
        where: { id },
        include: USER_ROLES_INCLUDE,
      });
      if (!existing) {
        throw notFoundProblem('User', id);
      }

      if (desiredAreaIds.length > 0) {
        const areas = await tx.area.findMany({ where: { id: { in: desiredAreaIds } } });
        if (areas.length !== desiredAreaIds.length) {
          throw validationFailedProblem('One or more areaIds do not match a known area.');
        }
        // Review B-4: an inactive area is retired — history keeps pointing
        // at it, but scoping someone INTO it is refused. (Deactivating an
        // area does not touch scopes already standing on it; those
        // semantics are an owner decision, tracked in the review's §Owner.)
        const inactive = areas.filter((area) => !area.active);
        if (inactive.length > 0) {
          throw validationFailedProblem(
            `One or more areaIds refer to a deactivated area (${inactive
              .map((area) => area.code)
              .join(', ')}). Reactivate the area first, or scope to an active one.`,
          );
        }
      }

      const beforeAreaIds = existing.userAreaScopes.map((scope) => scope.areaId);
      const changed =
        JSON.stringify([...beforeAreaIds].sort()) !== JSON.stringify([...desiredAreaIds].sort());

      if (changed) {
        const desired = new Set(desiredAreaIds);
        for (const areaId of desiredAreaIds) {
          await tx.userAreaScope.upsert({
            where: { userId_areaId: { userId: id, areaId } },
            create: { userId: id, areaId },
            update: { active: true },
          });
        }
        for (const scope of existing.userAreaScopes) {
          if (!desired.has(scope.areaId)) {
            await tx.userAreaScope.update({
              where: { userId_areaId: { userId: id, areaId: scope.areaId } },
              data: { active: false },
            });
          }
        }
      }

      const refreshed = await tx.appUser.findUniqueOrThrow({
        where: { id },
        include: USER_ROLES_INCLUDE,
      });
      const after = toUser(refreshed, this.fieldEncryption);

      if (changed) {
        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.permission_change,
          entityType: 'user',
          entityId: id,
          before: { areaIds: beforeAreaIds },
          after: { areaIds: after.areaIds },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });
      }

      return after;
    });
  }

  private async findOrThrow(id: string): Promise<AppUserWithRoles> {
    const row = await this.prisma.appUser.findUnique({
      where: { id },
      include: USER_ROLES_INCLUDE,
    });
    if (!row) {
      throw notFoundProblem('User', id);
    }
    return row;
  }

  private async rolesByCode(codes: readonly string[]) {
    const uniqueCodes = [...new Set(codes)];
    const roles = await this.prisma.role.findMany({ where: { code: { in: uniqueCodes } } });
    if (roles.length !== uniqueCodes.length) {
      throw validationFailedProblem('One or more roleCodes do not match a known role.');
    }
    return roles;
  }
}
