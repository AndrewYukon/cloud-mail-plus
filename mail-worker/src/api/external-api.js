import app from '../hono/hono';
import result from '../model/result';
import BizError from '../error/biz-error';
import settingService from '../service/setting-service';
import cfEmailService from '../service/cf-email-service';
import emailService from '../service/email-service';
import { normalizeMessageId } from '../service/email-event-service';
import { buildFallbackMeta, fallbackMetaKey, FALLBACK_META_TTL_SECONDS } from '../service/blocklist-fallback';
import attService from '../service/att-service';
import starService from '../service/star-service';
import emlService from '../service/eml-service';
import { Resend } from 'resend';
import { emailConst, settingConst, isDel } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import orm from '../entity/orm';
import email from '../entity/email';
import { att } from '../entity/att';
import { eq, inArray, and, gte } from 'drizzle-orm';

/**
 * External API for other apps to send email through Cloud-Mail.
 *
 * Auth: X-API-Key header (configured in Cloud-Mail admin settings).
 *
 * Endpoints:
 *   POST /external/send    — send an email from any configured domain
 *   GET  /external/status/:emailId — query email delivery status
 *   GET  /external/health  — health check (no auth required)
 */

// --- API Key middleware ---
async function verifyApiKey(c) {
	const apiKey = c.req.header('X-API-Key');
	if (!apiKey) {
		throw new BizError('Missing X-API-Key header', 401);
	}
	const { externalApiKey } = await settingService.query(c);
	if (!externalApiKey || apiKey !== externalApiKey) {
		throw new BizError('Invalid API key', 401);
	}
}

// --- Health check (no auth) ---
app.get('/external/health', (c) => {
	return c.json(result.ok({ status: 'ok', service: 'cloud-mail-external-api' }));
});

