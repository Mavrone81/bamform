import { redactSecrets, redactString } from './redact';
import { RedactingLogger } from './redacting-logger';

const KNOWN_PASSWORD = 'CorrectHorseBattery1!';

describe('S-15 (threat I-3): secrets never appear in log output', () => {
  describe('redactSecrets — the pure function', () => {
    it('redacts a top-level password field wholesale', () => {
      const result = redactSecrets({ email: 'a@bevorasg.com', password: KNOWN_PASSWORD });
      expect(JSON.stringify(result)).not.toContain(KNOWN_PASSWORD);
      expect(result).toMatchObject({ email: 'a@bevorasg.com', password: '[REDACTED]' });
    });

    it('redacts secret-like keys nested arbitrarily deep', () => {
      const result = redactSecrets({
        request: { body: { currentPassword: KNOWN_PASSWORD, newPassword: 'NextOne2!' } },
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain(KNOWN_PASSWORD);
      expect(json).not.toContain('NextOne2!');
    });

    it('redacts secret-like keys inside arrays of objects', () => {
      const result = redactSecrets([{ token: 'abc.def.ghi' }, { note: 'fine' }]);
      const json = JSON.stringify(result);
      expect(json).not.toContain('abc.def.ghi');
      expect(json).toContain('fine');
    });

    it('redacts an inline "password=" fragment inside a free-text log line', () => {
      const result = redactString(`login attempt failed: password=${KNOWN_PASSWORD}`);
      expect(result).not.toContain(KNOWN_PASSWORD);
      expect(result).toContain('login attempt failed');
    });

    it('redacts a JSON-shaped "password": "..." fragment inside a free-text log line', () => {
      const result = redactString(
        `payload received {"email":"a@b.com","password":"${KNOWN_PASSWORD}"}`,
      );
      expect(result).not.toContain(KNOWN_PASSWORD);
      expect(result).toContain('"email":"a@b.com"');
    });

    it('leaves non-secret fields untouched', () => {
      const result = redactSecrets({ userId: '123', email: 'a@bevorasg.com', roles: ['ADMIN'] });
      expect(result).toEqual({ userId: '123', email: 'a@bevorasg.com', roles: ['ADMIN'] });
    });

    it('does not stack-overflow on a circular structure', () => {
      const obj: Record<string, unknown> = { password: KNOWN_PASSWORD };
      obj.self = obj;
      expect(() => redactSecrets(obj)).not.toThrow();
      expect(JSON.stringify(redactSecrets(obj))).not.toContain(KNOWN_PASSWORD);
    });

    it('redacts an Error message that embeds a secret', () => {
      const err = new Error(`auth failed for token=Bearer.abc.def`);
      const result = redactSecrets(err) as { message: string };
      expect(result.message).not.toContain('Bearer.abc.def');
    });

    // ------------------------------------------------- S-15 / slice 13-MFA
    // Brief §8: "Never log a secret, a recovery code, a TOTP code, or a
    // password." Every field name the MFA surface can put in front of a
    // logger, asserted individually so a future rename of the redaction
    // pattern cannot silently uncover one of them.
    describe('MFA credential material (slice 13-MFA §8)', () => {
      const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      const RECOVERY_CODE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567';
      const CHALLENGE = 'eyJhbGciOiJFZERTQSJ9.challenge.payload';
      const OTPAUTH = `otpauth://totp/BamForm:a@b.com?secret=${TOTP_SECRET}&issuer=BamForm`;

      it.each([
        ['mfaSecretCt', TOTP_SECRET],
        ['mfaSecret', TOTP_SECRET],
        ['secret', TOTP_SECRET],
        ['challengeToken', CHALLENGE],
        ['otpauthUri', OTPAUTH],
        ['recoveryCode', RECOVERY_CODE],
        ['recoveryCodes', RECOVERY_CODE],
        ['backupCodes', RECOVERY_CODE],
        ['totpSecret', TOTP_SECRET],
        // M-5: the two DTO fields that carry a LIVE credential. They were
        // named `code`, which cannot be added to the redaction pattern
        // without swallowing roleCode/assetCode/areaCode; renaming them is
        // what makes brief §8 true by construction.
        ['totpCode', '123456'],
        ['currentPassword', KNOWN_PASSWORD],
        ['newPassword', KNOWN_PASSWORD],
      ])('redacts the `%s` field', (key, value) => {
        const json = JSON.stringify(redactSecrets({ userId: 'u1', [key]: value }));
        expect(json).not.toContain(value);
        expect(json).toContain('[REDACTED]');
        // The surrounding, non-secret context survives.
        expect(json).toContain('u1');
      });

      it('redacts an otpauth URI even when it is the whole log line (the secret is in the query string)', () => {
        expect(redactString(`enrolment uri: otpauth=${OTPAUTH}`)).not.toContain(TOTP_SECRET);
      });

      it('redacts an array of recovery codes wholesale, not element by element', () => {
        const json = JSON.stringify(
          redactSecrets({ recoveryCodes: [RECOVERY_CODE, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ'] }),
        );
        expect(json).not.toContain(RECOVERY_CODE);
        expect(json).not.toContain('ZZZZ-ZZZZ');
      });

      it('does NOT redact the non-secret `code` family (roleCode/assetCode/codeBidx stay readable)', () => {
        expect(
          redactSecrets({ roleCode: 'ADMIN', assetCode: 'PMP-001', codeBidx: 'deadbeef' }),
        ).toEqual({ roleCode: 'ADMIN', assetCode: 'PMP-001', codeBidx: 'deadbeef' });
      });

      // M-5 — the whole point of the rename: an /auth/mfa request body, as a
      // logger would see it, leaks nothing. Before the rename the credential
      // field was called `code` and came through in the clear.
      it('redacts a whole /auth/mfa/verify request body', () => {
        const json = JSON.stringify(
          redactSecrets({ challengeToken: CHALLENGE, totpCode: '123456' }),
        );
        expect(json).not.toContain(CHALLENGE);
        expect(json).not.toContain('123456');
      });

      it('redacts a whole /auth/mfa/recovery request body', () => {
        const json = JSON.stringify(
          redactSecrets({ challengeToken: CHALLENGE, recoveryCode: RECOVERY_CODE }),
        );
        expect(json).not.toContain(CHALLENGE);
        expect(json).not.toContain(RECOVERY_CODE);
      });

      it('redacts a whole /auth/mfa/enrol/confirm request body, access-token flavour (no sibling token to key off)', () => {
        // Deliberately no `challengeToken` sibling: the redaction must come
        // from the field NAME, not from a heuristic about its neighbours.
        expect(JSON.stringify(redactSecrets({ totpCode: '654321' }))).not.toContain('654321');
      });
    });
  });

  describe('RedactingLogger — the app-wide Nest logger wired in main.ts', () => {
    let writes: string[];
    let stdoutSpy: jest.SpyInstance;
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      writes = [];
      stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('never writes a raw password to stdout when logging a structured object', () => {
      const logger = new RedactingLogger('test');
      logger.log({ msg: 'login attempt', email: 's15@bevorasg.com', password: KNOWN_PASSWORD });

      const emitted = writes.join('\n');
      expect(emitted).not.toContain(KNOWN_PASSWORD);
      expect(emitted).toContain('[REDACTED]');
    });

    it('never writes a raw password to stderr on Logger.error either', () => {
      const logger = new RedactingLogger('test');
      logger.error(`login failed: password=${KNOWN_PASSWORD}`, 'AuthController');

      const emitted = writes.join('\n');
      expect(emitted).not.toContain(KNOWN_PASSWORD);
    });

    it('still logs the non-secret parts (redaction is not a black hole)', () => {
      const logger = new RedactingLogger('test');
      logger.log({ msg: 'login attempt', email: 's15@bevorasg.com', password: KNOWN_PASSWORD });

      const emitted = writes.join('\n');
      expect(emitted).toContain('s15@bevorasg.com');
      expect(emitted).toContain('login attempt');
    });
  });
});
