import { useEffect, useState } from 'react';
import { RouterProvider, useRouter, matchPath } from './router';
import { SignIn } from './screens/SignIn';
import { JobList } from './screens/JobList';
import { RecordCapture } from './screens/RecordCapture';
import { VerifierQueue } from './screens/VerifierQueue';
import { RecordReview } from './screens/RecordReview';
import { Delegations } from './screens/Delegations';
import { ChangePassword } from './screens/ChangePassword';
import { AdminMfaReset } from './screens/AdminMfaReset';
import { AdminHome } from './screens/AdminHome';
import { AdminUsers } from './screens/AdminUsers';
import { AdminUserCreate } from './screens/AdminUserCreate';
import { AdminUserDetail } from './screens/AdminUserDetail';
import { AdminMachines } from './screens/AdminMachines';
import { AdminMachineCreate } from './screens/AdminMachineCreate';
import { AdminMachineDetail } from './screens/AdminMachineDetail';
import { AdminAreas } from './screens/AdminAreas';
import { RecoveryCodes } from './screens/RecoveryCodes';
import { Menu } from './screens/Menu';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NavShell } from './components/NavShell';
import {
  getAccessToken,
  onTokenChange,
  ensureFreshToken,
  isPasswordChangeRequired,
  onPasswordChangeRequired,
  getPendingRecoveryCodes,
  onPendingRecoveryCodesChange,
} from './auth';
import { watchOnlineAndDrain, triggerDrainIfOnline } from './offline/sync-engine';
import { ensurePersistentStorage } from './offline/persistence';
import { notifySynced } from './offline/sync-events';
import { getServices, getSyncUserId } from './state/services';
import './styles/global.css';

