/**
 * Sender-blocklist fallback: when a recipient's provider rejects our message
 * because the SENDING IP is on its block list, re-send that one message to that
 * one recipient through Resend.
 *
 * Why: CF Email Sending delivers from shared egress IPs. On 2026-11-11 Microsoft
 * listed one of those IPs (S3150) and every hotmail/outlook send hard-bounced, for
 * every tenant. That is not a bad mailbox, and re-sending through CF would leave
 * from the same IP and bounce again, so the only useful retry is another egress.
 *
 * Gate: a domain takes part only if `setting.resend_tokens` holds a token for it
 * (opt-in per domain). This is independent of
 * `email_provider`, which stays `cf-only`: the synchronous Resend fallback in the
 * send path remains off.
 *
 * Why the bounce path needs send-time metadata: the event arrives asynchronously,
 * and D1 keeps subject/html/text/sender but not attachments, reply-to or custom
 * headers. The send path stores those in KV (`buildFallbackMeta`); a message with
 * attachments is never re-sent, because we could not send the same message.
 *
 * Exactly-once: every re-send carries a Resend idempotency key derived from the
 * emailId (Resend keeps keys 24h and replays the first successful response).
 * That, not a D1 lock, is what makes queue redelivery, concurrent consumers and
 * a crash between "sent" and "recorded" safe: the retry is a replay, never a
 * second email.
 *
 * Known residual (accepted): if all queue attempts hit an ambiguous Resend error,
 * the last one records the bounce with `fallback.retriesExhausted` even though
 * Resend may have delivered; if D1 fails on the last attempt after Resend
 * accepted, the event lands in the consumer-less DLQ and the row stays `sent`.
 *
 * Pure decision logic lives here; `email-event-service` supplies the I/O.
 */

// Microsoft: "...part of their network is on our block list (S3150)".
const MS_CODE = /\bS3\d{3}\b/;
// A listing, or a named public RBL. "listed in" alone is too loose ("User not
// listed in public directory" is a dead mailbox), so it must name a list host.
const LISTED = /block ?list|blocklisted|blacklist(?:ed)?|blocked using|listed (?:at|on|in) \S*(?:spamhaus|spamcop|barracuda|sorbs|\.(?:org|net|com))|\b(?:dnsbl|rbl|spamhaus|spamcop|barracudacentral|sorbs)\b/i;
// The listing must be about OUR sending side. A bare IP is not enough: most
// bounces quote the REMOTE MX ("host mx.example[142.250.1.1] said: 550 5.1.1").
// Vendor names alone are not enough either — they also run content lists.
const SENDER_SIDE = /\bclient host\b|(?:messages from|connections? (?:will not be accepted )?from|sending (?:ip|host)|from ip)\s*\[?\d{1,3}(?:\.\d{1,3}){3}|\b(?:the|your|sending) ip\b|[?&]ip(?:_address)?=\d|part of their network/i;
// Domain/URL (content) block lists: the message or sender domain is listed, not
// the IP. Another egress would be rejected the same way.
const CONTENT_LISTED = /\b(?:dbl|uribl|surbl)\b|\b(?:url|uri|domain)s? (?:is |are )?listed/i;
// ...and never a recipient who chose to block us: re-sending there is worse than
// a dead mailbox. Only the recipient's OWN choice counts — Postfix prefixes RBL
// rejections with "Recipient address rejected:", so the bare word must not veto.
const RECIPIENT_SIDE = /recipient'?s? (?:own |personal )?(?:block|black) ?list|user has blocked|blocked by (?:the )?(?:user|recipient)|mailbox owner/i;

// Resend keeps idempotency keys 24h; past that a retry could send a second copy.
export const FALLBACK_MAX_AGE_MS = 23 * 3600 * 1000;

export const FALLBACK_META_TTL_SECONDS = 7 * 24 * 3600;

export function fallbackMetaKey(emailId) {
	return `blocklist-fallback-meta:${emailId}`;
}

export function fallbackIdempotencyKey(emailId) {
	return `blocklist-fallback/${emailId}`;
}

/** Thrown when the queue should redeliver the event (safe: the key makes it a replay). */
export class RetryableFallbackError extends Error {}

// Read BOTH fields: CF may put a generic summary in bounce.reason and the
// provider's real text only in smtpResponse.
function bounceText(payload) {
	const bounce = payload?.bounce || {};
	const delivery = payload?.delivery || {};
	return [bounce.reason, delivery.smtpResponse].filter(Boolean).join(' | ');
}

/** True only for a PERMANENT (5xx) rejection that blames our sending side's listing. */
export function isSenderBlocklisted(payload) {
	if (!payload || typeof payload !== 'object') return false;
	const delivery = payload.delivery || {};
	const code = String(delivery.smtpStatusCode || '');
	const enhanced = String(delivery.smtpEnhancedStatusCode || '');
	const permanent = code.startsWith('5') || enhanced.startsWith('5.');
	if (!permanent) return false;
	const text = bounceText(payload);
	if (!LISTED.test(text) || RECIPIENT_SIDE.test(text) || CONTENT_LISTED.test(text)) return false;
	return MS_CODE.test(text) || SENDER_SIDE.test(text);
}

/** What the send path must remember because D1 does not keep it. */
export function buildFallbackMeta(sendForm) {
	const meta = {
		from: sendForm.from,
		hasAttachments: Array.isArray(sendForm.attachments) && sendForm.attachments.length > 0,
	};
	if (sendForm.replyTo) meta.replyTo = sendForm.replyTo;
	if (sendForm.headers) meta.headers = sendForm.headers;
	return meta;
}

// D1 stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' in UTC. An unparseable
// value counts as too old: the safe direction is not re-sending.
function isTooOld(createTime, now) {
	if (!createTime) return true;
	const t = Date.parse(String(createTime).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(createTime) ? '' : 'Z'));
	return !Number.isFinite(t) || now - t > FALLBACK_MAX_AGE_MS;
}

