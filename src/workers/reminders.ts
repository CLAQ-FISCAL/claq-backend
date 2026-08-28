import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EventBridgeHandler } from 'aws-lambda';
import { syncObligationStatuses } from '../domain/obligations';
import { planReminders, utcDay, type ReminderCandidate } from '../domain/reminders';
import { db } from '../lib/db';
import { withTenant } from '../lib/tenant';

const sqs = new SQSClient({});

const LOOKAHEAD_DAYS = 31;
const LOOKBEHIND_DAYS = 60;

export type ReminderRunResult = { tenants: number; statusChanges: number; planned: number; enqueued: number };

/**
 * Daily planner (EventBridge cron). Runs per tenant inside the RLS context:
 * syncs DUE/OVERDUE statuses, plans EMAIL reminders for configured lead days,
 * records deduplicated NotificationAttempts and enqueues one message per new attempt.
 */
export const handler: EventBridgeHandler<'Scheduled Event', unknown, ReminderRunResult> = async () => {
  const queueUrl = process.env.NOTIFICATION_QUEUE;
  if (!queueUrl) throw new Error('NOTIFICATION_QUEUE is not configured');
  const today = utcDay(new Date());
  const windowStart = new Date(today.getTime() - LOOKBEHIND_DAYS * 86400000);
  const windowEnd = new Date(today.getTime() + (LOOKAHEAD_DAYS + 1) * 86400000);

  const tenants = await db.tenant.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });

  let statusChanges = 0;
  let planned = 0;
  let enqueued = 0;

  for (const tenant of tenants) {
    const queuedAttemptIds = await withTenant(db, tenant.id, async (tx) => {
      statusChanges += await syncObligationStatuses(tx, today);
      const setting = await tx.notificationSetting.findUnique({
        where: { tenantId_channel: { tenantId: tenant.id, channel: 'EMAIL' } },
      });
      if (!setting || !setting.enabled) return [] as string[];

      const obligations = await tx.obligation.findMany({
        where: { status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] }, dueAt: { gte: windowStart, lte: windowEnd } },
        include: { company: { select: { legalName: true } } },
      });
      const candidates: ReminderCandidate[] = obligations.map((o) => ({
        id: o.id,
        tenantId: o.tenantId,
        title: o.title,
        dueAt: o.dueAt,
        status: o.status as ReminderCandidate['status'],
        companyLegalName: o.company.legalName,
      }));
      const plans = planReminders(candidates, new Map([[tenant.id, setting.leadDays]]), today);

      const queued: string[] = [];
      for (const plan of plans) {
        try {
          const attempt = await tx.notificationAttempt.create({
            data: { tenantId: tenant.id, obligationId: plan.obligationId, channel: 'EMAIL', leadDay: plan.leadDay, status: 'PENDING' },
          });
          queued.push(attempt.id);
        } catch {
          // Unique (obligationId, channel, leadDay) already notified — skip silently.
        }
      }
      return queued;
    });

    planned += queuedAttemptIds.length;
    for (const attemptId of queuedAttemptIds) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ attemptId, tenantId: tenant.id }) }));
      enqueued += 1;
    }
  }

  console.log(JSON.stringify({ level: 'info', worker: 'reminders', tenants: tenants.length, statusChanges, planned, enqueued }));
  return { tenants: tenants.length, statusChanges, planned, enqueued };
};
