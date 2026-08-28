import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { SQSHandler } from 'aws-lambda';
import { db } from '../lib/db';
import { withTenant } from '../lib/tenant';
import { buildWhatsAppText, sendWhatsAppMessage, type WhatsAppResult } from '../lib/whatsapp';

const ses = new SESv2Client({});
const TRANSIENT = /(Throttl|TooManyRequests|Timeout|InternalError|ServiceUnavailable|ConnectionError|ECONN|socket hang up)/i;

type QueueMessage = { attemptId: string; tenantId: string };

type LoadedNotification = {
  attemptId: string;
  tenantName: string;
  title: string;
  companyLegalName: string;
  dueAt: Date;
  status: string;
  leadDay: number;
  emails: string[];
  phones: string[];
  channels: string[];
  demo: boolean;
};

function describeTiming(leadDay: number, status: string): string {
  if (leadDay === -1 || status === 'OVERDUE') return 'esta obrigação está VENCIDA. Regularize o mais breve possível para evitar multas e juros.';
  if (leadDay === 0) return 'esta obrigação vence HOJE.';
  return `esta obrigação vence em ${leadDay} dia(s).`;
}

export function buildEmail(n: LoadedNotification, fromAddress: string): SendEmailCommand {
  const due = n.dueAt.toISOString().slice(0, 10);
  const subject = n.leadDay === -1 || n.status === 'OVERDUE' ? `[CLAQ] VENCIDA: ${n.title} — ${n.companyLegalName}` : `[CLAQ] ${n.title} vence em ${due}`;
  const text = [
    `${n.companyLegalName}`,
    '',
    `${n.title}`,
    `Prazo: ${due}`,
    '',
    describeTiming(n.leadDay, n.status),
    '',
    n.demo ? 'AMBIENTE DE DEMONSTRAÇÃO — dados sintéticos, sem valor oficial.' : 'Mensagem automática do CLAQ Fiscal Alert. Não responde a obrigações junto da AT.',
  ].join('\n');
  return new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: n.emails.slice(0, 10) },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' } },
      },
    },
  });
}

export const handler: SQSHandler = async (event) => {
  const fromAddress = process.env.ALERTS_FROM_EMAIL;
  if (!fromAddress) throw new Error('ALERTS_FROM_EMAIL is not configured');
  const demo = process.env.APP_ENV === 'demo';
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as QueueMessage;
      const loaded = await withTenant(db, message.tenantId, async (tx) => {
        const attempt = await tx.notificationAttempt.findUnique({ where: { id: message.attemptId } });
        if (!attempt || attempt.status !== 'PENDING') return null;
        const obligation = await tx.obligation.findUnique({ where: { id: attempt.obligationId }, include: { company: { select: { legalName: true } } } });
        if (!obligation) {
          await tx.notificationAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', detail: 'Obligation no longer exists.' } });
          return null;
        }
        const tenant = await tx.tenant.findUnique({ where: { id: attempt.tenantId }, select: { name: true } });
        const settings = await tx.notificationSetting.findMany({ where: { tenantId: attempt.tenantId, enabled: true } });
        const enabledChannels = settings.map((s) => s.channel);
        const members = await tx.membership.findMany({
          where: { tenantId: attempt.tenantId, role: { in: ['OWNER', 'ADMIN', 'ACCOUNTANT'] } },
          include: { user: { select: { email: true, phone: true } } },
        }) as { user: { email: string; phone: string | null } }[];
        return {
          attemptId: attempt.id,
          tenantName: tenant?.name ?? 'CLAQ',
          title: obligation.title,
          companyLegalName: obligation.company.legalName,
          dueAt: obligation.dueAt,
          status: obligation.status,
          leadDay: attempt.leadDay,
          emails: [...new Set(members.map((m) => m.user.email))],
          phones: [...new Set(members.map((m) => m.user.phone).filter((p): p is string => p !== null))],
          channels: enabledChannels,
          demo,
        } satisfies LoadedNotification;
      });
      if (!loaded) continue;

      const sentChannels: string[] = [];
      const failedChannels: string[] = [];

      if (loaded.channels.includes('EMAIL') && loaded.emails.length > 0) {
        try {
          await ses.send(buildEmail(loaded, fromAddress));
          sentChannels.push('EMAIL');
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if (TRANSIENT.test(detail)) throw err;
          failedChannels.push(`EMAIL:${detail.slice(0, 100)}`);
        }
      }

      if (loaded.channels.includes('WHATSAPP') && loaded.phones.length > 0) {
        const text = buildWhatsAppText(loaded);
        const results: WhatsAppResult[] = [];
        for (const phone of loaded.phones.slice(0, 5)) {
          results.push(await sendWhatsAppMessage(phone, text));
        }
        const whatsappOk = results.filter((r) => r.success);
        const whatsappFail = results.filter((r) => !r.success);
        if (whatsappOk.length > 0) sentChannels.push(`WHATSAPP:${whatsappOk.length}`);
        if (whatsappFail.length > 0) failedChannels.push(`WHATSAPP:${whatsappFail[0]?.error?.slice(0, 100)}`);
      }

      if (loaded.channels.includes('IN_APP')) {
        sentChannels.push('IN_APP:queued');
      }

      if (sentChannels.length === 0 && failedChannels.length > 0) {
        const detail = `All channels failed: ${failedChannels.join('; ')}`;
        if (failedChannels.some((f) => f.startsWith('EMAIL:') && TRANSIENT.test(f))) throw new Error(detail);
        await withTenant(db, message.tenantId, (tx) => tx.notificationAttempt.update({ where: { id: loaded.attemptId }, data: { status: 'FAILED', detail } }));
        continue;
      }

      await withTenant(db, message.tenantId, (tx) =>
        tx.notificationAttempt.update({
          where: { id: loaded.attemptId },
          data: { status: 'SENT', detail: `Sent via ${sentChannels.join(', ')}${failedChannels.length > 0 ? ` (failed: ${failedChannels.join(', ')})` : ''}` },
        }),
      );
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', worker: 'notifier', messageId: record.messageId, message: err instanceof Error ? err.message : String(err) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
