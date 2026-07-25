import { Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import { JOB_SUMMARY_INCLUDE } from '../jobs/job-include';
import { PdfRenderService } from '../pdf/pdf-render.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { buildExportManifestCsv, pdfEntryFilename, type ExportManifestRow } from './export-csv';
import { RecordExportRepository, recordIdsFromFilterJson } from './record-export.repository';

/**
 * WORKER-side processor for the `export` job on the `bamform-pdf` queue
 * (`pdf.tokens.ts`) — PR-119. Renders every snapshotted record id
 * (`record_export.filter_json.recordIds`, frozen at request time by
 * `records-export.service.ts`) through the SAME `PdfRenderService`
 * (`render-semaphore.ts`'s concurrency-2 cap) a single `GET
 * /records/{recordId}/pdf` call uses, then zips the PDFs plus a CSV
 * manifest (PR-119) and uploads the ZIP to MinIO — streamed back through
 * `api` on download (ADR-007), never presigned.
 */
@Injectable()
export class RecordsExportWorkerService {
  private readonly logger = new Logger(RecordsExportWorkerService.name);

  constructor(
    private readonly exportRepo: RecordExportRepository,
    private readonly prisma: PrismaService,
    private readonly renderer: PdfRenderService,
    private readonly minio: MinioService,
  ) {}

  async processExport(exportId: string): Promise<{ objectKey: string; recordCount: number }> {
    const row = await this.exportRepo.findById(exportId);
    if (!row) {
      throw new Error(`record_export ${exportId} not found`);
    }
    await this.exportRepo.markProcessing(exportId);

    const recordIds = recordIdsFromFilterJson(row.filterJson);
    try {
      const summaries = await this.prisma.job.findMany({
        where: { id: { in: recordIds } },
        include: JOB_SUMMARY_INCLUDE,
      });
      const summaryById = new Map(summaries.map((s) => [s.id, s]));

      const manifestRows: ExportManifestRow[] = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      const archiveFinished = new Promise<void>((resolve, reject) => {
        archive.on('end', () => resolve());
        archive.on('error', (err: Error) => reject(err));
      });

      for (const recordId of recordIds) {
        const summary = summaryById.get(recordId);
        if (!summary) {
          this.logger.warn(`export ${exportId}: record ${recordId} no longer found — skipped`);
          continue;
        }
        // Sequential by choice, not by lint constraint: each render already
        // serialises through the shared concurrency-2 semaphore; awaiting
        // here just keeps this job's OWN memory bounded to one PDF buffer
        // at a time rather than holding every rendered PDF simultaneously.
        const pdf = await this.renderer.renderRecordPdf(recordId);
        const filename = pdfEntryFilename(summary.jobNumber);
        archive.append(pdf, { name: filename });
        manifestRows.push({
          recordId,
          jobNumber: summary.jobNumber,
          assetCode: summary.asset.code,
          documentNumber: summary.templateRevision.formTemplate.documentNumber,
          revisionCode: summary.templateRevision.revisionCode,
          frequency: summary.frequency,
          archivedAt: summary.archivedAt ? summary.archivedAt.toISOString() : null,
          pdfFilename: filename,
        });
      }

      archive.append(buildExportManifestCsv(manifestRows), { name: 'manifest.csv' });
      await archive.finalize();
      await archiveFinished;

      const zipBuffer = Buffer.concat(chunks);
      const objectKey = `exports/${exportId}.zip`;
      await this.minio.putObject(objectKey, zipBuffer, 'application/zip');
      await this.exportRepo.markDone(exportId, objectKey);
      return { objectKey, recordCount: manifestRows.length };
    } catch (error) {
      await this.exportRepo.markFailed(exportId, String(error));
      throw error;
    }
  }
}
