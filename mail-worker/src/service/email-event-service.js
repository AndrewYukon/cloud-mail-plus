import { emailConst } from '../const/entity-const';
import email from '../entity/email';
import orm from '../entity/orm';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import settingService from './setting-service';
import emailUtils from '../utils/email-utils';
import { executeFallback, fallbackIdempotencyKey, fallbackMetaKey, planFallback, RetryableFallbackError } from './blocklist-fallback';

// Must equal the consumer's max_retries + 1 in wrangler.toml (attempts is 1-based).
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_SECONDS = 60;

/**
 * Cloudflare Email Service — outbound delivery event consumer.
 *
 * CF publishes six lifecycle events per outbound message onto a Queue via an
 * event subscription (source `email.sending`, one subscription per sending
 * domain). This service joins each event back to its `email` row so that
 * `GET /external/status/:emailId` reports the REAL delivery outcome instead of
 * the send-time optimistic "delivered".
 *
 * Why we join on Message-ID and not on anything we generate ourselves:
 *   CF REWRITES the Message-ID header. The value built by
 *   cf-email-service.js `_generateMessageId()` never reaches the recipient —
 *   verified 2026-07-28 by a round-trip probe (we sent `<uuid@example.com>`,
 *   the recipient received and the event reported
 *   `<aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789@example.com>`).
 *   The only durable join key is `EmailSendResult.messageId` returned by
 *   `env.EMAIL.send()`, which IS the delivered Message-ID.
 *
 * Bracket discipline: the event payload carries `<id@domain>` while
 * `/external/email/list-message-ids` returns it bare. Never compare raw —
 * always go through `normalizeMessageId`, which strips the brackets and
 * PRESERVES case (RFC 5322 msg-id is case-sensitive, and this value is the
 * real header on the wire — lowercasing it would corrupt the stored column).
 * Case-insensitive matching is handled at query time by `findSendRow`.
 */

const EVENT_PREFIX = 'cf.email.sending.';

const STATUS_BY_EVENT = {
	'message.delivered': emailConst.status.DELIVERED,
	'message.deferred': emailConst.status.DELAYED,
	'message.bounced': emailConst.status.BOUNCED,
	'message.complained': emailConst.status.COMPLAINED,
	'message.failed': emailConst.status.FAILED,
	'message.rejected': emailConst.status.FAILED,
};

/**
 * Queues give no ordering guarantee, so a late `delivered` must never clear an
 * already-recorded `bounced`. We only ever move a row UP this ladder.
 * `complained` outranks `delivered` because it legitimately arrives after it
 * (the recipient got the mail, then pressed "spam").
 */
const RANK = {
	[emailConst.status.SENT]: 1,
	[emailConst.status.DELAYED]: 2,
	[emailConst.status.DELIVERED]: 3,
	[emailConst.status.FAILED]: 4,
	[emailConst.status.BOUNCED]: 5,
	[emailConst.status.COMPLAINED]: 6,
};

export function normalizeMessageId(raw) {
	return String(raw || '').trim().replace(/^<|>$/g, '');
}

/**
 * Locate the outbound row an event belongs to.
 *
 * Exact match first so the query can use the index on `message_id`. The
 * case-insensitive pass exists only as a safety net: rows written before case
 * was preserved are lowercased, and `lower()` defeats the index — so it must
 * never be the primary path. A warn on the fallback makes any real casing
 * mismatch from Cloudflare visible rather than silently absorbed.
 */
async function findSendRow(c, messageId) {
	const exact = await orm(c).select().from(email).where(and(
		eq(email.messageId, messageId),
		eq(email.type, emailConst.type.SEND),
	)).get();
	if (exact) return exact;

	const loose = await orm(c).select().from(email).where(and(
		sql`lower(${email.messageId}) = ${messageId.toLowerCase()}`,
		eq(email.type, emailConst.type.SEND),
	)).get();
	if (loose) {
		console.warn(`[email-event] matched case-insensitively only: ${messageId}`);
	}
	return loose;
}

function shortEventName(type) {
	const t = String(type || '');
	return t.startsWith(EVENT_PREFIX) ? t.slice(EVENT_PREFIX.length) : t;
}

/**
 * Compact, queryable summary persisted into `email.message`. Mirrors the shape
 * resend-service already stores there so downstream readers stay uniform.
 */
function summarize(evtName, payload) {
	const delivery = payload.delivery || {};
	const bounce = payload.bounce || {};
	return {
		event: evtName,
		terminal: payload.terminal === true,
		recipient: payload.recipient || null,
		provider: delivery.provider || null,
		smtpStatusCode: delivery.smtpStatusCode || null,
		smtpEnhancedStatusCode: delivery.smtpEnhancedStatusCode || null,
		bounceType: bounce.type || null,
		classification: bounce.classification || null,
		reason: bounce.reason || delivery.smtpResponse || null,
	};
}

function buildMessage(evtName, payload, extra) {
	return JSON.stringify({ ...summarize(evtName, payload), ...(extra || {}) });
}

/**
 * Sender block-list bounce → re-send this one recipient through Resend (see
 * blocklist-fallback.js for why and for the gate).
 * Returns an outcome string when the event is fully handled here, or
 * `{ note }` to be attached to the normally-recorded bounce.
 */
