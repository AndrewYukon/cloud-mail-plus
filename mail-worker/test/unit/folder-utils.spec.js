import { describe, expect, it, vi } from 'vitest';
import { decideInboundFolder } from '../../src/utils/folder-utils';
import { emailConst } from '../../src/const/entity-const';

const { INBOX, JUNK, ARCHIVE } = emailConst.folder;

const PHISH = {
	fromAddress: 'info@funakoshi.co.jp',
	fromName: 'DHL FastTrack',
	recipient: 'jane@example.com',
	subject: 'Your parcel',
	html: '<a href="https://pay.no-ip.org/track">track</a>',
};

describe('decideInboundFolder', () => {
	it('delivers plain legitimate mail to the inbox', () => {
		const r = decideInboundFolder({
			fromAddress: 'friend@gmail.com', fromName: 'A Friend', recipient: 'jane@example.com',
			subject: 'Lunch?', text: 'Are you free on Friday?',
		});
		expect(r).toEqual({ folder: INBOX, reasons: [] });
	});

	it('archives a real DMARC report', () => {
		const r = decideInboundFolder({
			fromAddress: 'noreply-dmarc-support@google.com',
			recipient: 'jane@example.com',
			subject: 'Report domain: aipickup4u.com Submitter: google.com Report-ID: 11447463496789819420',
		});
		expect(r).toEqual({ folder: ARCHIVE, reasons: ['dmarc-report'] });
	});

	it('sends phishing to junk with reasons', () => {
		const r = decideInboundFolder(PHISH);
		expect(r.folder).toBe(JUNK);
		expect(r.reasons.length).toBeGreaterThan(0);
	});

	it('does not let a "dmarc" sender dodge junk', () => {
		const r = decideInboundFolder({ ...PHISH, fromAddress: 'dmarc-reports@funakoshi.co.jp' });
		expect(r.folder).toBe(JUNK);
	});

	it('handles undefined and empty inputs', () => {
		expect(decideInboundFolder({})).toEqual({ folder: INBOX, reasons: [] });
		expect(decideInboundFolder()).toEqual({ folder: INBOX, reasons: [] });
		expect(decideInboundFolder({ fromAddress: undefined, subject: null, html: undefined }).folder).toBe(INBOX);
	});

	it('falls through to DMARC when the assessment throws', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const assess = () => { throw new Error('boom'); };
		expect(decideInboundFolder({ fromAddress: 'dmarcreport@microsoft.com' }, { assess }).folder).toBe(ARCHIVE);
		expect(decideInboundFolder({ fromAddress: 'a@b.com' }, { assess }).folder).toBe(INBOX);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
