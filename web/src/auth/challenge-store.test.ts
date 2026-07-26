import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertChallengeNeverPersisted,
  challengeMillisRemaining,
  clearChallenge,
  getChallengeToken,
  isChallengeExpired,
  isChallengedUserEnrolled,
  setChallenge,
  _resetForTests,
} from './challenge-store';

beforeEach(() => {
  _resetForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('U-CHAL-01: the challenge token lives in memory only', () => {
  it('writes nothing to localStorage or sessionStorage when set', () => {
    setChallenge('challenge-secret', 300, true);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(() => assertChallengeNeverPersisted()).not.toThrow();
  });

  it('the leak guard actually fires if something else persists the value', () => {
    // Proves the guard is a real check rather than a vacuous one: if a future
    // edit (or another module) writes the token anywhere persistent, this is
    // what breaks.
    setChallenge('challenge-secret', 300, true);
    window.localStorage.setItem('oops', 'wrapper:challenge-secret');

    expect(() => assertChallengeNeverPersisted()).toThrow(/non-negotiable #10/);
  });

  it('the leak guard checks sessionStorage too, and tolerates unrelated keys', () => {
    setChallenge('challenge-secret', 300, true);
    window.localStorage.setItem('unrelated', 'nothing to see');
    expect(() => assertChallengeNeverPersisted()).not.toThrow();

    window.sessionStorage.setItem('oops', 'challenge-secret');
    expect(() => assertChallengeNeverPersisted()).toThrow(/sessionStorage/);
  });

  it('is a no-op guard when no challenge is held', () => {
    window.localStorage.setItem('anything', 'value');
    expect(() => assertChallengeNeverPersisted()).not.toThrow();
  });
});

describe('U-CHAL-02: expiry', () => {
  it('reports the challenge gone once its five minutes have passed', () => {
    vi.useFakeTimers();
    setChallenge('challenge-abc', 300, true);

    expect(getChallengeToken()).toBe('challenge-abc');
    expect(isChallengeExpired()).toBe(false);
    expect(challengeMillisRemaining()).toBe(300_000);

    vi.advanceTimersByTime(299_000);
    expect(getChallengeToken()).toBe('challenge-abc');
    expect(challengeMillisRemaining()).toBe(1_000);

    vi.advanceTimersByTime(1_000);
    expect(isChallengeExpired()).toBe(true);
    expect(getChallengeToken()).toBeNull();
    expect(isChallengedUserEnrolled()).toBeNull();
    expect(challengeMillisRemaining()).toBe(0);
  });

  it('reports nothing held before any challenge is issued, and after it is cleared', () => {
    expect(isChallengeExpired()).toBe(true);
    expect(getChallengeToken()).toBeNull();
    expect(isChallengedUserEnrolled()).toBeNull();
    expect(challengeMillisRemaining()).toBe(0);

    setChallenge('challenge-abc', 300, false);
    expect(isChallengedUserEnrolled()).toBe(false);

    clearChallenge();
    expect(getChallengeToken()).toBeNull();
    expect(challengeMillisRemaining()).toBe(0);
  });
});

describe('U-CHAL-03: enrolment state comes from the server', () => {
  it('reports exactly what the login response said, for either value', () => {
    setChallenge('a', 300, true);
    expect(isChallengedUserEnrolled()).toBe(true);
    setChallenge('b', 300, false);
    expect(isChallengedUserEnrolled()).toBe(false);
  });

  it('replaces a previous challenge rather than accumulating', () => {
    setChallenge('first', 300, true);
    setChallenge('second', 300, false);
    expect(getChallengeToken()).toBe('second');
  });
});