// --- Send email ---
app.post('/external/send', async (c) => {
	await verifyApiKey(c);

	const body = await c.req.json();
	const { from, to, subject, html, text, attachments, cc, bcc, replyTo, headers, skipSentSync } = body;

	// Validate required fields
	if (!from) throw new BizError('from is required');
	if (!to) throw new BizError('to is required');
	if (!subject) throw new BizError('subject is required');
	if (!html && !text) throw new BizError('html or text is required');

	// Validate from domain is configured
	const { resendTokens, domainList, emailProvider } = await settingService.query(c);
	const fromEmail = from.includes('<') ? from.match(/<(.+?)>/)?.[1] : from;
	if (!fromEmail) throw new BizError('Invalid from address');

	const fromDomain = emailUtils.getDomain(fromEmail);
	const domainAllowed = domainList.some(d => d.replace('@', '') === fromDomain);
	if (!domainAllowed) {
		throw new BizError(`Domain '${fromDomain}' is not configured. Available: ${domainList.join(', ')}`);
	}

	// Normalize recipients
	const toList = Array.isArray(to) ? to : [to];

	// Build send form
	const sendForm = {
		from: from,
		to: toList,
		subject: subject,
		html: html || undefined,
		text: text || undefined,
	};
	if (cc) sendForm.cc = Array.isArray(cc) ? cc : [cc];
	if (bcc) sendForm.bcc = Array.isArray(bcc) ? bcc : [bcc];
	if (replyTo) sendForm.replyTo = replyTo;
	if (headers) sendForm.headers = headers;
	if (attachments && Array.isArray(attachments) && attachments.length > 0) {
		sendForm.attachments = attachments;
	}
	// Skip Stalwart Sent-sync when the caller is the Mail Bridge SMTP relay
	// — the originating IMAP client (Outlook / iPhone Mail) already APPEND'd
	// the message to its Sent folder. Without this, Sent gets duplicates.
	if (skipSentSync) sendForm.skipSentSync = true;

	// Send: CF Email first, Resend fallback
	const useCf = emailProvider !== settingConst.emailProvider.RESEND_ONLY;
	const useResend = emailProvider !== settingConst.emailProvider.CF_ONLY;
	const resendToken = resendTokens[fromDomain];

	let cfSent = false;
	let cfMessageId = '';
	let resendResult = {};
	let sendError = null;

	if (useCf && toList.length <= 50) {
		try {
			const cfResult = await cfEmailService.send(c.env, sendForm);
			cfSent = true;

			// CF rewrites the Message-ID header, so the value returned here — NOT the
			// one we built into the raw MIME — is what the recipient sees and what
			// the delivery events reference. It is the only join key we get.
			const delivered = (cfResult?.results || []).filter(r => r.ok && r.messageId);
			cfMessageId = normalizeMessageId(delivered[0]?.messageId);
			if (delivered.length > 1) {
				console.warn(
					`[External API] ${delivered.length} recipients: only the first Message-ID ` +
					`(${cfMessageId}) is persisted, so events for recipients 2..N will log as unmatched`
				);
			}
		} catch (e) {
			console.error(`[External API] CF Email failed: ${e.message}`);
			sendError = e.message;
			if (!useResend) {
				throw new BizError(`CF Email failed: ${e.message}`);
			}
		}
	}

	if (!cfSent) {
		if (!resendToken) {
			throw new BizError(
				sendError
					? `CF Email failed (${sendError}) and no Resend token configured for ${fromDomain}`
					: `No Resend token configured for ${fromDomain}`
			);
		}
		const resend = new Resend(resendToken);
		resendResult = await resend.emails.send(sendForm);
		if (resendResult.error) {
			throw new BizError(resendResult.error.message);
		}
	}

	// Save to database
	const emailData = {
		sendEmail: fromEmail,
		name: from.includes('<') ? from.match(/^(.+?)\s*</)?.[1]?.trim() || '' : '',
		subject: subject,
		content: html || '',
		text: text || '',
		accountId: 0,
		userId: 0,
		// CF only ACCEPTED the message at this point — real delivery is reported
		// asynchronously by the `email.sending` events (see email-event-service.js),
		// which overwrite this with delivered/bounced/complained/...
		status: emailConst.status.SENT,
		type: emailConst.type.SEND,
		messageId: cfMessageId,
		resendEmailId: resendResult?.data?.id || null,
		recipient: JSON.stringify(toList.map(addr => ({ address: addr, name: '' }))),
	};

	const emailRow = await orm(c).insert(email).values(emailData).returning().get();

	// Only domains with a Resend token can be re-sent after a sender block-list
	// bounce; keep what D1 does not store so that re-send is the same message.
	// A failure here costs only the fallback, never the send that already happened.
	if (cfSent && resendToken) {
		try {
			await c.env.kv.put(
				fallbackMetaKey(emailRow.emailId),
				JSON.stringify(buildFallbackMeta(sendForm)),
				{ expirationTtl: FALLBACK_META_TTL_SECONDS },
			);
		} catch (e) {
			console.error(`[External API] could not store blocklist-fallback meta for emailId=${emailRow.emailId}: ${e.message}`);
		}
	}

	return c.json(result.ok({
		emailId: emailRow.emailId,
		status: 'sent',
		provider: cfSent ? 'cloudflare' : 'resend',
		messageId: cfMessageId || null,
		resendEmailId: resendResult?.data?.id || null,
	}));
});