/**
 * Decide what to do with one delivery event.
 *   { action: 'none', reason }   — not our concern; process the event normally
 *   { action: 'skip', reason }   — a block-list bounce we cannot re-send; log it
 *   { action: 'resend', sendForm }
 */
export function planFallback({ evtName, payload, row, resendToken, meta, now = Date.now() }) {
	if (evtName !== 'message.bounced') return { action: 'none', reason: 'not-a-bounce' };
	if (row?.resendEmailId) return { action: 'none', reason: 'already-resent' };
	if (!isSenderBlocklisted(payload)) return { action: 'none', reason: 'not-blocklisted' };
	if (!resendToken) return { action: 'skip', reason: 'no-resend-token' };
	if (!meta) return { action: 'skip', reason: 'no-send-meta' };
	if (meta.hasAttachments) return { action: 'skip', reason: 'had-attachments' };
	if (isTooOld(row.createTime, now)) return { action: 'skip', reason: 'too-old' };

	const recipient = String(payload?.recipient || '').trim();
	if (!recipient) return { action: 'skip', reason: 'no-recipient' };

	const sendForm = {
		from: meta.from,
		to: [recipient],
		subject: row.subject,
	};
	if (row.content) sendForm.html = row.content;
	if (row.text) sendForm.text = row.text;
	if (meta.replyTo) sendForm.replyTo = meta.replyTo;
	if (meta.headers) sendForm.headers = meta.headers;
	return { action: 'resend', sendForm };
}

/**
 * Resend errors that do not mean "Resend refused this message". The SDK never
 * throws: a dropped connection comes back as { name:'application_error',
 * statusCode:null } — possibly AFTER Resend accepted the mail. Recording that as
 * a bounce would be wrong; retrying is safe because the key turns it into a replay.
 */
const RETRYABLE_NAMES = new Set(['concurrent_idempotent_requests', 'rate_limit_exceeded', 'application_error', 'internal_server_error']);

export function isRetryableResendError(error) {
	if (!error) return false;
	if (RETRYABLE_NAMES.has(error.name)) return true;
	const code = error.statusCode;
	return code === null || code === undefined || code === 429 || code >= 500;
}

/**
 * Perform a planned re-send. Returns { ok:true, resendEmailId } or
 * { ok:false, reason:'resend-error', error } (record the bounce, do not retry).
 * Throws RetryableFallbackError — so the queue redelivers — for transient or
 * ambiguous failures, unless `finalAttempt`, when it returns the error so the
 * bounce is recorded rather than dropped. A markResent failure always throws.
 */
export async function executeFallback({ send, markResent }, plan, idempotencyKey, { finalAttempt = false } = {}) {
	let res;
	try {
		res = await send(plan.sendForm, { idempotencyKey });
	} catch (e) {
		res = { data: null, error: { name: 'application_error', statusCode: null, message: e?.message || String(e) } };
	}

	const id = res?.data?.id;
	if (!res?.error && id) {
		await markResent(id);
		return { ok: true, resendEmailId: id };
	}

	const error = res?.error || { name: 'application_error', statusCode: null, message: 'no id returned' };
	if (isRetryableResendError(error) && !finalAttempt) {
		throw new RetryableFallbackError(`re-send ${idempotencyKey}: ${error.name || 'error'} ${error.message || ''}`.trim());
	}
	return { ok: false, reason: 'resend-error', error: error.message || error.name || 'unknown', retryable: isRetryableResendError(error) };
}
