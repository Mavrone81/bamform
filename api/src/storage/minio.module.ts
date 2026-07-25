import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { SecretFileLoader } from '../secret-loading/secret-loader';
import { MINIO_CLIENT } from './storage.tokens';
import { MinioService } from './minio.service';

/**
 * PR-010/ADR-007 — MinIO object storage for attachments, streamed through
 * `api` (never presigned). Root credentials: `MINIO_ROOT_USER` is plain
 * config (`.env.example`, not secret); the password is loaded via
 * `SecretFileLoader` from the `minio_root_password` Docker secret
 * (`docker-compose.yml`'s `bamform-minio` service reads the SAME file via
 * `MINIO_ROOT_PASSWORD_FILE`) — falling back to the git-ignored
 * `secrets/minio_root_password` for local dev/test/CI
 * (`scripts/dev/generate-dev-secrets.sh`), mirroring `CryptoModule`'s
 * pattern for key material rather than `RedisModule`/`PrismaService`'s
 * still-open "credential injection not yet wired" gap (see those files'
 * comments) — this is a fresh integration, not an inherited one, so it is
 * wired correctly from the start.
 *
 * No dedicated service account exists yet (the client connects as the MinIO
 * root user) — acceptable for a single-application internal object store
 * with no host port published (PR-ENV-11); a scoped service-account
 * migration is a reasonable future hardening step, not required by any
 * PR-xxx this slice implements.
 */
@Global()
@Module({
  providers: [
    {
      provide: MINIO_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Client => {
        const endpoint = config.get<string>('MINIO_ENDPOINT') ?? 'bamform-minio:9000';
        const [endPoint, portStr] = endpoint.split(':');
        const accessKey = config.get<string>('MINIO_ROOT_USER') ?? 'bamform';
        const secretKey = new SecretFileLoader()
          .load('minio_root_password')
          .toString('utf8')
          .trim();
        return new Client({
          endPoint,
          port: portStr ? Number(portStr) : 9000,
          useSSL: false, // internal docker network only — no host port published (PR-ENV-11)
          accessKey,
          secretKey,
        });
      },
    },
    MinioService,
  ],
  exports: [MinioService],
})
export class MinioModule {}
