import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client } from 'minio';
import { MINIO_CLIENT } from './storage.tokens';

/**
 * Thin wrapper around the MinIO SDK, scoped to the single bucket this
 * application uses (`MINIO_BUCKET`, `.env.example`). ADR-007: every
 * attachment fetch streams through `api` — this service is the ONLY place
 * that ever talks to MinIO; nothing else in `jobs/` imports the `minio`
 * package directly, so authorisation (checked by the caller before this
 * service is invoked — see `attachments.service.ts`) can never accidentally
 * be bypassed by a shortcut fetch path.
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly bucket: string;

  constructor(
    @Inject(MINIO_CLIENT) private readonly client: Client,
    config: ConfigService,
  ) {
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'bamform-attachments';
  }

  /** Idempotent — safe to run on every boot (multiple replicas race harmlessly). */
  async onModuleInit(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`created MinIO bucket "${this.bucket}"`);
      }
    } catch (error) {
      // Do not crash the whole API on a transient MinIO outage at boot —
      // attachment endpoints will fail individually (and loudly) until MinIO
      // is reachable; job read/result capture must not be taken down with it.
      this.logger.warn(`could not verify/create MinIO bucket "${this.bucket}": ${String(error)}`);
    }
  }

  async putObject(objectKey: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, objectKey, buffer, buffer.length, {
      'Content-Type': contentType,
    });
  }

  /** Streamed read (ADR-007) — never a presigned URL. */
  async getObjectStream(objectKey: string): Promise<Readable> {
    return this.client.getObject(this.bucket, objectKey);
  }
}
