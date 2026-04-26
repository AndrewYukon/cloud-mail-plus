/**
 * Cloudflare Email Service wrapper.
 *
 * Uses the native Workers `send_email` binding (env.EMAIL).
 * Cloudflare handles SPF, DKIM, and DMARC automatically.
 *
 * Attachment format (CF Email API):
 *   { filename, content (base64|ArrayBuffer), type (MIME), disposition ('attachment'|'inline'), contentId? }
 *
 * Docs: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

const cfEmailService = {

	async send(env, form) {

		if (!env.EMAIL) {
			const err = new Error('EMAIL binding not configured in wrangler.toml');
			err.code = 'E_NO_BINDING';
			throw err;
		}

		const recipients = Array.isArray(form.to) ? form.to : [form.to];
		if (recipients.length > 50) {
			const err = new Error(
				`CF Email: ${recipients.length} recipients exceeds the 50-recipient limit`
			);
			err.code = 'E_TOO_MANY_RECIPIENTS';
			throw err;
		}

		// Parse "Name <email>" format to { name, email } object
		let fromField = form.from;
		const fromMatch = String(form.from).match(/^(.+?)\s*<(.+?)>$/);
		if (fromMatch) {
			fromField = { name: fromMatch[1].trim(), email: fromMatch[2].trim() };
		}

		const message = {
			from: fromField,
			to: recipients.length === 1 ? recipients[0] : recipients,
			subject: form.subject,
		};

		if (form.html) message.html = form.html;
		if (form.text) message.text = form.text;
		if (form.headers) message.headers = { ...form.headers };

		// Map attachments to CF Email API format:
		//   CF expects: { filename, content, type (MIME), disposition, contentId? }
		//   Cloud-Mail provides: { filename, content, contentType/mimeType, contentId? }
		if (Array.isArray(form.attachments) && form.attachments.length > 0) {
			const validAtts = form.attachments.filter(att => att.content && att.filename);
			if (validAtts.length > 0) {
				message.attachments = validAtts.map(att => ({
					filename: att.filename,
					content: att.content,
					type: att.contentType || att.mimeType || att.mime_type || att.type || 'application/octet-stream',
					disposition: att.contentId ? 'inline' : 'attachment',
					...(att.contentId ? { contentId: att.contentId } : {}),
				}));
			}
		}

		try {
			const result = await env.EMAIL.send(message);
			console.log(`[CF Email] sent to ${JSON.stringify(recipients)}`);
			return { success: true, result };
		} catch (e) {
			console.error(`[CF Email] send failed:`, e.code || '', e.message || e);
			throw e;
		}
	}
};

export default cfEmailService;
