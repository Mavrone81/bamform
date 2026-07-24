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
