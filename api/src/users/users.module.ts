import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Slice 13a — user/role administration (UR-072/073). Imports `AuthModule`
 * for `PasswordService` (Argon2id hashing, same instance the rest of auth
 * uses, not a duplicate). `BLIND_INDEX_KEY`/`FIELD_ENCRYPTION_SERVICE` need
 * no import here — `BlindIndexModule`/`CryptoModule` are `@Global()` and
 * already wired in via `AuthModule` elsewhere in the graph.
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController, RolesController],
  providers: [UsersService, RolesService],
})
export class UsersModule {}
