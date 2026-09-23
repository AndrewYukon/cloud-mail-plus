/**
 * DMARC aggregate/forensic report detection.
 *
 * Reports are machine-generated XML attachments nobody reads in a mail client,
 * yet Google/Microsoft/Yahoo send one per domain per day. Matching messages are
 * delivered to the recipient's Archive folder instead of the inbox — never
 * dropped, so they stay searchable if a deliverability question comes up.
 *
 * Signals (either one suffices):
 *   - a token of the sender address starts or ends with "dmarc"
 *     (noreply-dmarc-support@google.com, dmarcreport@microsoft.com,
 *     noreply@dmarc.yahoo.com, dmarc_support@corp.mail.ru). Token-wise, not a
 *     bare substring: "admarchive.com" contains "dmarc" too.
 *   - subject mentions DMARC as a word, or uses the RFC 7489 §7.2.1.1 report
 *     subject "Report Domain: …" (postmaster@amazonses.com only matches here)
 *
 * The body is deliberately NOT inspected: a human writing about DMARC setup
 * is real mail and belongs in the inbox.
 */

const DMARC_WORD = /(^|[^a-z0-9])dmarc([^a-z0-9]|$)/i;
const RFC7489_SUBJECT = /^\s*report\s+domain\s*:/i;

function senderLooksLikeReporter(fromAddress) {
	return String(fromAddress || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.some((token) => token.startsWith('dmarc') || token.endsWith('dmarc'));
}

export function isDmarcReport({ fromAddress, subject } = {}) {
	const subj = String(subject || '');
	return senderLooksLikeReporter(fromAddress) || DMARC_WORD.test(subj) || RFC7489_SUBJECT.test(subj);
}