// --- Query email status ---
app.get('/external/status/:emailId', async (c) => {
	await verifyApiKey(c);

	const emailId = Number(c.req.param('emailId'));
	if (!emailId || isNaN(emailId)) {
		throw new BizError('Invalid emailId');
	}

	const emailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();

	if (!emailRow) {
		throw new BizError('Email not found', 404);
	}

	const STATUS_MAP = {
		[emailConst.status.RECEIVE]: 'received',
		[emailConst.status.SENT]: 'sent',
		[emailConst.status.DELIVERED]: 'delivered',
		[emailConst.status.BOUNCED]: 'bounced',
		[emailConst.status.COMPLAINED]: 'complained',
		[emailConst.status.DELAYED]: 'delayed',
		[emailConst.status.SAVING]: 'saving',
		[emailConst.status.NOONE]: 'no_recipient',
		[emailConst.status.FAILED]: 'failed',
	};

	// `message` holds the JSON summary written by email-event-service (CF path) or
	// resend-service. Parse it so callers get structured bounce data instead of
	// having to string-match; keep the raw field for backward compatibility.
	let delivery = null;
	if (emailRow.message) {
		try {
			delivery = JSON.parse(emailRow.message);
		} catch {
			delivery = null;
		}
	}

	const bounced = emailRow.status === emailConst.status.BOUNCED;

	return c.json(result.ok({
		emailId: emailRow.emailId,
		status: STATUS_MAP[emailRow.status] || 'unknown',
		statusCode: emailRow.status,
		// Convenience flags — a caller deciding "stop emailing this address"
		// should gate on `bounced && hardBounce`, never on `bounced` alone and
		// never on `delayed` (Gmail throttling would suppress real users).
		bounced,
		hardBounce: bounced && delivery?.bounceType === 'hard',
		terminal: delivery?.terminal === true,
		from: emailRow.sendEmail,
		subject: emailRow.subject,
		recipient: JSON.parse(emailRow.recipient || '[]'),
		messageId: emailRow.messageId || null,
		delivery,
		resendEmailId: emailRow.resendEmailId,
		message: emailRow.message,
		createTime: emailRow.createTime,
	}));
});

// --- Export email as .eml (#323) ---
app.get('/external/email/:emailId/export', async (c) => {
	await verifyApiKey(c);

	const emailId = Number(c.req.param('emailId'));
	if (!emailId || isNaN(emailId)) {
		throw new BizError('Invalid emailId');
	}

	const eml = await emlService.buildEml(c, emailId);
	return new Response(eml, {
		headers: {
			'Content-Type': 'message/rfc822',
			'Content-Disposition': `attachment; filename="email-${emailId}.eml"`,
		},
	});
});

// --- List Message-IDs for a recipient (used by Mail Bridge reconciliation) ---
//   GET /external/email/list-message-ids?to=<email>&since=<seconds-ago>&limit=<n>
//   Returns: { items: [{emailId, messageId, createTime}, ...], truncated: bool }
app.get('/external/email/list-message-ids', async (c) => {
	await verifyApiKey(c);

	const to = (c.req.query('to') || '').trim().toLowerCase();
	if (!to) throw new BizError('to query param required');

	const since = Math.max(0, Number(c.req.query('since')) || 0);  // seconds; 0 = no filter
	const limit = Math.min(5000, Math.max(1, Number(c.req.query('limit')) || 2000));

	const conds = [eq(email.toEmail, to), eq(email.isDel, isDel.NORMAL)];
	if (since > 0) {
		const cutoff = new Date(Date.now() - since * 1000).toISOString().replace('T', ' ').slice(0, 19);
		conds.push(gte(email.createTime, cutoff));
	}

	const rows = await orm(c).select({
		emailId: email.emailId,
		messageId: email.messageId,
		createTime: email.createTime,
	}).from(email).where(and(...conds)).limit(limit + 1).all();

	const truncated = rows.length > limit;
	return c.json(result.ok({
		to,
		items: rows.slice(0, limit).map(r => ({
			emailId: r.emailId,
			messageId: (r.messageId || '').replace(/^<|>$/g, ''),
			createTime: r.createTime,
		})),
		count: Math.min(rows.length, limit),
		truncated,
	}));
});

