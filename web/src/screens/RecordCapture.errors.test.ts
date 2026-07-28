import { describe, expect, it } from 'vitest';
import { explainSubmitRejection } from './RecordCapture';

/**
 * The owner hit "The server rejected this submission: Validation failed" on a
 * real phone with a complete checklist and no way forward (2026-07-28). The
 * server HAD explained itself — an `errors[]` entry naming `/drawnSignature` —
 * and the screen read only `title`, the one field guaranteed to be generic.
 */
describe('explainSubmitRejection', () => {
  it('names the missing signature as an OUT-OF-DATE APP, not a checklist problem', () => {
    const msg = explainSubmitRejection({
      title: 'Validation failed',
      detail: 'Request body failed validation.',
      errors: [
        {
          pointer: '/drawnSignature',
          message: 'Invalid input: expected string, received undefined',
        },
      ],
    });
    // Retrying never fixes this: cached JS from before the signature step
    // exists cannot produce one. Sending the user back to a complete
    // checklist is the wrong instruction.
    expect(msg).toMatch(/out-of-date/i);
    expect(msg).toMatch(/reopen/i);
    expect(msg).not.toMatch(/mandatory item/i);
    // Their work must not read as lost.
    expect(msg).toMatch(/safely held/i);
  });

  it('names the failing FIELDS for any other validation error', () => {
    const msg = explainSubmitRejection({
      title: 'Validation failed',
      errors: [{ pointer: '/reason', message: 'too short' }],
    });
    expect(msg).toContain('reason');
    expect(msg).toContain('too short');
  });

  it('falls back to detail, then title, then a generic hint', () => {
    expect(explainSubmitRejection({ title: 'X', detail: 'the specific reason' })).toContain(
      'the specific reason',
    );
    expect(explainSubmitRejection({ title: 'Just a title' })).toContain('Just a title');
    expect(explainSubmitRejection(undefined)).toMatch(/mandatory item/i);
  });
});
