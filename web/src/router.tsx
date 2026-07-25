import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * A deliberately minimal client-side router — this foundation pass has
 * three screens (sign-in, job list, record capture). Pulling in a routing
 * library's data-loading/layout conventions here would be scope the O-suite
 * and outbox work doesn't need yet; History API + a tiny path matcher is
 * easier to audit and swap out later if the screen count grows.
 */

interface RouterState {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState(null, '', to);
    // `path` tracks the PATHNAME only (matching the initial state above and
    // every `matchPath` caller's expectation) even when `to` carries a query
    // string (slice 11b: VerifierQueue -> RecordReview passes `onBehalfOf`
    // that way) — the browser URL still gets the full `to`, a screen just
    // reads `window.location.search` itself if it needs the query part.
    setPath(window.location.pathname);
  };

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used within RouterProvider');
  return ctx;
}

/** Matches `/jobs/:id` style patterns against the current path. Returns the
 * captured params, or null if the path does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
