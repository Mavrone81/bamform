import type { components } from '../api/generated/openapi-types';

type ItemStatus = components['schemas']['ItemStatus'];

const OPTIONS: Array<{ value: ItemStatus; text: string; icon: string; tone: 'good' | 'bad' | 'neutral' }> = [
  { value: 'DONE', text: 'Done', icon: '✓', tone: 'good' },
  { value: 'NOT_DONE', text: 'Not done', icon: '✕', tone: 'bad' },
  { value: 'NOT_APPLICABLE', text: 'N/A', icon: '—', tone: 'neutral' },
];

/**
 * One-tap checklist item status (UR-082/P-05: 14 items in under 5 minutes).
 * A 3-segment control rather than a dropdown or checkbox trio — one thumb
 * tap, no fine motor precision required with gloves, and the current value
 * is legible at a glance by shape+text (A-05), not colour alone.
 */
export function ItemStatusControl({
  itemNo,
  instruction,
  value,
  onChange,
}: {
  itemNo: number;
  instruction: string;
  value: ItemStatus | null;
  onChange: (status: ItemStatus) => void;
}) {
  const groupLabel = `Item ${itemNo}: ${instruction}`;
  return (
    <div className="segmented" role="group" aria-label={groupLabel}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-tone={opt.tone}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          <span aria-hidden="true">{opt.icon}</span>
          {opt.text}
        </button>
      ))}
    </div>
  );
}
