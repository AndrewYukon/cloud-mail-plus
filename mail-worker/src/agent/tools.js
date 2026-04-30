import { tool } from 'ai';
import { z } from 'zod';
import { eq, and, like, gte, lte, desc } from 'drizzle-orm';
import emailService from '../service/email-service';
import cfEmailService from '../service/cf-email-service';
import attService from '../service/att-service';
import orm from '../entity/orm';
import { email as emailEntity } from '../entity/email';
import { isDel, emailConst } from '../const/entity-const';

// Tool factory — binds env + userId so each user only sees their own data.
// `c` mirrors the Hono context shape that the rest of the codebase uses: `{ env }`.
export function buildTools({ env, userId, userEmail }) {
  const c = { env };

  return {
    listEmails: tool({
      description: 'List emails in a mailbox (inbox / sent / drafts / trash) for the current user.',
      inputSchema: z.object({
        box: z.enum(['inbox', 'sent', 'drafts', 'trash']).describe('Mailbox to list'),
        page: z.number().int().min(1).default(1),
        size: z.number().int().min(1).max(50).default(20),
        unreadOnly: z.boolean().default(false),
      }),
      execute: async ({ box, page, size, unreadOnly }) => {
        const conds = [eq(emailEntity.userId, userId)];
        if (box === 'trash') conds.push(eq(emailEntity.isDel, isDel.DELETE));
        else conds.push(eq(emailEntity.isDel, isDel.NORMAL));

        if (box === 'inbox')      conds.push(eq(emailEntity.type, emailConst.type.RECEIVE));
        else if (box === 'sent')  conds.push(eq(emailEntity.type, emailConst.type.SEND), eq(emailEntity.status, emailConst.status.SENT));
        else if (box === 'drafts') conds.push(eq(emailEntity.type, emailConst.type.SEND), eq(emailEntity.status, emailConst.status.SAVING));

        if (unreadOnly) conds.push(eq(emailEntity.unread, emailConst.unread.UNREAD));

        const rows = await orm(c).select().from(emailEntity)
          .where(and(...conds))
          .orderBy(desc(emailEntity.emailId))
          .limit(size).offset((page - 1) * size).all();

        return rows.map(e => ({
          emailId: e.emailId,
          from: e.sendEmail || '',
          to: e.toEmail || '',
          subject: e.subject || '',
          preview: (e.text || '').slice(0, 120),
          unread: !!e.unread,
          createTime: e.createTime,
        }));
      },
    }),

    searchEmails: tool({
      description: 'Search the current user\'s emails by subject substring, sender, and date range.',
      inputSchema: z.object({
        query: z.string().min(1).max(200).optional(),
        from: z.string().email().optional(),
        dateFrom: z.string().optional().describe('ISO date YYYY-MM-DD'),
        dateTo: z.string().optional().describe('ISO date YYYY-MM-DD'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ query, from, dateFrom, dateTo, limit }) => {
        const conds = [eq(emailEntity.userId, userId), eq(emailEntity.isDel, isDel.NORMAL)];
        if (query) conds.push(like(emailEntity.subject, `%${query}%`));
        if (from) conds.push(eq(emailEntity.sendEmail, from));
        if (dateFrom) conds.push(gte(emailEntity.createTime, dateFrom));
        if (dateTo)   conds.push(lte(emailEntity.createTime, dateTo + ' 23:59:59'));
        const rows = await orm(c).select().from(emailEntity).where(and(...conds))
          .orderBy(desc(emailEntity.emailId)).limit(limit).all();
        return rows.map(e => ({ emailId: e.emailId, from: e.sendEmail, subject: e.subject, createTime: e.createTime }));
      },
    }),

    getEmail: tool({
      description: 'Fetch the full body and attachment list for a specific email owned by the current user.',
      inputSchema: z.object({ emailId: z.number().int().positive() }),
      execute: async ({ emailId }) => {
        const detail = await emailService.detail(c, emailId, userId);
        if (!detail) return { error: 'Not found or not accessible' };
        const atts = await attService.list(c, { emailId }, userId);
        return {
          emailId: detail.emailId,
          from: detail.sendEmail,
          to: detail.toEmail,
          subject: detail.subject,
          html: (detail.content || '').slice(0, 8000),
          text: (detail.text || '').slice(0, 8000),
          attachments: (atts || []).map((a, i) => ({ index: i, name: a.name, size: a.size, mime: a.mime })),
          createTime: detail.createTime,
        };
      },
    }),

    getAttachmentText: tool({
      description: 'Read a text-like attachment (text/*, application/json, application/xml, text/csv). Returns truncated text. Refuses binaries.',
      inputSchema: z.object({ emailId: z.number().int().positive(), attIndex: z.number().int().min(0) }),
      execute: async ({ emailId, attIndex }) => {
        const a = await attService.getOne(c, emailId, attIndex, userId);
        if (!a) return { error: 'Attachment not found' };
        if (!/^text\/|application\/(json|xml|csv)/.test(a.mime || '')) {
          return { error: `Refused: MIME ${a.mime} is not text-like` };
        }
        const buf = await attService.fetchBytes(c, a);
        return { name: a.name, mime: a.mime, content: new TextDecoder().decode(buf).slice(0, 10000) };
      },
    }),

    summarizeEmail: tool({
      description: 'Summarize a specific email in 3-5 bullet points and surface action items.',
      inputSchema: z.object({ emailId: z.number().int().positive() }),
      execute: async ({ emailId }) => {
        const detail = await emailService.detail(c, emailId, userId);
        if (!detail) return { error: 'Not found' };
        const body = (detail.text || detail.content || '').slice(0, 6000);
        const r = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [
            { role: 'system', content: 'Summarize the email in 3-5 markdown bullets, then list action items under "Actions:".' },
            { role: 'user', content: `Subject: ${detail.subject}\nFrom: ${detail.sendEmail}\n\n${body}` },
          ],
        });
        return { emailId, summary: r.response || r.result?.response || JSON.stringify(r) };
      },
    }),

    draftReply: tool({
      description: 'Generate and persist a draft reply to a specific email. Returns draftId. Does NOT send.',
      inputSchema: z.object({
        emailId: z.number().int().positive(),
        instructions: z.string().min(1).describe('What the reply should say'),
        tone: z.enum(['neutral', 'friendly', 'formal', 'firm']).default('neutral'),
      }),
      execute: async ({ emailId, instructions, tone }) => {
        const original = await emailService.detail(c, emailId, userId);
        if (!original) return { error: 'Original email not found' };
        const r = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [
            { role: 'system', content: `Write a ${tone} email reply in clean HTML (no <html>/<body>, no markdown). Match the sender's language. Sign as ${userEmail.split('@')[0]}.` },
            { role: 'user', content: `Reply to:\nFrom: ${original.sendEmail}\nSubject: ${original.subject}\n\n${(original.text || original.content || '').slice(0, 4000)}\n\nInstructions: ${instructions}` },
          ],
        });
        const html = r.response || r.result?.response || '';
        const draftId = await emailService.saveDraft(c, {
          userId,
          accountId: original.accountId,
          toEmail: original.sendEmail,
          subject: original.subject?.startsWith('Re: ') ? original.subject : `Re: ${original.subject || ''}`,
          inReplyTo: original.messageId || '',
          relation: `${original.relation || ''} ${original.messageId || ''}`.trim(),
          content: html,
          text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          aiMetadata: JSON.stringify({ source: 'tool', sourceEmailId: emailId, model: '@cf/moonshotai/kimi-k2.5' }),
        });
        return { draftId, preview: html.slice(0, 400), to: original.sendEmail };
      },
    }),

    draftNew: tool({
      description: 'Generate and persist a new draft (not a reply). Returns draftId. Does NOT send.',
      inputSchema: z.object({
        to: z.string().email(),
        subject: z.string().min(1).max(200),
        instructions: z.string().min(1),
      }),
      execute: async ({ to, subject, instructions }) => {
        const r = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [
            { role: 'system', content: `Write an email body in clean HTML. Sign as ${userEmail.split('@')[0]}. No markdown.` },
            { role: 'user', content: `To: ${to}\nSubject: ${subject}\nInstructions: ${instructions}` },
          ],
        });
        const html = r.response || r.result?.response || '';
        const draftId = await emailService.saveDraft(c, {
          userId, accountId: 0, toEmail: to, subject, content: html,
          text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          aiMetadata: JSON.stringify({ source: 'tool-new', model: '@cf/moonshotai/kimi-k2.5' }),
        });
        return { draftId, preview: html.slice(0, 400) };
      },
    }),

    // === confirmation-required tools: NO execute, client must call addToolResult ===
    sendDraft: tool({
      description: 'Send a previously-prepared draft. REQUIRES USER CONFIRMATION in the UI before executing.',
      inputSchema: z.object({ draftId: z.number().int().positive() }),
    }),

    deleteEmail: tool({
      description: 'Soft-delete (move to trash) or permanently delete an email. REQUIRES USER CONFIRMATION.',
      inputSchema: z.object({
        emailId: z.number().int().positive(),
        permanent: z.boolean().default(false),
      }),
    }),
  };
}

// Server-side handler for confirmed tools (called from /agent/confirm after client confirms).
export async function executeConfirmedTool({ env, userId, userEmail, name, args }) {
  const c = { env };
  if (name === 'sendDraft') {
    const draft = await emailService.detail(c, args.draftId, userId);
    if (!draft) return { error: 'Draft not found' };
    const r = await cfEmailService.send(env, {
      from: { email: userEmail, name: userEmail.split('@')[0] },
      to: draft.toEmail,
      subject: draft.subject,
      html: draft.content,
      text: draft.text,
      headers: draft.inReplyTo ? { 'In-Reply-To': draft.inReplyTo, References: draft.relation } : {},
    });
    await emailService.markSent(c, args.draftId, userId, r);
    return { sent: true, messageId: r?.messageId || '' };
  }
  if (name === 'deleteEmail') {
    if (args.permanent) await emailService.permanentDelete(c, args.emailId, userId);
    else await emailService.softDelete(c, args.emailId, userId);
    return { deleted: true, permanent: args.permanent };
  }
  return { error: `Unknown confirmed tool: ${name}` };
}
