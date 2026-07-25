/**
 * PR-116/117/119 — one BullMQ queue backs both the single-record PDF render
 * (`GET /records/{recordId}/pdf`, job name `'render'`) and the async export
 * job (`POST /records/export`, job name `'export'`) — mirrors
 * `notifications/notification.tokens.ts`'s "one queue, two job names"
 * convention (`'notification' | 'escalation'`) rather than standing up a
 * second Redis/BullMQ connection graph for what is, underneath, the SAME
 * Chromium-render concern (`render-semaphore.ts` caps BOTH job kinds'
 * combined Chromium usage — see that file's header).
 */
export const PDF_QUEUE_NAME = 'bamform-pdf';
export const PDF_QUEUE = Symbol('PDF_QUEUE');
export const PDF_QUEUE_EVENTS = Symbol('PDF_QUEUE_EVENTS');
