import { Inject, Injectable } from '@nestjs/common';
import { AuditActionT, Prisma, UserStatusT } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import type { User, UserCreate, UserUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { BLIND_INDEX_KEY } from '../auth/auth.tokens';
import { computeEmailBlindIndex, computeEmployeeIdBlindIndex } from '../auth/crypto/blind-index';
import { decodeIdentityField, encodeIdentityField } from '../auth/crypto/identity-codec';
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
import { toUser, type AppUserWithRoles } from './users.mapper';

export interface ListUsersParams {
  limit?: unknown;
  cursor?: string;
  roleCode?: string;
  active?: string;
}

const USER_ROLES_INCLUDE = {
  userRoles: { where: { active: true }, include: { role: true } },
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
   * Admin-created-user password mechanism (documented choice, see
   * slice-13a-report.md "concerns"): ADMIN-SET, not a generated
   * temp-password/invite-email flow — there is no SMTP wiring until slice
   * 11's credentials land and no forced "must change on next login" gate
   * exists in `/auth/login` yet. `dto.password` is required, hashed with the
   * same `PasswordService`/Argon2id as a normal login password, and NEVER
   * echoed back in the response (`User` — `shared/src/user.ts` — has no
   * password field at all).
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
        };
        const after = toUser(withRoles, this.fieldEncryption);

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'user',
          entityId: row.id,
          after,
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
            before,
            after,
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