// --- Delete email (soft delete) ---
app.delete('/external/email/:emailId', async (c) => {
	await verifyApiKey(c);

	const emailId = Number(c.req.param('emailId'));
	if (!emailId || isNaN(emailId)) {
		throw new BizError('Invalid emailId');
	}

	const emailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
	if (!emailRow) {
		throw new BizError('Email not found', 404);
	}

	await orm(c).update(email).set({ isDel: isDel.DELETE }).where(eq(email.emailId, emailId)).run();

	return c.json(result.ok({ emailId, deleted: true }));
});

// --- Permanently delete email + R2 attachments (#293 + #318) ---
app.delete('/external/email/:emailId/permanent', async (c) => {
	await verifyApiKey(c);

	const emailId = Number(c.req.param('emailId'));
	if (!emailId || isNaN(emailId)) {
		throw new BizError('Invalid emailId');
	}

	const emailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
	if (!emailRow) {
		throw new BizError('Email not found', 404);
	}

	// Delete attachments from R2/S3/KV + DB
	await attService.removeByEmailIds(c, [emailId]);
	// Delete stars
	await starService.removeByEmailIds(c, [emailId]);
	// Delete email record
	await orm(c).delete(email).where(eq(email.emailId, emailId)).run();

	return c.json(result.ok({ emailId, permanentlyDeleted: true }));
});

// --- Permanently delete by RFC 5322 Message-ID (used by Stalwart webhook sync) ---
//   Optional query: ?to=<recipient-email>  — restricts deletion to the row whose to_email matches
app.delete('/external/email/by-message-id/:messageId/permanent', async (c) => {
	await verifyApiKey(c);

	const rawMid = c.req.param('messageId');
	const messageId = decodeURIComponent(rawMid || '').trim();
	if (!messageId) throw new BizError('Invalid messageId');

	const toFilter = (c.req.query('to') || '').trim().toLowerCase();

	// Match by exact Message-ID — store may have it with/without angle brackets
	const candidates = [messageId, `<${messageId}>`, messageId.replace(/^<|>$/g, '')];
	// RECEIVE only. Outbound rows now carry a Message-ID too, and a round-trip
	// (our domain → our domain) puts the SAME id on both rows — without this
	// guard Mail Bridge's delete-sync would take out the sent copy as well.
	let rows = await orm(c).select().from(email).where(and(
		inArray(email.messageId, candidates),
		eq(email.type, emailConst.type.RECEIVE),
	)).all();

	// Scope to the specific recipient when provided (one Gmail can land in many mailboxes)
	if (toFilter && rows.length > 0) {
		rows = rows.filter(r => (r.toEmail || '').toLowerCase() === toFilter);
	}

	if (rows.length === 0) {
		return c.json(result.ok({ messageId, to: toFilter || null, matched: 0, permanentlyDeleted: 0 }));
	}

	const ids = rows.map(r => r.emailId);
	await attService.removeByEmailIds(c, ids);
	await starService.removeByEmailIds(c, ids);
	await orm(c).delete(email).where(inArray(email.emailId, ids)).run();

	return c.json(result.ok({ messageId, to: toFilter || null, matched: ids.length, permanentlyDeleted: ids.length, emailIds: ids }));
});

// --- Batch delete emails ---
app.post('/external/email/batch-delete', async (c) => {
	await verifyApiKey(c);

	const body = await c.req.json();
	const { emailIds, permanent } = body;

	if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
		throw new BizError('emailIds array is required');
	}
	if (emailIds.length > 100) {
		throw new BizError('Maximum 100 emails per batch');
	}

	const ids = emailIds.map(Number).filter(id => !isNaN(id));

	if (permanent) {
		await attService.removeByEmailIds(c, ids);
		await starService.removeByEmailIds(c, ids);
		await orm(c).delete(email).where(inArray(email.emailId, ids)).run();
	} else {
		await orm(c).update(email).set({ isDel: isDel.DELETE }).where(inArray(email.emailId, ids)).run();
	}

	return c.json(result.ok({ deleted: ids.length, permanent: !!permanent }));
});
