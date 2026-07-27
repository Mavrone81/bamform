/**
 * One coherent visual language for record lifecycle status (§3.3): every
 * badge is icon + verbatim status word + tone — never colour alone (A-05),
 * and the label is the exact server vocabulary (`IN_PROGRESS`, not a
 * prettified paraphrase) because this is a controlled-document system where
 * the audit trail, the PDF export and the screen must agree word-for-word.
 * The mono face makes the machine words read as instrument states, not typos.
 */
const STATUS_META: Record<
  string,
  { icon: string; tone: 'neutral' | 'good' | 'bad' | 'attention' | 'info' }
> = {
  SCHEDULED: { icon: '◇', tone: 'neutral' },
  IN_PROGRESS: { icon: '◐', tone: 'info' },
  SUBMITTED: { icon: '▲', tone: 'attention' },
  RETURNED: { icon: '⟲', tone: 'bad' },
  VERIFIED: { icon: '✓', tone: 'good' },
  ARCHIVED: { icon: '▣', tone: 'neutral' },
  VOIDED: { icon: '⊘', tone: 'neutral' },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { icon: '◇', tone: 'neutral' as const };
  return (
    <span className="status-chip" data-tone={meta.tone}>
      <span aria-hidden="true">{meta.icon}</span>
      <span>{status}</span>
    </span>
  );
}
