import app from '../hono/hono';
import result from '../model/result';
import BizError from '../error/biz-error';
import settingService from '../service/setting-service';
import cfEmailService from '../service/cf-email-service';
import emailService from '../service/email-service';
import attService from '../service/att-service';
import starService from '../service/star-service';
import { Resend } from 'resend';
import { emailConst, settingConst, isDel } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import orm from '../entity/orm';
import email from '../entity/email';
import { eq, inArray } from 'drizzle-orm';

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
	const { from, to, subject, html, text, attachments, cc, bcc, replyTo, headers } = body;

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

	// Send: CF Email first, Resend fallback
	const useCf = emailProvider !== settingConst.emailProvider.RESEND_ONLY;
	const useResend = emailProvider !== settingConst.emailProvider.CF_ONLY;
	const resendToken = resendTokens[fromDomain];

	let cfSent = false;
	let resendResult = {};
	let sendError = null;

	if (useCf && toList.length <= 50) {
		try {
			await cfEmailService.send(c.env, sendForm);
			cfSent = true;
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
		status: cfSent ? emailConst.status.DELIVERED : emailConst.status.SENT,
		type: emailConst.type.SEND,
		resendEmailId: resendResult?.data?.id || null,
		recipient: JSON.stringify(toList.map(addr => ({ address: addr, name: '' }))),
	};

	const emailRow = await orm(c).insert(email).values(emailData).returning().get();

	return c.json(result.ok({
		emailId: emailRow.emailId,
		status: cfSent ? 'delivered' : 'sent',
		provider: cfSent ? 'cloudflare' : 'resend',
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

	return c.json(result.ok({
		emailId: emailRow.emailId,
		status: STATUS_MAP[emailRow.status] || 'unknown',
		statusCode: emailRow.status,
		from: emailRow.sendEmail,
		subject: emailRow.subject,
		recipient: JSON.parse(emailRow.recipient || '[]'),
		resendEmailId: emailRow.resendEmailId,
		message: emailRow.message,
		createTime: emailRow.createTime,
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
