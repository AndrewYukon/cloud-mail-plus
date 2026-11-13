import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('resend', () => ({
	Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

const { default: emailEventService } = await import('../../src/service/email-event-service');
const { fallbackMetaKey } = await import('../../src/service/blocklist-fallback');

const SEND = 1;
const STATUS = { SENT: 1, BOUNCED: 3 }; // emailConst.status

const CREATE_EMAIL = `CREATE TABLE email (
	email_id INTEGER PRIMARY KEY AUTOINCREMENT, send_email TEXT, name TEXT,
	account_id INTEGER NOT NULL, user_id INTEGER NOT NULL, subject TEXT, text TEXT, content TEXT,
	cc TEXT DEFAULT '[]', bcc TEXT DEFAULT '[]', recipient TEXT,
	to_email TEXT DEFAULT '' NOT NULL, to_name TEXT DEFAULT '' NOT NULL,
	in_reply_to TEXT DEFAULT '', relation TEXT DEFAULT '', message_id TEXT DEFAULT '',
	type INTEGER DEFAULT 0 NOT NULL, status INTEGER DEFAULT 0 NOT NULL,
	resend_email_id TEXT, message TEXT, unread INTEGER DEFAULT 0 NOT NULL,
	create_time TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL, ai_metadata TEXT DEFAULT '' NOT NULL,
	folder INTEGER DEFAULT 0 NOT NULL, is_del INTEGER DEFAULT 0 NOT NULL)`;

const S3150_REASON = "550 5.7.1 Unfortunately, messages from [192.0.2.10] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150).";

function bounceEvent(messageId, { reason = S3150_REASON, enhanced = '5.7.1', recipient = 'user@hotmail.com' } = {}) {
	return {
		type: 'cf.email.sending.message.bounced',
		payload: {
			messageId: `<${messageId}>`,
			recipient,
			terminal: true,
			delivery: { provider: 'outlook', smtpStatusCode: '550', smtpEnhancedStatusCode: enhanced },
			bounce: { type: 'hard', classification: 'permanent_failure', reason },
		},
	};
}

async function insertSend({ id, from = 'noreply@example.com', messageId }) {
	await env.db.prepare(
		`INSERT INTO email (email_id, send_email, name, account_id, user_id, subject, text, content, recipient, message_id, type, status)
		 VALUES (?, ?, 'Example App', 0, 0, 'Verify your email', 'Click to verify', '<p>Click to verify</p>', ?, ?, ?, ?)`,
	).bind(id, from, JSON.stringify([{ address: 'user@hotmail.com', name: '' }]), messageId, SEND, STATUS.SENT).run();
}

async function row(id) {
	return env.db.prepare('SELECT status, resend_email_id, message FROM email WHERE email_id = ?').bind(id).first();
}

beforeEach(async () => {
	sendMock.mockReset();
	sendMock.mockResolvedValue({ data: { id: 'resend-abc' }, error: null });
	await env.db.batch([env.db.prepare('DROP TABLE IF EXISTS email'), env.db.prepare(CREATE_EMAIL)]);
	await env.kv.put('setting:', JSON.stringify({ resendTokens: { 'example.com': 're_test' }, emailPrefixFilter: '' }));
	await env.kv.put(fallbackMetaKey(1), JSON.stringify({ from: 'Example App <noreply@example.com>', replyTo: 'support@example.com', hasAttachments: false }));
});

describe('block-list bounce fallback (email-event-service + D1 + KV)', () => {
	it('re-sends through Resend once and records it instead of the bounce', async () => {
		await insertSend({ id: 1, messageId: 'm1@example.com' });

		const outcome = await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));

		expect(outcome).toBe('fallback:resend:emailId=1:resendEmailId=resend-abc');
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(sendMock).toHaveBeenCalledWith({
			from: 'Example App <noreply@example.com>',
			to: ['user@hotmail.com'],
			subject: 'Verify your email',
			html: '<p>Click to verify</p>',
			text: 'Click to verify',
			replyTo: 'support@example.com',
		}, { idempotencyKey: 'blocklist-fallback/1' });
		const r = await row(1);
		expect(r.status).toBe(STATUS.SENT);
		expect(r.resend_email_id).toBe('resend-abc');
		const msg = JSON.parse(r.message);
		expect(msg.event).toBe('fallback.resend');
		expect(msg.previousBounce.smtpEnhancedStatusCode).toBe('5.7.1');
	});

	it('does not send a second copy when the queue redelivers the same bounce', async () => {
		await insertSend({ id: 1, messageId: 'm1@example.com' });

		await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));
		const second = await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));

		expect(second).toBe('ignored:message.bounced:after-resend-fallback');
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect((await row(1)).status).toBe(STATUS.SENT);
	});

	it('retries the queue message (not acks) while the same re-send is still in flight', async () => {
		sendMock.mockResolvedValue({ data: null, error: { name: 'concurrent_idempotent_requests', message: 'in progress' } });
		await insertSend({ id: 1, messageId: 'm1@example.com' });
		const msg = { body: bounceEvent('m1@example.com'), ack: vi.fn(), retry: vi.fn() };

		await emailEventService.consumeBatch({ messages: [msg] }, env);

		expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
		expect(msg.ack).not.toHaveBeenCalled();
		const r = await row(1);
		expect(r.status).toBe(STATUS.SENT);
		expect(r.resend_email_id).toBeNull();
	});

	it('retries a dropped Resend connection instead of recording a bounce (Resend may have accepted it)', async () => {
		sendMock.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data.' } });
		await insertSend({ id: 1, messageId: 'm1@example.com' });
		const msg = { body: bounceEvent('m1@example.com'), attempts: 1, ack: vi.fn(), retry: vi.fn() };

		await emailEventService.consumeBatch({ messages: [msg] }, env);

		expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
		expect((await row(1)).status).toBe(STATUS.SENT);
	});

	it('records the bounce on the last queue attempt rather than letting it fall into the DLQ', async () => {
		sendMock.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data.' } });
		await insertSend({ id: 1, messageId: 'm1@example.com' });
		const msg = { body: bounceEvent('m1@example.com'), attempts: 4, ack: vi.fn(), retry: vi.fn() };

		await emailEventService.consumeBatch({ messages: [msg] }, env);

		expect(msg.ack).toHaveBeenCalledTimes(1);
		const r = await row(1);
		expect(r.status).toBe(STATUS.BOUNCED);
		expect(JSON.parse(r.message).fallback).toEqual({ error: 'Unable to fetch data.', retriesExhausted: true });
	});

	it('leaves an ordinary hard bounce (unknown mailbox) alone', async () => {
		await insertSend({ id: 1, messageId: 'm1@example.com' });

		const outcome = await emailEventService.applyEvent(env, bounceEvent('m1@example.com', {
			reason: '550 5.1.1 The email account that you tried to reach does not exist.', enhanced: '5.1.1',
		}));

		expect(outcome).toBe('applied:message.bounced:emailId=1');
		expect(sendMock).not.toHaveBeenCalled();
		expect((await row(1)).status).toBe(STATUS.BOUNCED);
	});

	it('records the bounce with a note when the domain has no Resend token', async () => {
		await insertSend({ id: 1, from: 'noreply@example.org', messageId: 'm1@example.org' });

		const outcome = await emailEventService.applyEvent(env, bounceEvent('m1@example.org'));

		expect(outcome).toBe('applied:message.bounced:emailId=1');
		expect(sendMock).not.toHaveBeenCalled();
		const r = await row(1);
		expect(r.status).toBe(STATUS.BOUNCED);
		expect(JSON.parse(r.message).fallback).toEqual({ skipped: 'no-resend-token' });
	});

	it('records the bounce with the error when Resend rejects', async () => {
		sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', statusCode: 403, message: 'domain not verified' } });
		await insertSend({ id: 1, messageId: 'm1@example.com' });

		const outcome = await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));

		expect(outcome).toBe('applied:message.bounced:emailId=1');
		const r = await row(1);
		expect(r.status).toBe(STATUS.BOUNCED);
		expect(r.resend_email_id).toBeNull();
		expect(JSON.parse(r.message).fallback).toEqual({ error: 'domain not verified' });
	});

	it('does not re-send a message whose attachments D1 never kept', async () => {
		await env.kv.put(fallbackMetaKey(1), JSON.stringify({ from: 'a@example.com', hasAttachments: true }));
		await insertSend({ id: 1, messageId: 'm1@example.com' });

		await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));

		expect(sendMock).not.toHaveBeenCalled();
		expect(JSON.parse((await row(1)).message).fallback).toEqual({ skipped: 'had-attachments' });
	});

	it('ignores a late CF delivered event after the fallback', async () => {
		await insertSend({ id: 1, messageId: 'm1@example.com' });
		await emailEventService.applyEvent(env, bounceEvent('m1@example.com'));

		const late = await emailEventService.applyEvent(env, {
			type: 'cf.email.sending.message.delivered',
			payload: { messageId: '<m1@example.com>', recipient: 'user@hotmail.com', terminal: true, delivery: {} },
		});

		expect(late).toBe('ignored:message.delivered:after-resend-fallback');
	});
});
