import { RevisionStatusT, SpecTypeT, type Prisma } from '@prisma/client';
import type {
  FormTemplate,
  RevisionStatus,
  SpecType,
  StandingContent,
  TemplateItem,
  TemplateMeasurement,
  TemplateRevision,
} from '@bamform/shared';

export const REVISION_STATUS_FROM_DB: Record<RevisionStatusT, RevisionStatus> = {
  [RevisionStatusT.draft]: 'DRAFT',
  [RevisionStatusT.pending_approval]: 'PENDING_APPROVAL',
  [RevisionStatusT.current]: 'CURRENT',
  [RevisionStatusT.superseded]: 'SUPERSEDED',
  [RevisionStatusT.rejected]: 'REJECTED',
};

export const SPEC_TYPE_TO_DB: Record<SpecType, SpecTypeT> = {
  RANGE: SpecTypeT.range,
  TOLERANCE: SpecTypeT.tolerance,
  PASS_FAIL: SpecTypeT.pass_fail,
  TEXT: SpecTypeT.text,
};

export const SPEC_TYPE_FROM_DB: Record<SpecTypeT, SpecType> = {
  [SpecTypeT.range]: 'RANGE',
  [SpecTypeT.tolerance]: 'TOLERANCE',
  [SpecTypeT.pass_fail]: 'PASS_FAIL',
  [SpecTypeT.text]: 'TEXT',
};

type TemplateItemRow = Prisma.TemplateItemGetPayload<Record<string, never>>;
type TemplateMeasurementRow = Prisma.TemplateMeasurementGetPayload<Record<string, never>>;
type FormTemplateRow = Prisma.FormTemplateGetPayload<Record<string, never>>;
export type TemplateRevisionRowWithRelations = Prisma.TemplateRevisionGetPayload<{
  include: { formTemplate: true; items: true; measurements: true };
}>;

export function toTemplateItem(row: TemplateItemRow): TemplateItem {
  return {
    id: row.id,
    itemNo: row.itemNo,
    frequency: row.frequency,
    instruction: row.instruction,
    mandatory: row.mandatory,
    stableKey: row.stableKey,
    displayOrder: row.displayOrder,
  };
}

export function toTemplateMeasurement(row: TemplateMeasurementRow): TemplateMeasurement {
  return {
    id: row.id,
    section: row.section,
    description: row.description,
    unit: row.unit,
    specType: SPEC_TYPE_FROM_DB[row.specType],
    lowerLimit: row.lowerLimit ? row.lowerLimit.toNumber() : null,
    upperLimit: row.upperLimit ? row.upperLimit.toNumber() : null,
    nominal: row.nominal ? row.nominal.toNumber() : null,
    tolerance: row.tolerance ? row.tolerance.toNumber() : null,
    specDisplay: row.specDisplay,
    stableKey: row.stableKey,
    displayOrder: row.displayOrder,
  };
}

export function toTemplateRevision(
  row: Partial<TemplateRevisionRowWithRelations> &
    Pick<
      TemplateRevisionRowWithRelations,
      | 'id'
      | 'formTemplateId'
      | 'revisionCode'
      | 'sequenceOrdinal'
      | 'status'
      | 'changeDescription'
      | 'standingContent'
      | 'authoredBy'
      | 'approvedBy'
      | 'approvedAt'
      | 'rejectedReason'
      | 'effectiveFrom'
      | 'supersededAt'
    >,
): TemplateRevision {
  return {
    id: row.id,
    formTemplateId: row.formTemplateId,
    documentNumber: row.formTemplate?.documentNumber,
    title: row.formTemplate?.title,
    revisionCode: row.revisionCode,
    sequenceOrdinal: row.sequenceOrdinal,
    status: REVISION_STATUS_FROM_DB[row.status],
    changeDescription: row.changeDescription,
    standingContent: row.standingContent as StandingContent,
    authoredBy: row.authoredBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedReason: row.rejectedReason,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    items: row.items?.map(toTemplateItem),
    measurements: row.measurements?.map(toTemplateMeasurement),
  };
}

export function toFormTemplate(
  row: FormTemplateRow,
  assetTypeId: string | null,
  currentRevisionId: string | null,
): FormTemplate {
  return {
    id: row.id,
    documentNumber: row.documentNumber,
    title: row.title,
    active: row.active,
    assetTypeId,
    currentRevisionId,
  };
}
