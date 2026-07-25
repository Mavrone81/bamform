/** The two BullMQ job payload/result shapes carried on `bamform-pdf` (`pdf.tokens.ts`). */

export interface PdfRenderJobPayload {
  recordId: string;
}

/** `pdfBase64` is returned directly in the BullMQ job result (no MinIO round-trip for a single render — see `pdf-coordinator.service.ts`). */
export interface PdfRenderJobResult {
  pdfBase64: string;
}

export interface PdfExportJobPayload {
  exportId: string;
}

export interface PdfExportJobResult {
  objectKey: string;
  recordCount: number;
}
