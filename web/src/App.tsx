import { useEffect, useState } from 'react';
import { RouterProvider, useRouter, matchPath } from './router';
import { SignIn } from './screens/SignIn';
import { JobList } from './screens/JobList';
import { RecordCapture } from './screens/RecordCapture';
import { VerifierQueue } from './screens/VerifierQueue';
import { RecordReview } from './screens/RecordReview';
import { Delegations } from './screens/Delegations';
import { getAccessToken, onTokenChange, ensureFreshToken } from './auth';
import { watchOnlineAndDrain } from './offline/sync-engine';
import { notifySynced } from './offline/sync-events';
import { getServices } from './state/services';
import './styles/global.css';

function Screens() {
  const { path, navigate } = useRouter();
  const [authed, setAuthed] = useState(() => Boolean(getAccessToken()));
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    // A hard reload always starts with no in-memory token (non-negotiable
    // #10) — attempt one silent refresh against the HttpOnly cookie before
    // deciding the user needs to sign in again.
    ensureFreshToken().finally(() => setCheckingSession(false));
    return onTokenChange((state) => setAuthed(Boolean(state)));
  }, []);

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

  const reviewParams = matchPath('/jobs/:id/review', path);
  if (reviewParams) return <RecordReview jobId={reviewParams.id} />;
  if (matchPath('/queue', path)) return <VerifierQueue />;
  if (matchPath('/delegations', path)) return <Delegations />;
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
        <Screens />
      </div>
    </RouterProvider>
  );
}
