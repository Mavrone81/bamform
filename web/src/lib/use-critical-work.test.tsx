import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useCriticalWork } from './use-critical-work';
import { __resetUpdateStateForTests, criticalWorkCount } from '../update';

function Screen({ busy }: { busy: boolean }) {
  useCriticalWork(busy, 'test-screen');
  return null;
}

beforeEach(() => __resetUpdateStateForTests());
afterEach(() => cleanup());

describe('useCriticalWork', () => {
  it('holds the gate only while the screen says it is busy', () => {
    const { rerender } = render(<Screen busy={false} />);
    expect(criticalWorkCount()).toBe(0);

    rerender(<Screen busy={true} />);
    expect(criticalWorkCount()).toBe(1);

    rerender(<Screen busy={false} />);
    expect(criticalWorkCount()).toBe(0);
  });

  it('releases the gate when the screen unmounts mid-work', () => {
    // The case that matters: a technician navigates away, or the screen
    // throws, while the signature pad is open. A gate left open would block
    // every future update for the life of the page.
    const { unmount } = render(<Screen busy={true} />);
    expect(criticalWorkCount()).toBe(1);
    unmount();
    expect(criticalWorkCount()).toBe(0);
  });
});
