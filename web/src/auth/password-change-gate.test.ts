import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPasswordChangeRequired,
  isPasswordChangeRequired,
  isPasswordChangeRequiredProblem,
  markPasswordChangeRequired,
  onPasswordChangeRequired,
  _resetForTests,
} from './password-change-gate';

beforeEach(() => {
  _resetForTests();
});

describe('U-PWGATE-01: recognising the server’s problem document', () => {
  it('matches the relative type the api actually emits', () => {
    expect(
      isPasswordChangeRequiredProblem({
        type: '/errors/password-change-required',
        title: 'Password change required',
        status: 403,
      }),
    ).toBe(true);
  });

  it('matches the absolute form other problem documents in this system use', () => {
    expect(
      isPasswordChangeRequiredProblem({
        type: 'https://form.bevorasg.com/errors/password-change-required',
        title: 'Password change required',
        status: 403,
      }),
    ).toBe(true);
  });

  it('does not match any other 403 — a step-up or an out-of-scope must not trap the user', () => {
    expect(
      isPasswordChangeRequiredProblem({
        type: 'https://form.bevorasg.com/errors/step-up-required',
        title: 'x',
        status: 403,
      }),
    ).toBe(false);
    expect(isPasswordChangeRequiredProblem({ type: '/errors/out-of-scope' })).toBe(false);
    expect(isPasswordChangeRequiredProblem(undefined)).toBe(false);
    expect(isPasswordChangeRequiredProblem({})).toBe(false);
    expect(isPasswordChangeRequiredProblem('not an object')).toBe(false);
  });

  it('m4: does not match a type that merely CONTAINS the phrase mid-string — the match is endsWith, not includes', () => {
    expect(
      isPasswordChangeRequiredProblem({
        type: '/errors/password-change-required-exemption-granted',
        title: 'x',
        status: 403,
      }),
    ).toBe(false);
  });
});

describe('U-PWGATE-02: the latch', () => {
  it('starts clear, latches on, and clears again', () => {
    expect(isPasswordChangeRequired()).toBe(false);
    markPasswordChangeRequired();
    expect(isPasswordChangeRequired()).toBe(true);
    clearPasswordChangeRequired();
    expect(isPasswordChangeRequired()).toBe(false);
  });

  it('notifies subscribers on each real transition, and not on repeats', () => {
    const listener = vi.fn();
    const unsubscribe = onPasswordChangeRequired(listener);

    markPasswordChangeRequired();
    markPasswordChangeRequired(); // the guard fires on every request; one latch
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    clearPasswordChangeRequired();
    clearPasswordChangeRequired();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    markPasswordChangeRequired();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
