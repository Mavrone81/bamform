/** Actor + request-correlation metadata every mutation service passes through to `AuditEventService`. */
export interface ActorMeta {
  actorId: string;
  sourceIp?: string;
  requestId?: string;
}
