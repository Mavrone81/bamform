import { useEffect, useState } from 'react';
import { RouterProvider, useRouter, matchPath } from './router';
import { SignIn } from './screens/SignIn';
import { JobList } from './screens/JobList';
import { RecordCapture } from './screens/RecordCapture';
import { getAccessToken, onTokenChange, ensureFreshToken } from './auth';
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

  const jobParams = matchPath('/jobs/:id', path);
  if (jobParams) return <RecordCapture jobId={jobParams.id} />;
  return <JobList />;
}

export function App() {
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
