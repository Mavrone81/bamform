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
import { RecoveryCodes } from './screens/RecoveryCodes';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  getAccessToken,
  onTokenChange,
  ensureFreshToken,
  isPasswordChangeRequired,
  onPasswordChangeRequired,
  getPendingRecoveryCodes,
  onPendingRecoveryCodesChange,
} from './auth';
import { watchOnlineAndDrain } from './offline/sync-engine';
import { notifySynced } from './offline/sync-events';
import { getServices } from './state/services';
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

  if (checkingSession) {
    return (
      <main className="app-shell">
        <p>Loading…</p>
      </main>
    );
  }

  if (!authed) return <SignIn />;

  // Shown once, ahead of everything else: there is no endpoint that can ever
  // reissue these, so nothing may take the screen away from the user first.
  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} />;

  // Rendered in place of the whole app, not as a route: the user is
  // authenticated but every other endpoint is closed to them, so offering any
  // other screen would only produce failures they cannot act on.
  if (mustChangePassword) return <ChangePassword forced />;

  const reviewParams = matchPath('/jobs/:id/review', path);
  if (reviewParams) return <RecordReview jobId={reviewParams.id} />;
  if (matchPath('/queue', path)) return <VerifierQueue />;
  if (matchPath('/delegations', path)) return <Delegations />;
  if (matchPath('/change-password', path)) return <ChangePassword />;
  if (matchPath('/admin/mfa-reset', path)) return <AdminMfaReset />;
  const jobParams = matchPath('/jobs/:id', path);
  if (jobParams) return <RecordCapture jobId={jobParams.id} />;
  return <JobList />;
}

export function App() {
  useEffect(() => {
    // Registered exactly once for the whole app (PR-069/UR-088): a
    // technician can be on any screen when connectivity returns, and the
    // resulting drain must be reflected wherever they are, not only on the
    // job list. Screens subscribe via offline/sync-events instead of each
    // wiring their own `online` listener.
    const { db, transport } = getServices();
    return watchOnlineAndDrain(db, transport, () => notifySynced());
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
