import { Injectable } from '@nestjs/common';
import type { SyncBootstrapResponse } from '@bamform/shared';
import { AuthService } from '../auth/auth.service';
import { JobAccessService } from '../jobs/job-access';
import { JobsRepository } from '../jobs/jobs.repository';
import { toJob } from '../jobs/mappers';
import { encodeSyncToken, parseSince } from './sync-cursor';

/**
 * `GET /sync/bootstrap` (API_SPECIFICATION.md §11.1, PR-API-22/23, PR-059).
 * REUSE, not rebuild (slice-9-brief.md):
 *  - `JobAccessService#getAllowedAreaIds`/`hasBroadJobVisibility` — the SAME
 *    area+assignee scoping `JobsService#list` applies to `GET /jobs`
 *    (`jobs.service.ts`), so a device can never bootstrap jobs outside the
 *    caller's scope.
 *  - `JobsRepository#findManyFull` — batches slice 6's "one job with its
 *    frozen revision" assembly (`JOB_FULL_INCLUDE`) across every in-scope
 *    job in ONE query, rather than looping `findById` per job.
 *  - `mappers.ts#toJob` — the EXACT mapper `GET /jobs/{id}` uses; this is
 *    what actually embeds the complete frozen revision (active items/
 *    measurements/standing content) + current results, satisfying PR-API-22
 *    ("render the full form with no further network call").
 *  - `AuthService#me` (`current-user.builder.ts`) — builds the `user` field;
 *    see `auth.module.ts`'s export comment for why the FULL `CurrentUser`
 *    (not a hand-trimmed `{id,fullName,roles}`) is returned.
 *
 * `deletedJobIds` is always `[]` — see `jobs.repository.ts#findManyFull`'s
 * header for `since`'s scope, and slice-9-report.md's "concerns" section:
 * no mechanism in slices 1-8 ever moves a job OUT of a user's scope after
 * generation (no reassignment endpoint exists yet — PR-081/UR-029
 * reassignment is unbuilt), so there is nothing to compute today. The field
 * stays in the response shape (openapi: optional) so a later slice can
 * populate it without a breaking change.
 */
@Injectable()
export class SyncBootstrapService {
  constructor(
    private readonly repo: JobsRepository,
    private readonly access: JobAccessService,
    private readonly authService: AuthService,
  ) {}

  async bootstrap(
    userId: string,
    roles: string[],
    since: string | undefined,
  ): Promise<SyncBootstrapResponse> {
    const serverTime = new Date();
    const sinceDate = parseSince(since);

    const allowedAreaIds = await this.access.getAllowedAreaIds(userId);
    const restrictToAssignee = this.access.hasBroadJobVisibility(roles) ? null : userId;

    const [rows, user] = await Promise.all([
      this.repo.findManyFull(allowedAreaIds, restrictToAssignee, sinceDate),
      this.authService.me(userId),
    ]);

    return {
      serverTime: serverTime.toISOString(),
      user,
      jobs: rows.map((row) => toJob(row, serverTime)),
      deletedJobIds: [],
      syncToken: encodeSyncToken(serverTime),
    };
  }
}
