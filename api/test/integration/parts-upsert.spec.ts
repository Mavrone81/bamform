import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture } from './helpers/fixtures';

describe('part_used.active', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('defaults active=true on insert', async () => {
    const { jobId, authorId } = await createJobFixture('PM-PARTS-1', 'in_progress');
    const { rows } = await adminPool.query(
      `INSERT INTO "part_used" ("job_id","description","quantity","recorded_by")
       VALUES ($1,'Filter','1',$2) RETURNING "active"`,
      [jobId, authorId],
    );
    expect(rows[0].active).toBe(true);
  });
});
