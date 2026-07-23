import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlindIndexModule } from '../auth/blind-index.module';
import { BLIND_INDEX_KEY } from '../auth/auth.tokens';
import { SecretFileLoader } from '../secret-loading/secret-loader';
import { buildFieldEncryptionService } from './crypto-bootstrap';
import { FIELD_ENCRYPTION_SERVICE, RECORD_SIGNING_SERVICE } from './crypto.tokens';
import { RecordSigningService } from './record-signer';

/**
 * Wires the production crypto services from file-mounted secrets (non-negotiable #9):
 *  - `kek` / `dek_wrapped` (already declared in `docker-compose.yml`'s `bamform-api`
 *    secrets list, provisioned ahead of this slice) → `FIELD_ENCRYPTION_SERVICE`
 *    (PR-106/107).
 *  - `record_signing_key` → `RECORD_SIGNING_SERVICE` (PR-094, PR-SEC-07), distinct
 *    from `JWT_SIGNING_KEY` (see `JwtKeysModule`).
 *
 * Imports `BlindIndexModule` (rather than duplicating its secret load) purely so this
 * module can perform the PR-SEC-08 / U-ENC-07 startup assertion that the DEK and
 * `BLIND_INDEX_KEY` are distinct — see `crypto-bootstrap.ts`.
 */
@Global()
@Module({
  imports: [BlindIndexModule],
  providers: [
    {
      provide: FIELD_ENCRYPTION_SERVICE,
      inject: [ConfigService, BLIND_INDEX_KEY],
      useFactory: (config: ConfigService, blindIndexKey: Buffer) => {
        const loader = new SecretFileLoader();
        const kek = Buffer.from(loader.load('kek').toString('utf8').trim(), 'base64');
        const wrappedDek = Buffer.from(
          loader.load('dek_wrapped').toString('utf8').trim(),
          'base64',
        );
        const currentDekVersion = Number(config.get('DEK_VERSION') ?? 1);
        return buildFieldEncryptionService({ kek, wrappedDek, currentDekVersion, blindIndexKey });
      },
    },
    {
      provide: RECORD_SIGNING_SERVICE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RecordSigningService => {
        const pem = new SecretFileLoader().load('record_signing_key', 'record_signing_key.pem');
        const kid = config.get<string>('RECORD_SIGNING_KID') ?? 'bf-rec-2026-07';
        return new RecordSigningService(pem, kid);
      },
    },
  ],
  exports: [FIELD_ENCRYPTION_SERVICE, RECORD_SIGNING_SERVICE],
})
export class CryptoModule {}
