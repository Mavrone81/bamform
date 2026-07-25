import { createHash } from 'node:crypto';
import {
  type AuditChainRow,
  INITIAL_CHAIN_WALK_STATE,
  walkChainPage,
} from './chain-verification.logic';

/** sha256 stand-in for content — the actual formula is exercised at the integration level (I-INV-12). */
function h(label: string): Buffer {
  return createHash('sha256').update(label).digest();
}

/** Builds a clean, linked chain of `count` rows where expectedHash always equals hash. */
function buildCleanChain(count: number, startSequence = 1n): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: Buffer | null = null;
  for (let i = 0; i < count; i += 1) {
    const hash = h(`row-${startSequence + BigInt(i)}`);
    rows.push({
      sequence: startSequence + BigInt(i),
      prevHash: prev,
      hash,
      expectedHash: hash,
    });
    prev = hash;
  }
  return rows;
}

describe('chain-verification.logic — walkChainPage (I-INV-12 unit level)', () => {
  it('reports intact (no break) for a clean, fully-linked chain', () => {
    const rows = buildCleanChain(5);
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBeNull();
    expect(outcome.state.lastSequence).toBe(5n);
    expect(outcome.state.lastHash).toEqual(rows[4].hash);
  });

  it('detects a mutated field: expectedHash (recomputed) differs from stored hash', () => {
    const rows = buildCleanChain(5);
    // Row 3's stored hash was tampered directly (e.g. `UPDATE ... SET hash =`)
    // — expectedHash (recomputed from current fields) no longer matches it.
    rows[2] = { ...rows[2], hash: h('tampered') };
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBe(3n);
  });

  it("detects a broken link: stored prevHash does not match the previous row's hash", () => {
    const rows = buildCleanChain(5);
    // Row 4's prevHash was altered (or row 3's hash silently changed without
    // recomputing anything downstream) so the two no longer agree.
    rows[3] = { ...rows[3], prevHash: h('not-row-3-hash') };
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBe(4n);
  });

  it('detects a deleted row via the link check, even though its sequence gap is NOT itself checked', () => {
    // Row with sequence 3 is missing entirely (deleted, or its insert never
    // committed). Numeric sequence contiguity is deliberately NOT asserted
    // (see this module's header — the real trigger leaves harmless gaps of
    // 2 on every ordinary insert), so this must be caught by the LINK
    // check alone: row 4's prevHash was fixed at insert time to row 3's
    // hash, which is no longer anywhere in this scan once row 3 is gone.
    const rows = buildCleanChain(5);
    const withGap = [rows[0], rows[1], rows[3], rows[4]];
    const outcome = walkChainPage(withGap);
    expect(outcome.firstBreakSequence).toBe(4n); // the row right after the gap
  });

  it('does NOT flag a numeric sequence gap by itself when the link and content are otherwise consistent', () => {
    // Regression pin for the false-break this module's header documents:
    // the real slice-1 trigger leaves a gap of (usually) 2 between every
    // ordinary committed row's "sequence" — that alone must never be
    // treated as a break.
    const rows: AuditChainRow[] = [
      { sequence: 2n, prevHash: null, hash: h('row-2'), expectedHash: h('row-2') },
      { sequence: 4n, prevHash: h('row-2'), hash: h('row-4'), expectedHash: h('row-4') },
      { sequence: 6n, prevHash: h('row-4'), hash: h('row-6'), expectedHash: h('row-6') },
    ];
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBeNull();
  });

  it('detects the true first row of the table missing a null prevHash requirement', () => {
    // The scan's first-ever row must have prevHash === null. If it doesn't
    // (e.g. the genuine first row of all time was deleted, and scanning
    // starts from what is now the earliest surviving row), that is a break.
    const rows = buildCleanChain(3, 5n); // starts at sequence 5, as if 1-4 vanished
    rows[0] = { ...rows[0], prevHash: h('some-earlier-hash') }; // as it legitimately would have been
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBe(5n);
  });

  it('does NOT flag a legitimate empty-chain start (first row ever, prevHash null)', () => {
    const rows = buildCleanChain(1); // sequence 1, prevHash null — the real first insert
    const outcome = walkChainPage(rows);
    expect(outcome.firstBreakSequence).toBeNull();
  });

  it('carries state across pages (paginated verification) and stays clean', () => {
    const rows = buildCleanChain(10);
    const page1 = rows.slice(0, 4);
    const page2 = rows.slice(4, 10);

    const outcome1 = walkChainPage(page1, INITIAL_CHAIN_WALK_STATE);
    expect(outcome1.firstBreakSequence).toBeNull();

    const outcome2 = walkChainPage(page2, outcome1.state);
    expect(outcome2.firstBreakSequence).toBeNull();
    expect(outcome2.state.lastSequence).toBe(10n);
  });

  it('detects a break that only becomes visible on the second page (link straddles the page boundary)', () => {
    const rows = buildCleanChain(10);
    // Sever the link right at the boundary: row 5 (index 4, first of page 2)
    // gets a prevHash that does not match row 4's (last of page 1) hash.
    rows[4] = { ...rows[4], prevHash: h('wrong-parent') };
    const page1 = rows.slice(0, 4);
    const page2 = rows.slice(4, 10);

    const outcome1 = walkChainPage(page1, INITIAL_CHAIN_WALK_STATE);
    expect(outcome1.firstBreakSequence).toBeNull();

    const outcome2 = walkChainPage(page2, outcome1.state);
    expect(outcome2.firstBreakSequence).toBe(5n);
  });

  it('handles an empty table (no rows at all) as intact', () => {
    const outcome = walkChainPage([]);
    expect(outcome.firstBreakSequence).toBeNull();
    expect(outcome.state).toEqual(INITIAL_CHAIN_WALK_STATE);
  });
});