async function tryBlocklistFallback(c, row, evtName, payload, { finalAttempt }) {
	if (evtName !== 'message.bounced') return null;

	const { resendTokens } = await settingService.query(c);
	const resendToken = (resendTokens || {})[emailUtils.getDomain(row.sendEmail)];
	const meta = resendToken
		? await c.env.kv.get(fallbackMetaKey(row.emailId), { type: 'json' })
		: null;

	const plan = planFallback({ evtName, payload, row, resendToken, meta });
	if (plan.action === 'none') return null;
	if (plan.action === 'skip') {
		console.warn(`[email-event] blocklist bounce not re-sent (${plan.reason}): emailId=${row.emailId}`);
		return { note: { fallback: { skipped: plan.reason } } };
	}

	// A RetryableFallbackError or a D1 error from markResent propagates to
	// consumeBatch → msg.retry(); the idempotency key turns that retry into a
	// replay of the same Resend send, never a second email.
	const result = await executeFallback({
		send: (form, options) => new Resend(resendToken).emails.send(form, options),
		markResent: async (resendEmailId) => {
			await orm(c).update(email).set({
				status: emailConst.status.SENT,
				resendEmailId,
				message: JSON.stringify({
					event: 'fallback.resend',
					terminal: false,
					recipient: payload.recipient || null,
					provider: 'resend',
					previousBounce: summarize(evtName, payload),
				}),
			}).where(eq(email.emailId, row.emailId)).run();
		},
	}, plan, fallbackIdempotencyKey(row.emailId), { finalAttempt });

	if (result.ok) {
		return `fallback:resend:emailId=${row.emailId}:resendEmailId=${result.resendEmailId}`;
	}
	console.error(`[email-event] blocklist fallback failed for emailId=${row.emailId}: ${result.error}`);
	const note = { error: result.error };
	if (result.retryable) note.retriesExhausted = true;
	return { note: { fallback: note } };
}

const emailEventService = {

	/**
	 * Apply one CF event. Returns a short outcome string for logging.
	 * Never throws on "we don't care about this event" — only on real
	 * infrastructure failure, so the caller can retry the queue message.
	 */
	async applyEvent(env, body, { finalAttempt = false } = {}) {
		if (!body || typeof body !== 'object') {
			return 'skip:not-an-object';
		}

		const evtName = shortEventName(body.type);
		const status = STATUS_BY_EVENT[evtName];
		if (status === undefined) {
			return `skip:unknown-event(${evtName})`;
		}

		const payload = body.payload || {};
		const messageId = normalizeMessageId(payload.messageId);
		if (!messageId) {
			return `skip:no-message-id(${evtName})`;
		}

		const c = { env };

		// Scope to SEND rows: a round-trip (our domain → our domain) stores the
		// SAME Message-ID on both the outbound row and the inbound row, and the
		// inbound row's status must not be touched by a sending event.
		const row = await findSendRow(c, messageId);

		if (!row) {
			// Expected for: mail sent before messageId persistence shipped, sends
			// from Outlook via the SMTP relay, and recipients 2..N of a multi-
			// recipient send. Not an error — but worth seeing in the logs.
			return `unmatched:${evtName}:${messageId}`;
		}

		// Once a block-list fallback has re-sent this message through Resend, the
		// CF copy is dead: a redelivered or late CF event must not overwrite the
		// row (that would flip a re-sent message back to "bounced").
		if (row.resendEmailId) {
			return `ignored:${evtName}:after-resend-fallback`;
		}

		const fallback = await tryBlocklistFallback(c, row, evtName, payload, { finalAttempt });
		if (typeof fallback === 'string') {
			return fallback;
		}

		const currentRank = RANK[row.status] || 0;
		const nextRank = RANK[status] || 0;
		if (nextRank < currentRank) {
			return `ignored:${evtName}:would-downgrade-from-${row.status}`;
		}

		// Conditional on resend_email_id so a concurrent fallback that already
		// recorded its Resend id is never overwritten by this CF event.
		await orm(c).update(email).set({
			status,
			message: buildMessage(evtName, payload, fallback?.note),
		}).where(and(
			eq(email.emailId, row.emailId),
			isNull(email.resendEmailId),
		)).run();

		return `applied:${evtName}:emailId=${row.emailId}`;
	},

	/**
	 * Queue consumer entrypoint. Acks anything we processed or deliberately
	 * skipped; retries only genuine failures so a transient D1 error does not
	 * silently drop a bounce.
	 */
	async consumeBatch(batch, env) {
		for (const msg of batch.messages) {
			try {
				const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
				const finalAttempt = (msg.attempts || 1) >= MAX_ATTEMPTS;
				const outcome = await this.applyEvent(env, body, { finalAttempt });
				console.log(`[email-event] ${outcome}`);
				msg.ack();
			} catch (e) {
				console.error(`[email-event] FAILED, will retry: ${e.message || e}`);
				// Give an in-flight or rate-limited Resend call time to settle
				// instead of burning the retry budget immediately.
				msg.retry(e instanceof RetryableFallbackError ? { delaySeconds: RETRY_DELAY_SECONDS } : undefined);
			}
		}
	},
};

export default emailEventService;
