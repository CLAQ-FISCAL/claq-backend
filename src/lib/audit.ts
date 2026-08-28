import type { Prisma } from '@prisma/client';

export type AuditEntry = {
  tenantId: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  before?: unknown;
  after?: unknown;
};

export async function audit(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditEvent.create({
    data: {
      tenantId: entry.tenantId,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      requestId: entry.requestId,
      before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
