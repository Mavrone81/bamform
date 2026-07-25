/** PR-009 — the single BullMQ queue name backing both notification dispatch (UR-061..065) and escalation timers (PR-077). One queue, two job names ('notification' | 'escalation') — see `notification-payloads.ts`. */
export const NOTIFICATION_QUEUE_NAME = 'bamform-notifications';

export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');
export const NOTIFICATION_TRANSPORT = Symbol('NOTIFICATION_TRANSPORT');
