import { test, expect } from '../support/fixtures';
import { signInAs } from '../support/fixtures';
import { E2E_USERS, E2E_PASSWORD } from '../support/fake-server';

/**
 * Slice 13-UI-B — the admin journey (TEST_PLAN E-06 / brief §4): an ADMIN
 * creates a user, assigns a role and an AREA SCOPE entirely through the UI,
 * and the new user then signs in and sees ONLY their area's queue. The fake
 * server enforces what the real api enforces (C-1 postmortem): ADMIN-only
 * routes 403 non-admins, the queue and bootstrap are genuinely area-scoped,
 * and the last-admin self-lockout 409s with the server's own sentence.
 */

const NEW_USER_EMAIL = 'scoped.leader@bevorasg.com';
const NEW_USER_PASSWORD = 'Leader-Passw0rd!';

test('E-06: create user → role → area scope → the user sees only their area', async ({
  page,
  server,
  browser,
}) => {
  // Two areas, one SUBMITTED job in each — the visibility split under test.
  const bondLine = server.seedArea({ code: 'BL', name: 'Bond Line' });
  const testBay = server.seedArea({ code: 'TB', name: 'Test Bay' });
  server.seedJob({
    id: 'job-area-a',
    jobNumber: 'PM-2026-000600',
    assetCode: 'WB01',
    areaId: bondLine.id,
    frequency: 'M1',
    dueOn: '2026-08-01',
    status: 'SUBMITTED',
    submittedBy: E2E_USERS.technician.id,
    submittedAt: new Date().toISOString(),
    currentStageOrdinal: 1,
    items: [{ id: 'item-a1', itemNo: 1, instruction: 'Check bond head' }],
    itemResults: [{ templateItemId: 'item-a1', status: 'DONE' }],
  });
  server.seedJob({
    id: 'job-area-b',
    jobNumber: 'PM-2026-000601',
    assetCode: 'AO01',
    areaId: testBay.id,
    frequency: 'M1',
    dueOn: '2026-08-01',
    status: 'SUBMITTED',
    submittedBy: E2E_USERS.technician.id,
    submittedAt: new Date().toISOString(),
    currentStageOrdinal: 1,
    items: [{ id: 'item-b1', itemNo: 1, instruction: 'Check oven door seal' }],
    itemResults: [{ templateItemId: 'item-b1', status: 'DONE' }],
  });

  // ---- The ADMIN creates and scopes the user, all through the UI ----
  await signInAs(page, E2E_USERS.admin.email);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Administration' }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

  await page.getByRole('button', { name: /^Users/ }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  // The canned cast is listed — decrypted names come from the API by design.
  await expect(page.getByRole('button', { name: /Test Administrator/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('heading', { name: 'Add a user' })).toBeVisible();
  await page.getByLabel('Full name').fill('Scoped Leader');
  await page.getByLabel('Email').fill(NEW_USER_EMAIL);
  await page.getByLabel('Initial password').fill(NEW_USER_PASSWORD);
  await page.getByLabel(/Team Leader/).check();
  await page.getByRole('button', { name: 'Create user' }).click();

  // Lands on the new user's detail page.
  await expect(page.getByRole('heading', { name: 'Scoped Leader' })).toBeVisible();
  await expect(page.getByLabel(/Team Leader/)).toBeChecked();

  // Assign the area scope: Bond Line only.
  await page.getByLabel(/Bond Line/).check();
  await page.getByRole('button', { name: 'Save area access' }).click();
  await expect(page.getByText('Area access saved.')).toBeVisible();

  // ---- The new user signs in on their own "device" ----
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await server.install(page2);
  await signInAs(page2, NEW_USER_EMAIL, NEW_USER_PASSWORD);

  await page2.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(page2.getByRole('heading', { name: 'Verifier queue' })).toBeVisible();

  // Sees the Bond Line job — and ONLY that one. The Test Bay job exists,
  // is SUBMITTED, and would be visible to an unscoped TEAM_LEADER; its
  // absence here is the read-side enforcement biting.
  await expect(page2.getByText('PM-2026-000600')).toBeVisible();
  await expect(page2.getByText('PM-2026-000601')).not.toBeVisible();

  // Control: an UNSCOPED team leader genuinely sees both — proving the
  // absence above is the scope, not an accident of the fixture.
  const context3 = await browser.newContext();
  const page3 = await context3.newPage();
  await server.install(page3);
  await signInAs(page3, E2E_USERS.teamLeader.email, E2E_PASSWORD);
  await page3.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(page3.getByText('PM-2026-000600')).toBeVisible();
  await expect(page3.getByText('PM-2026-000601')).toBeVisible();

  await context2.close();
  await context3.close();
});

test('the last-admin self-deactivation refusal (SYS-11 409) is surfaced verbatim, not swallowed', async ({
  page,
  server,
}) => {
  void server;
  await signInAs(page, E2E_USERS.admin.email);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('button', { name: /^Users/ }).click();
  await page.getByRole('button', { name: /Test Administrator/ }).click();
  await expect(page.getByRole('heading', { name: 'Test Administrator' })).toBeVisible();

  await page.getByRole('button', { name: 'Deactivate this account' }).click();
  await page.getByRole('button', { name: 'Yes, deactivate' }).click();

  // The server's own sentence reaches the admin, and the account stays active.
  await expect(page.getByText(/last active ADMIN/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deactivate this account' })).toBeVisible();
});

test('a deactivated user can no longer sign in, and reactivation restores them', async ({
  page,
  server,
  browser,
}) => {
  void server;
  await signInAs(page, E2E_USERS.admin.email);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: /Test Delegate/ }).click();
  await expect(page.getByRole('heading', { name: 'Test Delegate' })).toBeVisible();
  await page.getByRole('button', { name: 'Deactivate this account' }).click();
  await page.getByRole('button', { name: 'Yes, deactivate' }).click();
  await expect(page.getByText('Deactivated.')).toBeVisible();

  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await server.install(page2);
  await page2.goto('/sign-in');
  await page2.getByLabel('Email').fill(E2E_USERS.delegate.email);
  await page2.getByLabel('Password').fill(E2E_PASSWORD);
  await page2.getByRole('button', { name: 'Sign in' }).click();
  // Same opaque refusal as a wrong password — the API never says which.
  await expect(page2.getByRole('alert')).toBeVisible();
  await expect(page2.getByRole('heading', { name: 'Your jobs' })).not.toBeVisible();

  await page.getByRole('button', { name: 'Reactivate this account' }).click();
  await expect(page.getByText('Reactivated.')).toBeVisible();
  await signInAs(page2, E2E_USERS.delegate.email, E2E_PASSWORD);

  await context2.close();
});
