import { describe, expect, it } from 'vitest';
import { isDmarcReport } from '../../src/utils/dmarc-utils';

// Real sender/subject pairs taken from D1 (2026-09-23): every DMARC reporter
// that has ever written to one of our domains.
const REAL_REPORTS = [
	['noreply-dmarc-support@google.com', 'Report domain: aipickup4u.com Submitter: google.com Report-ID: 11447463496789819420'],
	['dmarcreport@microsoft.com', 'Report Domain: aipickup4u.com Submitter: protection.outlook.com Report-ID: 0cecd7bec035483e947d90423518d007'],
	['noreply@dmarc.yahoo.com', 'Report Domain: oetlive.com Submitter: yahoo.com Report-ID: <1781329895.35241>'],
	['dmarc_support@corp.mail.ru', 'Report Domain: oetlive.com; Submitter: Mail.Ru; Report-ID: 18520205951976380991788048000'],
	['postmaster@amazonses.com', 'Dmarc Aggregate Report Domain: {blizzarddelights.com} Submitter: {Amazon SES} Date: {2026-05-08} Report-ID: {1bc0}'],
];

describe('isDmarcReport', () => {
	it.each(REAL_REPORTS)('matches real report from %s', (fromAddress, subject) => {
		expect(isDmarcReport({ fromAddress, subject })).toBe(true);
	});

	it('matches on sender alone when the subject is unusual', () => {
		expect(isDmarcReport({ fromAddress: 'DMARC-Reports@Example.org', subject: 'weekly digest' })).toBe(true);
	});

	it('matches an RFC 7489 subject from an unknown reporter', () => {
		expect(isDmarcReport({ fromAddress: 'reports@mx.example.net', subject: 'Report Domain: owaa.ai Submitter: example.net Report-ID: 42' })).toBe(true);
	});

	it.each([
		['customer@gmail.com', 'Order question'],
		['alerts@google.com', 'Security alert for info@owaa.ai'],
		['billing@example.com', 'Your report is ready'],
		['news@admarchive.com', 'Our archive'],
	])('leaves ordinary mail alone: %s / %s', (fromAddress, subject) => {
		expect(isDmarcReport({ fromAddress, subject })).toBe(false);
	});

	it('tolerates missing fields', () => {
		expect(isDmarcReport({})).toBe(false);
		expect(isDmarcReport({ fromAddress: null, subject: undefined })).toBe(false);
	});
});
