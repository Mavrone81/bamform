import type { Page, Route } from '@playwright/test';
import {
  generateRecoveryCodes,
  normaliseRecoveryCode,
  randomBase32Secret,
  verifyTotp,
} from './totp';

/**
 * A fake backend for the offline suite, installed via Playwright route
 * interception (`page.route`) rather than depending on the real api/
 * workspace. As of this branch `/sync/bootstrap`, `/sync/outbox` and
 * `/jobs/**` are not implemented server-side (slice 6/9/10 work — see
 * src/api/transport.ts's module doc), and the CI compose topology
 * (docker-compose.ci.yml) does not yet stitch bamform-web and bamform-api
 * onto one origin for a same-origin relative fetch to reach the api
 * container. Route interception sidesteps both gaps deterministically: it
 * intercepts every `/api/v1/**` request at the browser network boundary
 * before either question matters, so these tests exercise the REAL client
 * code (outbox.ts, sync-engine.ts, the screens) against a server that
 * behaves exactly as api/openapi.yaml contracts it to, with full control
 * over the fault injection the O-suite requires (dropped responses, 409s,
 * batch caps).
 *
 * This mirrors src/api/mock-transport.ts's semantics (same idempotency
 * store, same "commit before dropping the response" O-15 model) — that one
 * backs the Vitest unit suite; this one backs the browser-driven E2E suite.
 * Two independent tests of the same contract, at two different layers.
 */

export interface SeedJob {
  id: string;
  jobNumber: string;
  assetCode: string;
  frequency: 'M1' | 'M3' | 'M6' | 'Y';
  dueOn: string;
  overdue?: boolean;
  status?: string;
  draftVersion?: number;
  revisionId?: string;
  revisionCode?: string;
  items: Array<{ id: string; itemNo: number; instruction: string; mandatory?: boolean }>;
  /** Slice 11b additions — only meaningful once a job is (or becomes)
   * `SUBMITTED`; every field defaults to something sensible for jobs that
   * never touch the verifier queue. */
  submittedBy?: string;
  submittedAt?: string;
  currentStageOrdinal?: 1 | 2;
}

interface OutboxResultLike {
  id: string;
  status: number;
  applied: boolean;
  problem?: unknown;
}

/**
 * Slice 11b: a small fixed cast of users so the verifier-queue/delegation
 * journeys (E-02/03/04) can exercise multiple distinct actors — the
 * SUBMITTER, a TEAM_LEADER, an ENGINEER and a delegate — within one
 * FakeServer instance, each in their own BrowserContext (mirrors how
 * O-13/O-14 already use separate contexts sharing one server). Every
 * existing offline/a11y spec signs in as `tech@bevorasg.com` and is
 * completely unaffected: unknown emails fall back to the same
 * user-1/MAINTAINER identity they always got.
 */
export interface E2EUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

export const E2E_USERS: {
  technician: E2EUser;
  teamLeader: E2EUser;
  engineer: E2EUser;
  delegate: E2EUser;
  admin: E2EUser;
} = {
  technician: {
    id: 'user-1',
    email: 'tech@bevorasg.com',
    fullName: 'Test Technician',
    roles: ['MAINTAINER'],
  },
  teamLeader: {
    id: 'user-2',
    email: 'leader@bevorasg.com',
    fullName: 'Test Team Leader',
    roles: ['TEAM_LEADER'],
  },
  engineer: {
    id: 'user-3',
    email: 'engineer@bevorasg.com',
    fullName: 'Test Engineer',
    roles: ['ENGINEER'],
  },
  // Deliberately NOT a TEAM_LEADER/ENGINEER of their own — the only way
  // this user can appear in a stage's queue is via an active delegation
  // (E-04), so the journey genuinely proves the delegation path rather
  // than a role this user would have had access through anyway.
  delegate: {
    id: 'user-4',
    email: 'delegate@bevorasg.com',
    fullName: 'Test Delegate',
    roles: ['MAINTAINER'],
  },
  // Slice 13-UI-A. ADMIN is in the default MFA_REQUIRED_ROLES list, which is
  // exactly why the MFA journeys use it — and it is the role production's
  // only account holds, so these tests exercise the case that made the flags
  // unsafe to enable in the first place.
  admin: {
    id: 'user-5',
    email: 'admin@bevorasg.com',
    fullName: 'Test Administrator',
    roles: ['ADMIN'],
  },
};

/**
 * The password every canned user starts with. It IS checked, on `/auth/login`
 * (slice 13-UI-A: the password-change journey needs the old password to stop
 * working and the new one to start), on `/auth/step-up`, and on
 * `/auth/password` as the `currentPassword`. Comfortably over the 12-character
 * minimum `shared/src/mfa.ts` enforces.
 */
export const E2E_PASSWORD = 'correct-horse-battery-staple';

/** Default `MFA_REQUIRED_ROLES` (slice 13-MFA D-1). `MAINTAINER` is exempt —
 * SEC RS-3/SO-3 — which is why the technician journeys are untouched by MFA
 * even when it is switched on. */
