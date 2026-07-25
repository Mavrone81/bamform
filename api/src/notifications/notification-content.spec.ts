import { buildNotificationContent } from './notification-content';

describe('buildNotificationContent', () => {
  it('builds JOB_ASSIGNED content (UR-061)', () => {
    const content = buildNotificationContent('JOB_ASSIGNED', {
      jobNumber: 'PM-2026-000431',
      assetCode: 'AW03',
    });
    expect(content.subject).toContain('PM-2026-000431');
    expect(content.text).toContain('AW03');
  });

  it('builds RECORD_SUBMITTED content (UR-063)', () => {
    const content = buildNotificationContent('RECORD_SUBMITTED', {
      jobNumber: 'PM-2026-000431',
      assetCode: 'AW03',
    });
    expect(content.subject).toContain('verification');
    expect(content.text).toContain('PM-2026-000431');
  });

  it('builds VERIFICATION_ESCALATED content (UR-050)', () => {
    const content = buildNotificationContent('VERIFICATION_ESCALATED', {
      jobNumber: 'PM-2026-000431',
    });
    expect(content.subject).toContain('overdue');
    expect(content.text).toContain('escalation window');
  });

  it('omits the asset code segment when absent', () => {
    const content = buildNotificationContent('JOB_ASSIGNED', { jobNumber: 'PM-2026-000431' });
    expect(content.text).not.toContain('()');
  });
});
