import { Global, Module } from '@nestjs/common';
import { SecretFileLoader } from '../secret-loading/secret-loader';
import { BLIND_INDEX_KEY } from './auth.tokens';

/**
 * Wires `BLIND_INDEX_KEY` from the file-mounted secret (already declared in
 * `docker-compose.yml`'s `bamform-api` secrets list) — the only field
 * introduced ahead of slice 3's encryption work, and only because
 * `/auth/login` cannot look a user up by email without it (see
 * `crypto/blind-index.ts`).
 */
@Global()
@Module({
  providers: [
    {
      provide: BLIND_INDEX_KEY,
      useFactory: (): Buffer => {
        const raw = new SecretFileLoader().load('blind_index_key').toString('utf8').trim();
        return Buffer.from(raw, 'base64');
      },
    },
  ],
  exports: [BLIND_INDEX_KEY],
})
export class BlindIndexModule {}