export const MFA_REQUIRED_ROLES = ['ADMIN', 'TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'AUDITOR'];

/** Endpoints a `must_change_password` user may still reach (slice 13-MFA §7). */
const PASSWORD_CHANGE_ALLOWED_PATHS = ['/auth/me', '/auth/password', '/auth/logout'];

const CHALLENGE_TTL_MS = 5 * 60_000;

const USERS_BY_EMAIL = new Map<string, E2EUser>(Object.values(E2E_USERS).map((u) => [u.email, u]));
const USERS_BY_ID = new Map<string, E2EUser>(Object.values(E2E_USERS).map((u) => [u.id, u]));

export interface FakeDelegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  validFrom: string;
  validTo: string;
  reason: string | null;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

interface ApprovalStepLike {
  id: string;
  stageOrdinal: number;
  stageLabel: string;
  action: 'SUBMITTED' | 'VERIFIED' | 'RETURNED' | 'RECALLED' | 'VOIDED';
  actorId: string;
  actorName: string;
  actorRoleCode?: string;
  onBehalfOfName?: string | null;
  reason?: string | null;
  actedAt: string;
}

export class FakeServer {
  private jobs = new Map<string, SeedJob>();
  private deletedJobIds = new Set<string>();
  private idempotencyStore = new Map<string, OutboxResultLike>();
  appliedCount = new Map<string, number>();
  private conflictOnce = new Set<string>();
  private dropResponseOnce = new Set<string>();
  networkDown = false;
  serverTime = new Date().toISOString();
  outboxRequestCount = 0;
  submitCount = new Map<string, number>();
  private submitStore = new Map<string, unknown>();
  /** Every mutation batch ever received, in arrival order — lets a test
   * assert exactly what was sent without needing to peek into IndexedDB. */
  receivedBatches: Array<{ id: string; path: string }[]> = [];
  /** Real optimistic-concurrency tracking (mirrors the `draftVersion` /
   * `If-Match` contract, api/openapi.yaml `IfMatch` parameter): a mutation
   * whose `ifMatch` does not match the job's current version is rejected
   * 409, exactly as PR-064 describes — this is what makes O-13 (two
   * devices editing the same job) a genuine test of the mechanism rather
   * than a canned one-shot conflict. */
  private draftVersions = new Map<string, number>();

  /** Slice 11b: mutable per-job approval state. Kept SEPARATE from the
   * immutable `SeedJob` a test seeds with, defaulting to that job's own
   * `status`/`currentStageOrdinal` fields until `/submit`, `/verify` or
   * `/return` actually changes them — so every pre-existing offline/a11y
   * spec (none of which touch the verifier queue) is completely unaffected. */
  private jobStatus = new Map<string, string>();
  private jobStageOrdinal = new Map<string, 1 | 2>();
  private jobSubmittedBy = new Map<string, string>();
  private jobSubmittedAt = new Map<string, string>();
  private approvalSteps = new Map<string, ApprovalStepLike[]>();
  private approvalStepSeq = 0;
  private delegations = new Map<string, FakeDelegation>();
  private delegationSeq = 0;
  /** Users who have completed `/auth/step-up` and not yet had it consumed
   * by a `/verify` call — real re-authentication IS required per user, per
   * signing action (there is no "logging in satisfies it" shortcut here),
   * which is what makes the pad's step-up-retry path a genuine test rather
   * than one that trivially never fires. */
  private stepUpValidUserIds = new Set<string>();

  // ---- Slice 13-UI-A: MFA + password self-service state ----
  //
  // `mfaEnabled` defaults to FALSE, deliberately mirroring the api's
  // `MFA_ENABLED` default and production's current setting. Every pre-slice-13
  // spec therefore sees the one-step login it always saw; the MFA journeys opt
  // in explicitly with `enableMfa()`.
  private mfaEnabled = false;
  private passwords = new Map<string, string>();
  private mustChangePassword = new Set<string>();
  private enrolledUserIds = new Set<string>();
  private confirmedSecrets = new Map<string, string>();
  private pendingSecrets = new Map<string, string>();
  private lastUsedStep = new Map<string, number>();
  /** userId -> normalised code -> used. Codes are marked used, never removed
   * (INV-07), so a reuse is genuinely detected rather than silently missed. */
  private recoveryCodes = new Map<string, Map<string, boolean>>();
  private challenges = new Map<string, { userId: string; expiresAt: number }>();
  private consumedChallenges = new Set<string>();
  private challengeSeq = 0;
  /** Every TOTP code the fake ever rejected, so a spec can assert the
   * rejection really happened at the server rather than in the UI. */
  rejectedTotpCodes: string[] = [];

  /** Turns on enforcement, as flipping `MFA_ENABLED=true` would. */
  enableMfa(): void {
    this.mfaEnabled = true;
  }

  /** Pre-enrols a user with a known secret, so a spec can act as their phone.
   * Returns the base32 secret. */
  seedMfaEnrolment(userId: string, secret: string = randomBase32Secret()): string {
    this.enrolledUserIds.add(userId);
    this.confirmedSecrets.set(userId, secret);
    return secret;
  }

  /** Issues recovery codes to an already-enrolled user (the enrolment journey
   * gets its codes from `/auth/mfa/enrol/confirm` like a real user does). */
  seedRecoveryCodes(userId: string, count = 10): string[] {
    const codes = generateRecoveryCodes(count);
    this.recoveryCodes.set(userId, new Map(codes.map((c) => [normaliseRecoveryCode(c), false])));
    return codes;
  }

  /** Marks a user as admin-created, i.e. `must_change_password = true`. */
  seedMustChangePassword(userId: string): void {
    this.mustChangePassword.add(userId);
  }

  isEnrolled(userId: string): boolean {
    return this.enrolledUserIds.has(userId);
  }

  passwordOf(userId: string): string {
    return this.passwords.get(userId) ?? E2E_PASSWORD;
  }

  seedJob(job: SeedJob): void {
    this.jobs.set(job.id, job);
    this.draftVersions.set(job.id, job.draftVersion ?? 1);
    this.jobStatus.set(job.id, job.status ?? 'IN_PROGRESS');
    this.jobStageOrdinal.set(job.id, job.currentStageOrdinal ?? 1);
    if (job.submittedBy) this.jobSubmittedBy.set(job.id, job.submittedBy);
    if (job.submittedAt) this.jobSubmittedAt.set(job.id, job.submittedAt);
    if (!this.approvalSteps.has(job.id)) this.approvalSteps.set(job.id, []);
  }

  /** Grants a delegation directly (bypassing `POST /delegations`) so a test
   * can set up E-04's starting condition without needing UI interaction
   * first. `createDelegation` (via the real endpoint) is exercised
   * separately by whichever journey actually creates one through the UI. */
  seedDelegation(input: {
    delegatorId: string;
    delegateId: string;
    validFrom: string;
    validTo: string;
    reason?: string | null;
  }): FakeDelegation {
    const id = `deleg-${++this.delegationSeq}`;
    const delegation: FakeDelegation = {
      id,
      delegatorId: input.delegatorId,
      delegateId: input.delegateId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason: input.reason ?? null,
      createdBy: input.delegatorId,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.delegations.set(id, delegation);
    return delegation;
  }

  removeJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.deletedJobIds.add(jobId);
  }

  draftVersionOf(jobId: string): number {
    return this.draftVersions.get(jobId) ?? 1;
  }

  forceConflictOnce(mutationId: string): void {
    this.conflictOnce.add(mutationId);
  }

  /** Coarser sibling of `forceConflictOnce`, for the same reason
   * `dropNextOutboxResponseOnce` exists: a client-generated UUIDv7 can't be
   * known ahead of the tap that creates it. Conflicts every mutation in the
   * very next `/sync/outbox` batch, regardless of id. */
  private forceNextConflict = false;
  forceNextConflictOnce(): void {
    this.forceNextConflict = true;
  }

  dropResponseOnceFor(mutationId: string): void {
    this.dropResponseOnce.add(mutationId);
  }

  /** Coarser than `dropResponseOnceFor`: drops the response for the very
   * next `/sync/outbox` request regardless of which mutation ids it
   * carries, after committing them normally — used where a test cannot
   * predict a client-generated UUIDv7 ahead of time (which is always, since
   * it is generated in the browser at the moment of the tap). This models
   * O-02/O-15 precisely: the server applied the batch, the client never saw
   * the response. */
  private dropNextResponse = false;
  dropNextOutboxResponseOnce(): void {
    this.dropNextResponse = true;
  }

  private jobIdFromPath(path: string): string | null {
    const match = path.match(/\/jobs\/([^/]+)\//);
    return match ? match[1] : null;
  }

  private toApiJob(job: SeedJob) {
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      assetId: job.id,
      assetCode: job.assetCode,
      documentNumber: 'CE 95 020 00 01',
      revisionCode: job.revisionCode ?? 'A',
      frequency: job.frequency,
      frequencyScope: [job.frequency],
      dueOn: job.dueOn,
      overdue: job.overdue ?? false,
      status: this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS',
      assignedTo: 'user-1',
      assignedToName: 'Test Technician',
      draftVersion: this.draftVersionOf(job.id),
      templateRevision: {
        id: job.revisionId ?? `rev-${job.id}`,
        formTemplateId: 'tpl-1',
        documentNumber: 'CE 95 020 00 01',
        revisionCode: job.revisionCode ?? 'A',
        sequenceOrdinal: 1,
        status: 'CURRENT',
        items: job.items.map((i, idx) => ({
          id: i.id,
          itemNo: i.itemNo,
          frequency: job.frequency,
          instruction: i.instruction,
          mandatory: i.mandatory ?? true,
          stableKey: `item-${idx}`,
          displayOrder: idx,
        })),
        measurements: [],
      },
      itemResults: [],
      measurementResults: [],
      partsUsed: [],
      attachments: [],
      approvalSteps: this.approvalSteps.get(job.id) ?? [],
    };
  }

  private currentStageRole(ordinal: number): 'TEAM_LEADER' | 'ENGINEER' {
    return ordinal >= 2 ? 'ENGINEER' : 'TEAM_LEADER';
  }

  private async currentUser(route: Route): Promise<E2EUser> {
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const userId = match?.[1];
    return (userId && USERS_BY_ID.get(userId)) || E2E_USERS.technician;
  }

  private problem(status: number, title: string, type = 'about:blank') {
    return { type, title, status };
  }

  /** Real login is required before refresh will succeed for THAT SAME
   * browser context — modelled with an actual `Set-Cookie` on login and a
   * `Cookie` check on refresh, exactly like the real HttpOnly refresh
   * cookie, rather than a single shared boolean. A single global flag was
   * tried first and broke as soon as a second "device" (BrowserContext)
   * appeared in the same test (O-13): logging in on device A made device
   * B's fresh page silently auto-authenticate via refresh too, since
   * cookies are NOT actually shared between real browser contexts — the
   * flag was pretending they were. Without this fix, every fresh page load
   * for a context that never logged in would ALSO be redirected straight
   * past the sign-in screen. */
  private authResultBody(user: E2EUser) {
    return {
      accessToken: `e2e-token-${user.id}`,
      expiresIn: 900,
      user: { id: user.id, fullName: user.fullName, roles: user.roles },
    };
  }

  /** The one place a session is issued, so `/auth/login`, `/auth/mfa/verify`,
   * `/auth/mfa/recovery` and the enrol-completes-login path cannot drift —
   * mirroring the api's own `SessionIssuerService`. */
  private async fulfillAuthenticated(route: Route, user: E2EUser) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Set-Cookie': `bf_refresh=e2e-refresh-${user.id}; Path=/; HttpOnly` },
      body: JSON.stringify(this.authResultBody(user)),
    });
  }

  /** Deliberately opaque, exactly as `invalidCredentialsProblem()` is: the
   * caller is never told whether the code, the challenge token or the account
   * was the problem. */
  private async fulfillInvalidCredentials(route: Route) {
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify(this.problem(401, 'Invalid credentials', '/errors/invalid-credentials')),
    });
  }

  private async handleLogin(route: Route) {
    const body = route.request().postDataJSON() as { email?: string; password?: string };
    const user = (body.email && USERS_BY_EMAIL.get(body.email)) || E2E_USERS.technician;

    if (body.password !== this.passwordOf(user.id)) {
      await this.fulfillInvalidCredentials(route);
      return;
    }

    // Slice 13-MFA §4: with the flag on, a user holding any MFA_REQUIRED_ROLE
    // gets NO access token and NO refresh cookie — only a challenge.
    // MAINTAINER is exempt, so the technician's flow is unchanged.
    const mfaRequired =
      this.mfaEnabled && user.roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
    if (!mfaRequired) {
      await this.fulfillAuthenticated(route, user);
      return;
    }

    const challengeToken = `mfa-challenge-${user.id}-${++this.challengeSeq}`;
    this.challenges.set(challengeToken, {
      userId: user.id,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // No Set-Cookie: the login is not finished.
      body: JSON.stringify({
        mfaRequired: true,
        mfaEnrolled: this.enrolledUserIds.has(user.id),
        challengeToken,
        expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000),
      }),
    });
  }

  // ---- Slice 13-UI-A: /auth/mfa/*, /auth/password, /users/{id}/mfa-reset ----

  /** Resolves a challenge token to its user, enforcing expiry and single use.
   * Returns null for anything it will not honour. */
  private challengeSubject(challengeToken: string | undefined): E2EUser | null {
    if (!challengeToken) return null;
    if (this.consumedChallenges.has(challengeToken)) return null;
    const challenge = this.challenges.get(challengeToken);
    if (!challenge || Date.now() > challenge.expiresAt) return null;
    return USERS_BY_ID.get(challenge.userId) ?? null;
  }

  /** Burns a challenge token. The FIRST redemption wins; every later one —
   * including a replay of the exact same request — gets 401. */
  private consumeChallenge(challengeToken: string): void {
    this.consumedChallenges.add(challengeToken);
  }

  /** Either credential the enrol endpoints accept (openapi: `bearerAuth` OR
   * the body `challengeToken`). Never anonymous. */
  private async enrolSubject(
    route: Route,
    body: { challengeToken?: string },
  ): Promise<{ user: E2EUser; challengeToken?: string } | null> {
    if (body.challengeToken) {
      const user = this.challengeSubject(body.challengeToken);
      return user ? { user, challengeToken: body.challengeToken } : null;
    }
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const user = match ? USERS_BY_ID.get(match[1]) : undefined;
    return user ? { user } : null;
  }

  private async handleMfaVerify(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      totpCode?: string;
    };
    const user = this.challengeSubject(body.challengeToken);
    const secret = user ? this.confirmedSecrets.get(user.id) : undefined;
    if (!user || !secret || !this.enrolledUserIds.has(user.id)) {
      await this.fulfillInvalidCredentials(route);
      return;
    }

    const verification = verifyTotp(secret, body.totpCode ?? '', this.lastUsedStep.get(user.id));
    if (!verification.valid) {
      // A wrong code does NOT burn the challenge — the api only claims it on
      // a successful redemption — so the user gets to retype.
      this.rejectedTotpCodes.push(body.totpCode ?? '');
      await this.fulfillInvalidCredentials(route);
      return;
    }

    this.lastUsedStep.set(user.id, verification.step!);
    this.consumeChallenge(body.challengeToken!);
    await this.fulfillAuthenticated(route, user);
  }

  private async handleMfaRecovery(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      recoveryCode?: string;
    };
    const user = this.challengeSubject(body.challengeToken);
    const codes = user ? this.recoveryCodes.get(user.id) : undefined;
    const normalised = normaliseRecoveryCode(body.recoveryCode ?? '');
    // Must exist, belong to this user, and be UNUSED. Marked used, never
    // deleted (INV-07), which is what makes a second attempt genuinely fail.
    if (!user || !codes || codes.get(normalised) !== false) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    codes.set(normalised, true);
    this.consumeChallenge(body.challengeToken!);
    await this.fulfillAuthenticated(route, user);
  }

  private async handleMfaEnrol(route: Route) {
    const body = route.request().postDataJSON() as { challengeToken?: string };
    const subject = await this.enrolSubject(route, body);
    if (!subject) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    if (this.enrolledUserIds.has(subject.user.id)) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Multi-factor authentication is already set up for this account',
            '/errors/conflict',
          ),
        ),
      });
      return;
    }
    // Re-calling before confirmation REPLACES the pending secret.
    const secret = randomBase32Secret();
    this.pendingSecrets.set(subject.user.id, secret);
    const label = encodeURIComponent(`BamForm:${subject.user.email}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=BamForm&algorithm=SHA1&digits=6&period=30`,
      }),
    });
  }

  private async handleMfaEnrolConfirm(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      totpCode?: string;
    };
    const subject = await this.enrolSubject(route, body);
    const pending = subject ? this.pendingSecrets.get(subject.user.id) : undefined;
    if (!subject || !pending) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    const verification = verifyTotp(
      pending,
      body.totpCode ?? '',
      this.lastUsedStep.get(subject.user.id),
    );
    if (!verification.valid) {
      this.rejectedTotpCodes.push(body.totpCode ?? '');
      await this.fulfillInvalidCredentials(route);
      return;
    }

    this.pendingSecrets.delete(subject.user.id);
    this.confirmedSecrets.set(subject.user.id, pending);
    this.enrolledUserIds.add(subject.user.id);
    this.lastUsedStep.set(subject.user.id, verification.step!);
    const codes = generateRecoveryCodes();
    this.recoveryCodes.set(
      subject.user.id,
      new Map(codes.map((c) => [normaliseRecoveryCode(c), false])),
    );

    // Confirming on a challenge token also COMPLETES the login (§4.4);
    // a voluntary enrolment returns `auth: null` and keeps its session.
    if (subject.challengeToken) {
      this.consumeChallenge(subject.challengeToken);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Set-Cookie': `bf_refresh=e2e-refresh-${subject.user.id}; Path=/; HttpOnly`,
        },
        body: JSON.stringify({
          recoveryCodes: codes,
          auth: this.authResultBody(subject.user),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recoveryCodes: codes, auth: null }),
    });
  }

  private async handlePasswordChange(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (body.currentPassword !== this.passwordOf(requester.id)) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    if ((body.newPassword ?? '').length < 12) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(422, 'Password must be at least 12 characters', '/errors/validation-failed'),
        ),
      });
      return;
    }
    this.passwords.set(requester.id, body.newPassword!);
    this.mustChangePassword.delete(requester.id);
    await route.fulfill({ status: 204, body: '' });
  }

  private async handleMfaReset(route: Route, userId: string) {
    const requester = await this.currentUser(route);
    if (!requester.roles.includes('ADMIN')) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'Forbidden', '/errors/forbidden')),
      });
      return;
    }
    if (!USERS_BY_ID.has(userId)) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Not found', '/errors/not-found')),
      });
      return;
    }
    this.enrolledUserIds.delete(userId);
    this.confirmedSecrets.delete(userId);
    this.pendingSecrets.delete(userId);
    this.lastUsedStep.delete(userId);
    const codes = this.recoveryCodes.get(userId);
    if (codes) for (const code of codes.keys()) codes.set(code, true);
    await route.fulfill({ status: 204, body: '' });
  }

  /**
   * The global, deny-by-default forced-password-change guard (slice 13-MFA
   * §7). Wrapped around every NON-auth route in `install()` so a route added
   * later inherits it, exactly as the server's `APP_GUARD` does — rather than
   * being remembered per handler.
   */
  private guarded(handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
    return async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (!PASSWORD_CHANGE_ALLOWED_PATHS.some((allowed) => path.endsWith(allowed))) {
        const requester = await this.currentUser(route);
        if (this.mustChangePassword.has(requester.id)) {
          await route.fulfill({
            status: 403,
            contentType: 'application/problem+json',
            body: JSON.stringify(
              this.problem(403, 'Password change required', '/errors/password-change-required'),
            ),
          });
          return;
        }
      }
      await handler(route);
    };
  }

  private async handleRefresh(route: Route) {
    const cookieHeader = (await route.request().headerValue('cookie')) ?? '';
    const match = cookieHeader.match(/bf_refresh=e2e-refresh-(user-\d+)/);
    if (!match) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'no session', status: 401 }),
      });
      return;
    }
    const user = USERS_BY_ID.get(match[1]) ?? E2E_USERS.technician;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: `e2e-token-${user.id}-refreshed`,
        expiresIn: 900,
        user: { id: user.id, fullName: user.fullName, roles: user.roles },
      }),
    });
  }

  private async handleBootstrap(route: Route) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        serverTime: this.serverTime,
        user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
        jobs: Array.from(this.jobs.values()).map((j) => this.toApiJob(j)),
        deletedJobIds: Array.from(this.deletedJobIds),
        syncToken: `tok-${this.jobs.size}`,
      }),
    });
  }

  private async handleOutbox(route: Route) {
    this.outboxRequestCount++;
    const body = route.request().postDataJSON() as {
      mutations: Array<{ id: string; path: string; ifMatch?: number | null }>;
    };
    this.receivedBatches.push(body.mutations.map((m) => ({ id: m.id, path: m.path })));

    if (this.networkDown) {
      await route.abort('internetdisconnected');
      return;
    }

    if (body.mutations.length > 200) {
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'batch too large',
          status: 400,
        }),
      });
      return;
    }

    const results: OutboxResultLike[] = [];
    let mustDrop = false;

    for (const m of body.mutations) {
      const existing = this.idempotencyStore.get(m.id);
      if (existing) {
        results.push(existing);
        continue;
      }
      const jobId = this.jobIdFromPath(m.path);
      const currentVersion = jobId ? this.draftVersionOf(jobId) : 1;
      const isStale = m.ifMatch != null && m.ifMatch !== currentVersion;
      const forcedConflict = this.conflictOnce.has(m.id) || this.forceNextConflict;
      const jobWasRemoved = jobId != null && this.deletedJobIds.has(jobId);

      let result: OutboxResultLike;
      if (jobWasRemoved) {
        // O-14: a mutation against a job that no longer exists/was
        // reassigned server-side is rejected, not silently applied — if it
        // were silently applied, the device's `hasPendingOutbox` flag would
        // clear on its own and the NEXT bootstrap would have nothing left
        // to protect, defeating the "device is informed, cannot submit"
        // guarantee this scenario is specifically about.
        result = {
          id: m.id,
          status: 404,
          applied: false,
          problem: { type: 'about:blank', title: 'job not found (reassigned)', status: 404 },
        };
      } else if (forcedConflict || isStale) {
        this.conflictOnce.delete(m.id);
        result = {
          id: m.id,
          status: 409,
          applied: false,
          problem: {
            type: 'https://form.bevorasg.com/errors/draft-conflict',
            title: 'Draft version conflict',
            status: 409,
            detail: isStale
              ? `Job is at draftVersion ${currentVersion}, mutation based on ${m.ifMatch}`
              : undefined,
          },
        };
      } else {
        this.appliedCount.set(m.id, (this.appliedCount.get(m.id) ?? 0) + 1);
        if (jobId) this.draftVersions.set(jobId, currentVersion + 1);
        result = { id: m.id, status: 200, applied: true };
      }
      this.idempotencyStore.set(m.id, result);
      results.push(result);
      if (this.dropResponseOnce.has(m.id)) {
        this.dropResponseOnce.delete(m.id);
        mustDrop = true;
      }
    }
    this.forceNextConflict = false;

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      mustDrop = true;
    }

    if (mustDrop) {
      await route.abort('internetdisconnected'); // commit already happened above — O-15 fault
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, syncToken: `tok-${this.idempotencyStore.size}` }),
    });
  }

  private async handleSubmit(route: Route, jobId: string) {
    const key = await route.request().headerValue('idempotency-key');
    const dedupeKey = key ?? jobId;
    if (this.submitStore.has(dedupeKey)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.submitStore.get(dedupeKey)),
      });
      return;
    }
    this.submitCount.set(jobId, (this.submitCount.get(jobId) ?? 0) + 1);
    const job = this.jobs.get(jobId);
    if (job) {
      const requester = await this.currentUser(route);
      this.jobStatus.set(jobId, 'SUBMITTED');
      this.jobStageOrdinal.set(jobId, 1);
      this.jobSubmittedBy.set(jobId, requester.id);
      this.jobSubmittedAt.set(jobId, new Date().toISOString());
      const steps = this.approvalSteps.get(jobId) ?? [];
      steps.push({
        id: `step-${++this.approvalStepSeq}`,
        stageOrdinal: 0,
        stageLabel: 'Submitted',
        action: 'SUBMITTED',
        actorId: requester.id,
        actorName: requester.fullName,
        actedAt: this.jobSubmittedAt.get(jobId)!,
      });
      this.approvalSteps.set(jobId, steps);
    }
    const body = job ? this.toApiJob(job) : { id: jobId, status: 'SUBMITTED' };
    this.submitStore.set(dedupeKey, body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }

  // ---- Slice 11a/11b: verifier queue / record review / delegations ----

  private async handleGetJob(route: Route, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Job not found')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleQueue(route: Route) {
    const requester = await this.currentUser(route);
    const now = Date.now();
    const activeDelegationsToMe = Array.from(this.delegations.values()).filter(
      (d) =>
        d.delegateId === requester.id &&
        !d.revokedAt &&
        Date.parse(d.validFrom) <= now &&
        now <= Date.parse(d.validTo),
    );

    const data: unknown[] = [];
    for (const job of this.jobs.values()) {
      if ((this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') continue;
      const submitter = this.jobSubmittedBy.get(job.id);
      if (submitter === requester.id) continue; // INV-05: never your own submission
      const stage = this.jobStageOrdinal.get(job.id) ?? 1;
      const stageRole = this.currentStageRole(stage);

      let onBehalfOf: string | null = null;
      const eligible = requester.roles.includes(stageRole);
      if (!eligible) {
        const viaDelegation = activeDelegationsToMe.find((d) => {
          const delegator = USERS_BY_ID.get(d.delegatorId);
          return delegator?.roles.includes(stageRole);
        });
        if (!viaDelegation) continue;
        onBehalfOf = viaDelegation.delegatorId;
      }

      const submittedAt = this.jobSubmittedAt.get(job.id) ?? new Date().toISOString();
      data.push({
        ...this.toApiJob(job),
        submittedAt,
        submittedByName: submitter
          ? (USERS_BY_ID.get(submitter)?.fullName ?? submitter)
          : undefined,
        ageHours: (now - Date.parse(submittedAt)) / 3_600_000,
        escalated: false,
        onBehalfOf,
      });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private async handleVerify(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      drawnSignature?: string;
      onBehalfOf?: string | null;
      comment?: string | null;
    };

    if (!body.drawnSignature) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            422,
            'drawnSignature is required (base64 PNG data-URL).',
            'https://form.bevorasg.com/errors/attachment-rejected',
          ),
        ),
      });
      return;
    }

    // PR-API-07: step-up is required per signing action, per user — a
    // fresh login does NOT itself satisfy it in this fake (see the
    // `stepUpValidUserIds` field doc).
    if (!this.stepUpValidUserIds.has(requester.id)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            403,
            'Re-authentication required before signing',
            'https://form.bevorasg.com/errors/step-up-required',
          ),
        ),
      });
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Job is not SUBMITTED',
            'https://form.bevorasg.com/errors/invalid-transition',
          ),
        ),
      });
      return;
    }

    const submitter = this.jobSubmittedBy.get(jobId);
    if (!body.onBehalfOf && submitter === requester.id) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Self-approval is not permitted',
            'https://form.bevorasg.com/errors/self-approval',
          ),
        ),
      });
      return;
    }

    const stage = this.jobStageOrdinal.get(jobId) ?? 1;
    const stageRole = this.currentStageRole(stage);
    let actingRoles = requester.roles as readonly string[];
    let onBehalfOfName: string | null = null;
    if (body.onBehalfOf) {
      const now = Date.now();
      const delegation = Array.from(this.delegations.values()).find(
        (d) =>
          d.delegatorId === body.onBehalfOf &&
          d.delegateId === requester.id &&
          !d.revokedAt &&
          Date.parse(d.validFrom) <= now &&
          now <= Date.parse(d.validTo),
      );
      if (!delegation) {
        await route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          body: JSON.stringify(
            this.problem(403, 'No active delegation permits acting on behalf of that user'),
          ),
        });
        return;
      }
      const delegator = USERS_BY_ID.get(body.onBehalfOf);
      actingRoles = delegator?.roles ?? [];
      onBehalfOfName = delegator?.fullName ?? body.onBehalfOf;
    }

    if (!actingRoles.includes(stageRole)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    // Consumed by this signing action — the NEXT verify by this same user
    // (e.g. stage 2, or a different job) requires stepping up again.
    this.stepUpValidUserIds.delete(requester.id);

    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: stage,
      stageLabel: stage >= 2 ? 'Verified By (Engineer)' : 'Verified By (Workshop Team Leader)',
      action: 'VERIFIED',
      actorId: requester.id,
      actorName: requester.fullName,
      actorRoleCode: stageRole,
      onBehalfOfName,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    if (stage >= 2) {
      this.jobStatus.set(jobId, 'ARCHIVED');
    } else {
      this.jobStageOrdinal.set(jobId, 2);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleReturn(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { reason?: string };
    if (!body.reason || body.reason.trim().length < 10) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(422, 'reason must be at least 10 characters (INV-13, PR-074).'),
        ),
      });
      return;
    }
    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(409, 'Job is not SUBMITTED')),
      });
      return;
    }

    this.jobStatus.set(jobId, 'IN_PROGRESS');
    this.jobStageOrdinal.set(jobId, 1);
    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: this.jobStageOrdinal.get(jobId) ?? 1,
      stageLabel: 'Returned',
      action: 'RETURNED',
      actorId: requester.id,
      actorName: requester.fullName,
      reason: body.reason,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleStepUp(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password !== E2E_PASSWORD) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(401, 'Incorrect password')),
      });
      return;
    }
    this.stepUpValidUserIds.add(requester.id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stepUpValidUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  }

  private async handleListDelegations(route: Route) {
    const requester = await this.currentUser(route);
    const data = Array.from(this.delegations.values())
      .filter((d) => d.delegatorId === requester.id || d.delegateId === requester.id)
      .map((d) => this.toApiDelegation(d));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private toApiDelegation(d: FakeDelegation) {
    return {
      ...d,
      delegatorName: USERS_BY_ID.get(d.delegatorId)?.fullName,
      delegateName: USERS_BY_ID.get(d.delegateId)?.fullName,
    };
  }

  private async handleCreateDelegation(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      delegatorId: string;
      delegateId: string;
      validFrom: string;
      validTo: string;
      reason?: string | null;
    };

    // Mirrors the real permission matrix (§4.1): a TEAM_LEADER/ENGINEER may
    // only delegate their OWN authority away; only ADMIN may set up a
    // delegation between two other users (no ADMIN exists among the canned
    // E2E_USERS, so that branch never applies here).
    const canDelegate = requester.roles.some((r) => r === 'TEAM_LEADER' || r === 'ENGINEER');
    if (!canDelegate || body.delegatorId !== requester.id) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    const delegation = this.seedDelegation(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  private async handleRevokeDelegation(route: Route, delegationId: string) {
    const requester = await this.currentUser(route);
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Delegation not found')),
      });
      return;
    }
    const canRevoke =
      delegation.delegatorId === requester.id || delegation.createdBy === requester.id;
    if (!canRevoke) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }
    if (!delegation.revokedAt) {
      delegation.revokedAt = new Date().toISOString();
      this.delegations.set(delegationId, delegation);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  async install(page: Page): Promise<void> {
    // ---- Auth: exempt from the forced-password-change guard by design.
    await page.route('**/api/v1/auth/login', (route) => this.handleLogin(route));
    await page.route('**/api/v1/auth/refresh', (route) => this.handleRefresh(route));
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/api/v1/auth/password', (route) => this.handlePasswordChange(route));
    await page.route('**/api/v1/auth/mfa/verify', (route) => this.handleMfaVerify(route));
    await page.route('**/api/v1/auth/mfa/recovery', (route) => this.handleMfaRecovery(route));
    await page.route('**/api/v1/auth/mfa/enrol/confirm', (route) =>
      this.handleMfaEnrolConfirm(route),
    );
    await page.route('**/api/v1/auth/mfa/enrol', (route) => this.handleMfaEnrol(route));

    // ---- Everything else runs behind the global forced-change guard.
    await page.route(
      '**/api/v1/auth/step-up',
      this.guarded((route) => this.handleStepUp(route)),
    );
    await page.route(
      /\/api\/v1\/users\/([^/]+)\/mfa-reset/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/users\/([^/]+)\/mfa-reset/);
        return this.handleMfaReset(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    await page.route(
      '**/api/v1/sync/bootstrap*',
      this.guarded((route) => this.handleBootstrap(route)),
    );
    await page.route(
      '**/api/v1/sync/outbox',
      this.guarded((route) => this.handleOutbox(route)),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/submit/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/submit/);
        return this.handleSubmit(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      '**/api/v1/queue*',
      this.guarded((route) => this.handleQueue(route)),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/verify/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/verify/);
        return this.handleVerify(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/return/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/return/);
        return this.handleReturn(route, match ? match[1] : 'unknown');
      }),
    );
    // Anchored (no trailing segment) so it never intercepts /submit,
    // /verify, /return, /items/*, /measurements/*, /parts, /attachments —
    // all of which are registered as their own, more specific routes above
    // and below. Playwright resolves overlapping routes last-registered-
    // first, but this still keeps each handler's own responsibility
    // unambiguous to read.
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)$/);
        return this.handleGetJob(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      '**/api/v1/delegations',
      this.guarded((route) => {
        if (route.request().method() === 'POST') return this.handleCreateDelegation(route);
        return this.handleListDelegations(route);
      }),
    );
    await page.route(
      /\/api\/v1\/delegations\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/delegations\/([^/]+)$/);
        return this.handleRevokeDelegation(route, match ? match[1] : 'unknown');
      }),
    );
  }
}