function Screens() {
  const { path, navigate } = useRouter();
  const [authed, setAuthed] = useState(() => Boolean(getAccessToken()));
  const [checkingSession, setCheckingSession] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(() => isPasswordChangeRequired());
  const [recoveryCodes, setRecoveryCodes] = useState(() => getPendingRecoveryCodes());

  useEffect(() => {
    // A hard reload always starts with no in-memory token (non-negotiable
    // #10) — attempt one silent refresh against the HttpOnly cookie before
    // deciding the user needs to sign in again.
    ensureFreshToken().finally(() => setCheckingSession(false));
    return onTokenChange((state) => setAuthed(Boolean(state)));
  }, []);

  // Slice 13-MFA §7: the server refuses `403 /errors/password-change-required`
  // on every endpoint but three until an admin-set password is changed.
  // `api/http-transport.ts` latches that centrally; this is the one place the
  // app reacts to it, so no screen has to know the rule exists.
  useEffect(() => onPasswordChangeRequired(setMustChangePassword), []);

  // Confirming enrolment mid-login authenticates the app in the same tick it
  // returns the ten one-time recovery codes, so the sign-in screen holding
  // them is unmounted immediately. They are latched instead, and shown here,
  // across that transition — see auth/recovery-codes-store.ts.
  useEffect(() => onPendingRecoveryCodesChange(setRecoveryCodes), []);

  useEffect(() => {
    if (!checkingSession && !authed && path !== '/sign-in') navigate('/sign-in');
    if (!checkingSession && authed && path === '/sign-in') navigate('/jobs');
  }, [authed, checkingSession, path, navigate]);

  // SYS-15: ask the browser to protect this origin's IndexedDB from
  // eviction, once, at sign-in — unsent records live there, and iOS wipes
  // non-persisted storage after 7 days of absence. Fire-and-forget: the
  // outcome is recorded in `meta` and surfaced by the job list's sync area.
  useEffect(() => {
    if (!authed) return;
    void ensurePersistentStorage(getServices().db)
      // The job list surfaces a refusal in its sync area; it may already
      // have mounted and read the (not-yet-recorded) outcome, so tell it.
      .then(() => notifySynced())
      .catch(() => {
        /* never allowed to break sign-in */
      });
    // SYS-6: work held for THIS user resumes sending the moment they sign
    // back in — without this, rows preserved across a sign-out would wait
    // for the next `online` TRANSITION event, which never fires for a
    // device that stayed online the whole time.
    const { db, transport } = getServices();
    triggerDrainIfOnline(db, transport, getSyncUserId, () => notifySynced());
  }, [authed]);

  if (checkingSession) {
    return (
      <main className="app-shell app-shell--standalone">
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      </main>
    );
  }

  if (!authed) return <SignIn />;

  // Shown once, ahead of everything else: there is no endpoint that can ever
  // reissue these, so nothing may take the screen away from the user first.
  // Rendered WITHOUT the navigation shell, deliberately — it is a gate, and
  // offering navigation away from it would defeat its purpose.
  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} />;

  // Rendered in place of the whole app, not as a route: the user is
  // authenticated but every other endpoint is closed to them, so offering any
  // other screen would only produce failures they cannot act on. Also shell-
  // less: navigation controls to screens that all 403 would be noise.
  if (mustChangePassword) return <ChangePassword forced />;

  // Everything below lives inside the navigation shell (slice 14-DESIGN):
  // bottom tabs on phones, side rail on tablet/desktop. The shell is
  // presentation only — routing stays exactly this path matcher, and every
  // screen stays reachable by URL regardless of which tabs are offered.
  const screen = (() => {
    const reviewParams = matchPath('/jobs/:id/review', path);
    if (reviewParams) return <RecordReview jobId={reviewParams.id} />;
    if (matchPath('/queue', path)) return <VerifierQueue />;
    if (matchPath('/delegations', path)) return <Delegations />;
    if (matchPath('/change-password', path)) return <ChangePassword />;
    if (matchPath('/admin/mfa-reset', path)) return <AdminMfaReset />;
    // Slice 13-UI-B — the admin area. Routing only; ADMIN-ness is decided by
    // the server per request (non-negotiable #6): a non-admin reaching any
    // of these URLs sees the API's own 403 surfaced by the screen.
    if (matchPath('/admin', path)) return <AdminHome />;
    if (matchPath('/admin/users/new', path)) return <AdminUserCreate />;
    const adminUserParams = matchPath('/admin/users/:id', path);
    if (adminUserParams) return <AdminUserDetail userId={adminUserParams.id} />;
    if (matchPath('/admin/users', path)) return <AdminUsers />;
    if (matchPath('/admin/machines/new', path)) return <AdminMachineCreate />;
    const adminMachineParams = matchPath('/admin/machines/:id', path);
    if (adminMachineParams) return <AdminMachineDetail assetId={adminMachineParams.id} />;
    if (matchPath('/admin/machines', path)) return <AdminMachines />;
    if (matchPath('/admin/areas', path)) return <AdminAreas />;
    if (matchPath('/menu', path)) return <Menu />;
    const jobParams = matchPath('/jobs/:id', path);
    if (jobParams) return <RecordCapture jobId={jobParams.id} />;
    return <JobList />;
  })();

  return <NavShell>{screen}</NavShell>;
}

export function App() {
  useEffect(() => {
    // Registered exactly once for the whole app (PR-069/UR-088): a
    // technician can be on any screen when connectivity returns, and the
    // resulting drain must be reflected wherever they are, not only on the
    // job list. Screens subscribe via offline/sync-events instead of each
    // wiring their own `online` listener.
    // SYS-6: the drain resolves the signed-in principal AT EVENT TIME
    // (`getSyncUserId`), so reconnecting while user B is signed in drains
    // exactly B's rows — never the whole device's.
    const { db, transport } = getServices();
    return watchOnlineAndDrain(db, transport, getSyncUserId, () => notifySynced());
  }, []);

  return (
    <RouterProvider>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div id="main-content">
        {/* Last resort only: a render throw would otherwise unmount the root
         * and leave a blank tab with no way back (review finding I-1). */}
        <ErrorBoundary>
          <Screens />
        </ErrorBoundary>
      </div>
    </RouterProvider>
  );
}
