import { describe, expect, it, vi } from 'vitest';
import {
	isSenderBlocklisted,
	planFallback,
	executeFallback,
	buildFallbackMeta,
	fallbackMetaKey,
	fallbackIdempotencyKey,
	RetryableFallbackError,
	isRetryableResendError,
} from '../../src/service/blocklist-fallback';

// The shape of a real Microsoft S3150 bounce (IP replaced with a documentation address).
const S3150_PAYLOAD = {
	messageId: '<abc@example.com>',
	recipient: 'user@hotmail.com',
	delivery: { provider: 'outlook', smtpStatusCode: '550', smtpEnhancedStatusCode: '5.7.1' },
	bounce: {
		type: 'hard',
		classification: 'permanent_failure',
		reason: "Permanent Unknown error: permanent error (550): 5.7.1 Unfortunately, messages from [192.0.2.10] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150).",
	},
};

const MAILBOX_UNKNOWN_PAYLOAD = {
	messageId: '<def@example.com>',
	recipient: 'nobody@gmail.com',
	delivery: { provider: 'gmail', smtpStatusCode: '550', smtpEnhancedStatusCode: '5.1.1' },
	bounce: { type: 'hard', classification: 'permanent_failure', reason: '550 5.1.1 The email account that you tried to reach does not exist.' },
};

const ROW = {
	emailId: 1234,
	sendEmail: 'noreply@example.com',
	name: 'Example App',
	subject: 'Verify your email',
	content: '<p>Click to verify</p>',
	text: 'Click to verify',
	resendEmailId: null,
	createTime: '2026-11-13 10:00:00',
	recipient: JSON.stringify([{ address: 'user@hotmail.com', name: '' }]),
};

const META = { from: 'Example App <noreply@example.com>', replyTo: 'support@example.com', headers: { 'X-App': 'example' }, hasAttachments: false };

