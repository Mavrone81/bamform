/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * U-BOUND-01/02 — the last resort added alongside review finding I-1.
 *
 * React logs a caught render error itself; that is React's, not ours, and it
 * is silenced here so an expected failure does not look like a broken test
 * run.
 */

function Explodes(): never {
  throw new Error('secret-bearing detail that must not be rendered');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('U-BOUND-01: a render throw becomes a readable screen with a way out, not a blank tab', () => {
    render(
      <ErrorBoundary>
        <Explodes />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: /Something went wrong/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /Reload the app/i })).toBeVisible();
    // The error's own text is never shown: anything in scope on these screens
    // can be a password, a TOTP code or a recovery code (non-negotiable #10).
    expect(screen.queryByText(/secret-bearing detail/)).toBeNull();
  });

  it('U-BOUND-02: it is invisible when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the app</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Something went wrong/i })).toBeNull();
  });
});
