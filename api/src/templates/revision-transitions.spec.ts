import { RevisionStatusT } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import {
  assertDraft,
  assertNotSelfApproval,
  assertPendingApproval,
  nextSequenceOrdinal,
} from './revision-transitions';

describe('Template revision lifecycle legality (PRD §5.2)', () => {
  describe('assertDraft — edit/items/measurements/submit only while DRAFT', () => {
    it('allows DRAFT', () => {
      expect(() => assertDraft(RevisionStatusT.draft)).not.toThrow();
    });

    it.each([
      RevisionStatusT.pending_approval,
      RevisionStatusT.current,
      RevisionStatusT.superseded,
      RevisionStatusT.rejected,
    ])('rejects %s with 409 /errors/invalid-transition', (status) => {
      expect(() => assertDraft(status)).toThrow(ConflictException);
      try {
        assertDraft(status);
        fail('expected throw');
      } catch (error) {
        expect((error as ConflictException).getResponse()).toMatchObject({
          type: '/errors/invalid-transition',
          status: 409,
        });
      }
    });
  });

  describe('assertPendingApproval — approve/reject only while PENDING_APPROVAL', () => {
    it('allows PENDING_APPROVAL', () => {
      expect(() => assertPendingApproval(RevisionStatusT.pending_approval)).not.toThrow();
    });

    it.each([
      RevisionStatusT.draft,
      RevisionStatusT.current,
      RevisionStatusT.superseded,
      RevisionStatusT.rejected,
    ])('rejects %s with 409 /errors/invalid-transition', (status) => {
      expect(() => assertPendingApproval(status)).toThrow(ConflictException);
    });
  });

  describe('assertNotSelfApproval — PR-047/INV-03', () => {
    it('allows a different approver', () => {
      expect(() => assertNotSelfApproval('author-1', 'approver-2')).not.toThrow();
    });

    it('rejects the author approving their own revision with 409 /errors/self-approval', () => {
      expect(() => assertNotSelfApproval('author-1', 'author-1')).toThrow();
      try {
        assertNotSelfApproval('author-1', 'author-1');
        fail('expected throw');
      } catch (error) {
        expect((error as ConflictException).getResponse()).toMatchObject({
          type: '/errors/self-approval',
          status: 409,
        });
      }
    });
  });

  describe('nextSequenceOrdinal — INV-02 contiguity', () => {
    it('returns 0 for the first revision of a template', () => {
      expect(nextSequenceOrdinal(null)).toBe(0);
    });

    it('returns max + 1 for a subsequent revision', () => {
      expect(nextSequenceOrdinal(3)).toBe(4);
    });
  });
});