describe('isSenderBlocklisted', () => {
	it('recognises the Microsoft S3150 block-list bounce', () => {
		expect(isSenderBlocklisted(S3150_PAYLOAD)).toBe(true);
	});

	it('does not treat an unknown mailbox as a sender block', () => {
		expect(isSenderBlocklisted(MAILBOX_UNKNOWN_PAYLOAD)).toBe(false);
	});

	it('ignores block-list wording on a temporary (4xx) failure', () => {
		const p = { ...S3150_PAYLOAD, delivery: { smtpStatusCode: '451', smtpEnhancedStatusCode: '4.7.1' } };
		expect(isSenderBlocklisted(p)).toBe(false);
	});

	it('falls back to delivery.smtpResponse when bounce.reason is absent', () => {
		const p = { delivery: { smtpStatusCode: '554', smtpResponse: '554 5.7.1 Service unavailable; Client host blocked using Spamhaus block list' } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('recognises a Spamhaus listing of the sending host', () => {
		const p = { delivery: { smtpStatusCode: '554', smtpResponse: '554 5.7.1 Service unavailable; Client host [192.0.2.10] blocked using zen.spamhaus.org' } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('reads smtpResponse even when bounce.reason is a generic summary', () => {
		const p = {
			delivery: { smtpStatusCode: '550', smtpEnhancedStatusCode: '5.7.1', smtpResponse: S3150_PAYLOAD.bounce.reason },
			bounce: { type: 'hard', reason: 'Permanent Unknown error' },
		};
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('does NOT re-send to a recipient who blocked the sender', () => {
		const p = { delivery: { smtpStatusCode: '550', smtpEnhancedStatusCode: '5.7.1' }, bounce: { reason: "550 5.7.1 The sender is on the recipient's block list" } };
		expect(isSenderBlocklisted(p)).toBe(false);
	});

	it('does NOT match a stray S3xxx-shaped token without block-list wording', () => {
		const p = { delivery: { smtpStatusCode: '550' }, bounce: { reason: '550 5.2.2 Mailbox full (S3000 quota)' } };
		expect(isSenderBlocklisted(p)).toBe(false);
	});

	it('re-sends a Postfix RBL rejection even though it says "Recipient address rejected"', () => {
		const p = { delivery: { smtpStatusCode: '554', smtpEnhancedStatusCode: '5.7.1' }, bounce: { reason: '554 5.7.1 <user@example.org>: Recipient address rejected: Service unavailable; Client host [192.0.2.10] blocked using zen.spamhaus.org' } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('does NOT treat a dead mailbox as a block just because the remote MX IP is quoted', () => {
		const p = { delivery: { smtpStatusCode: '550', smtpEnhancedStatusCode: '5.1.1' }, bounce: { reason: 'host mx.example.org[142.250.1.1] said: 550 5.1.1 User not listed in public directory' } };
		expect(isSenderBlocklisted(p)).toBe(false);
	});

	it('recognises the Yahoo Spamhaus wording', () => {
		const p = { delivery: { smtpStatusCode: '553', smtpEnhancedStatusCode: '5.7.1' }, bounce: { reason: "553 5.7.1 [BL21] Connections will not be accepted from 192.0.2.10, because the ip is in Spamhaus's list" } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('recognises the short Barracuda wording', () => {
		const p = { delivery: { smtpStatusCode: '554' }, bounce: { reason: '554 Blocked - see https://www.barracudacentral.org/lookups/lookup-reputation?ip=192.0.2.10' } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('recognises the long Barracuda wording (ip_address=)', () => {
		const p = { delivery: { smtpStatusCode: '550' }, bounce: { reason: '550 Blocked - see https://www.barracudacentral.org/lookups/lookup-reputation?ip_address=192.0.2.10' } };
		expect(isSenderBlocklisted(p)).toBe(true);
	});

	it('does NOT re-send when a URL/domain list (DBL, URIBL) rejected the content', () => {
		const dbl = { delivery: { smtpStatusCode: '550', smtpEnhancedStatusCode: '5.7.1' }, bounce: { reason: '550 5.7.1 Message rejected: URL listed at dbl.spamhaus.org' } };
		const uribl = { delivery: { smtpStatusCode: '554' }, bounce: { reason: '554 5.7.1 Client host [192.0.2.10]: rejected, domain listed in multi.uribl.com' } };
		expect(isSenderBlocklisted(dbl)).toBe(false);
		expect(isSenderBlocklisted(uribl)).toBe(false);
	});

	it('is false for an empty payload', () => {
		expect(isSenderBlocklisted({})).toBe(false);
		expect(isSenderBlocklisted(null)).toBe(false);
	});
});

describe('planFallback', () => {
	const NOW = Date.parse('2026-11-13T11:00:00Z');
	const base = { evtName: 'message.bounced', payload: S3150_PAYLOAD, row: ROW, resendToken: 're_x', meta: META, now: NOW };

	it('plans a Resend send to the bounced recipient only', () => {
		const plan = planFallback(base);
		expect(plan.action).toBe('resend');
		expect(plan.sendForm).toEqual({
			from: 'Example App <noreply@example.com>',
			to: ['user@hotmail.com'],
			subject: 'Verify your email',
			html: '<p>Click to verify</p>',
			text: 'Click to verify',
			replyTo: 'support@example.com',
			headers: { 'X-App': 'example' },
		});
	});

	it('skips non-bounce events', () => {
		expect(planFallback({ ...base, evtName: 'message.delivered' })).toEqual({ action: 'none', reason: 'not-a-bounce' });
	});

	it('skips bounces that are not sender blocks', () => {
		expect(planFallback({ ...base, payload: MAILBOX_UNKNOWN_PAYLOAD })).toEqual({ action: 'none', reason: 'not-blocklisted' });
	});

	it('skips when the sending domain has no Resend token', () => {
		expect(planFallback({ ...base, resendToken: undefined })).toEqual({ action: 'skip', reason: 'no-resend-token' });
	});

	it('skips when the row was already handed to Resend', () => {
		expect(planFallback({ ...base, row: { ...ROW, resendEmailId: 're-id' } })).toEqual({ action: 'none', reason: 'already-resent' });
	});

	it('skips when the send-time metadata is missing (cannot rebuild the message faithfully)', () => {
		expect(planFallback({ ...base, meta: null })).toEqual({ action: 'skip', reason: 'no-send-meta' });
	});

	it('skips when the original carried attachments that D1 does not keep', () => {
		expect(planFallback({ ...base, meta: { ...META, hasAttachments: true } })).toEqual({ action: 'skip', reason: 'had-attachments' });
	});

	it('skips when the event has no recipient', () => {
		expect(planFallback({ ...base, payload: { ...S3150_PAYLOAD, recipient: '' } })).toEqual({ action: 'skip', reason: 'no-recipient' });
	});

	it('skips a message older than the 24h idempotency window', () => {
		expect(planFallback({ ...base, now: NOW + 23 * 3600 * 1000 })).toEqual({ action: 'skip', reason: 'too-old' });
	});

	it('skips when the row has no usable create time', () => {
		expect(planFallback({ ...base, row: { ...ROW, createTime: 'garbage' } })).toEqual({ action: 'skip', reason: 'too-old' });
	});

	it('omits html/text/replyTo/headers that were never set', () => {
		const plan = planFallback({ ...base, row: { ...ROW, content: '', text: 'only text' }, meta: { from: 'a@example.com', hasAttachments: false } });
		expect(plan.sendForm).toEqual({ from: 'a@example.com', to: ['user@hotmail.com'], subject: 'Verify your email', text: 'only text' });
	});
});

describe('executeFallback', () => {
	const plan = { action: 'resend', sendForm: { from: 'a@example.com', to: ['user@hotmail.com'], subject: 's', text: 't' } };
	const KEY = 'blocklist-fallback/1234';

	function deps(overrides = {}) {
		return {
			send: vi.fn().mockResolvedValue({ data: { id: 'resend-123' }, error: null }),
			markResent: vi.fn().mockResolvedValue(undefined),
			...overrides,
		};
	}

	it('sends with the idempotency key and records the Resend id', async () => {
		const d = deps();
		const out = await executeFallback(d, plan, KEY);
		expect(out).toEqual({ ok: true, resendEmailId: 'resend-123' });
		expect(d.send).toHaveBeenCalledWith(plan.sendForm, { idempotencyKey: KEY });
		expect(d.markResent).toHaveBeenCalledWith('resend-123');
	});

	it('reports a definitive Resend rejection (4xx) without retrying', async () => {
		const d = deps({ send: vi.fn().mockResolvedValue({ data: null, error: { name: 'validation_error', statusCode: 403, message: 'domain not verified' } }) });
		const out = await executeFallback(d, plan, KEY);
		expect(out).toEqual({ ok: false, reason: 'resend-error', error: 'domain not verified', retryable: false });
		expect(d.markResent).not.toHaveBeenCalled();
	});

	it.each([
		['a dropped connection (SDK returns statusCode null)', { name: 'application_error', statusCode: null, message: 'Unable to fetch data.' }],
		['a Resend 5xx', { name: 'internal_server_error', statusCode: 500, message: 'oops' }],
		['a rate limit', { name: 'rate_limit_exceeded', statusCode: 429, message: 'slow down' }],
		['the same key still in flight', { name: 'concurrent_idempotent_requests', statusCode: 409, message: 'in progress' }],
	])('asks for a queue retry on %s (the key makes it a replay)', async (_label, error) => {
		const d = deps({ send: vi.fn().mockResolvedValue({ data: null, error }) });
		await expect(executeFallback(d, plan, KEY)).rejects.toBeInstanceOf(RetryableFallbackError);
		expect(d.markResent).not.toHaveBeenCalled();
	});

	it('treats a thrown send as retryable too', async () => {
		const d = deps({ send: vi.fn().mockRejectedValue(new Error('network down')) });
		await expect(executeFallback(d, plan, KEY)).rejects.toBeInstanceOf(RetryableFallbackError);
	});

	it('returns the error instead of throwing on the final attempt, so the bounce is recorded', async () => {
		const d = deps({ send: vi.fn().mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data.' } }) });
		const out = await executeFallback(d, plan, KEY, { finalAttempt: true });
		expect(out).toEqual({ ok: false, reason: 'resend-error', error: 'Unable to fetch data.', retryable: true });
	});

	it('classifies Resend errors', () => {
		expect(isRetryableResendError({ name: 'validation_error', statusCode: 422 })).toBe(false);
		expect(isRetryableResendError({ name: 'application_error', statusCode: 400 })).toBe(true);
		expect(isRetryableResendError({ statusCode: 503 })).toBe(true);
		expect(isRetryableResendError(null)).toBe(false);
	});

	it('lets a D1 failure after the send propagate so the queue retries (the key makes the retry a replay)', async () => {
		const d = deps({ markResent: vi.fn().mockRejectedValue(new Error('D1 timeout')) });
		await expect(executeFallback(d, plan, KEY)).rejects.toThrow('D1 timeout');
	});

	it('builds a stable per-message key', () => {
		expect(fallbackIdempotencyKey(1234)).toBe('blocklist-fallback/1234');
	});
});

describe('buildFallbackMeta / fallbackMetaKey', () => {
	it('keeps only what D1 does not already store', () => {
		const meta = buildFallbackMeta({
			from: 'Example App <noreply@example.com>', to: ['x@y.z'], subject: 's', html: '<p>h</p>',
			replyTo: 'support@example.com', headers: { 'X-App': 'example' },
			attachments: [{ filename: 'a.pdf', content: 'AAAA' }],
		});
		expect(meta).toEqual({ from: 'Example App <noreply@example.com>', replyTo: 'support@example.com', headers: { 'X-App': 'example' }, hasAttachments: true });
	});

	it('marks hasAttachments false when there are none', () => {
		expect(buildFallbackMeta({ from: 'a@b.c' }).hasAttachments).toBe(false);
	});

	it('namespaces the KV key by emailId', () => {
		expect(fallbackMetaKey(42)).toBe('blocklist-fallback-meta:42');
	});
});
