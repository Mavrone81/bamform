import { useState, type FormEvent } from 'react';
import { login } from '../auth';
import { useRouter } from '../router';

export function SignIn() {
  const { navigate } = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/jobs');
    } catch {
      // PR-007: the client never decides WHY auth failed (locked account,
      // wrong password, rate limited) — that judgement, and any detail
      // that could help an attacker enumerate accounts, stays server-side.
      setError('Sign-in failed. Check your email and password and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">BamForm</h1>
      <p>Preventive Maintenance Record and Approval System</p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn-primary"
          disabled={submitting}
          style={{ marginTop: 'var(--space-5)', width: '100%' }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
