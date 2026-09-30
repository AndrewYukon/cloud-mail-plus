import { emailConst } from '../const/entity-const';
import { assessPhishing } from './phish-utils';
import { isDmarcReport } from './dmarc-utils';

/**
 * Decide which folder a received mail lands in.
 * Phishing is checked BEFORE DMARC on purpose: otherwise a sender could dodge
 * Junk by putting "dmarc" in its address or subject.
 * `assess` is an override for tests only.
 */
export function decideInboundFolder({
	fromAddress = '', fromName = '', recipient = '',
	subject = '', html = '', text = '', authResults = '',
} = {}, { assess = assessPhishing } = {}) {
	const input = {
		fromAddress: String(fromAddress ?? ''),
		fromName: String(fromName ?? ''),
		recipient: String(recipient ?? ''),
		subject: String(subject ?? ''),
		html: String(html ?? ''),
		text: String(text ?? ''),
		authResults: String(authResults ?? ''),
	};

	try {
		const verdict = assess(input);
		if (verdict.suspect) {
			return { folder: emailConst.folder.JUNK, reasons: verdict.reasons };
		}
	} catch (err) {
		// detection must never block delivery
		console.error('[phish] assessment failed, delivering to inbox:', err);
	}

	if (isDmarcReport({ fromAddress: input.fromAddress, subject: input.subject })) {
		return { folder: emailConst.folder.ARCHIVE, reasons: ['dmarc-report'] };
	}

	return { folder: emailConst.folder.INBOX, reasons: [] };
}
