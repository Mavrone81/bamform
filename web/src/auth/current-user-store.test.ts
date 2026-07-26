import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCurrentUser,
  currentUserHasRole,
  getCurrentUser,
  onCurrentUserChange,
  setCurrentUser,
  _resetForTests,
} from './current-user-store';

const ADMIN = { id: 'u1', fullName: 'Admin', roles: ['ADMIN', 'ENGINEER'] };

beforeEach(() => {
  _resetForTests();
});

describe('U-USER-01: the cached principal', () => {
  it('holds and clears what the server last reported', () => {
    expect(getCurrentUser()).toBeNull();
    setCurrentUser(ADMIN);
    expect(getCurrentUser()).toEqual(ADMIN);
    clearCurrentUser();
    expect(getCurrentUser()).toBeNull();
  });

  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onCurrentUserChange(listener);

    setCurrentUser(ADMIN);
    expect(listener).toHaveBeenCalledWith(ADMIN);

    unsubscribe();
    clearCurrentUser();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('U-USER-02: role checks are presentation only', () => {
  it('answers from the cached roles, and false whenever nothing is cached', () => {
    expect(currentUserHasRole('ADMIN')).toBe(false);
    setCurrentUser(ADMIN);
    expect(currentUserHasRole('ADMIN')).toBe(true);
    expect(currentUserHasRole('MAINTAINER')).toBe(false);
    clearCurrentUser();
    expect(currentUserHasRole('ADMIN')).toBe(false);
  });
});
