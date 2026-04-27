/**
 * EML Export Service — builds RFC 5322 .eml files from Cloud-Mail DB records.
 *
 * Generates standard MIME messages that can be opened by any email client
 * (Outlook, Thunderbird, Apple Mail, etc.).
 */

import orm from '../entity/orm';
import email from '../entity/email';
import { att } from '../entity/att';
import { eq, inArray } from 'drizzle-orm';
import r2Service from './r2-service';

const BOUNDARY_PREFIX = '----CloudMailExport';

const emlService = {

	/**
	 * Build .eml content for a single email.
	 * @param {object} c   Hono context
	 * @param {number} emailId
	 * @returns {string} RFC 5322 MIME content
	 */
	async buildEml(c, emailId) {

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, emailId)).get();
		if (!emailRow) throw new Error('Email not found');

		const attachments = await orm(c).select().from(att).where(eq(att.emailId, emailId)).all();

		const hasAttachments = attachments.length > 0;
		const hasHtml = !!emailRow.content;
		const hasText = !!emailRow.text;
		const isMultipart = hasAttachments || (hasHtml && hasText);

		const boundary = `${BOUNDARY_PREFIX}${Date.now()}`;
		const altBoundary = `${BOUNDARY_PREFIX}Alt${Date.now()}`;

		const headers = [];
		const date = emailRow.createTime ? new Date(emailRow.createTime + 'Z') : new Date();

		// From
		if (emailRow.name && emailRow.sendEmail) {
			headers.push(`From: ${emailRow.name} <${emailRow.sendEmail}>`);
		} else if (emailRow.sendEmail) {
			headers.push(`From: ${emailRow.sendEmail}`);
		}

		// To
		const recipients = this._parseRecipients(emailRow.recipient);
		if (recipients.length > 0) {
			headers.push(`To: ${recipients.join(', ')}`);
		} else if (emailRow.toEmail) {
			headers.push(`To: ${emailRow.toEmail}`);
		}

		// CC / BCC
		const cc = this._parseRecipients(emailRow.cc);
		if (cc.length > 0) headers.push(`Cc: ${cc.join(', ')}`);
		const bcc = this._parseRecipients(emailRow.bcc);
		if (bcc.length > 0) headers.push(`Bcc: ${bcc.join(', ')}`);

		// Standard headers
		headers.push(`Subject: ${this._encodeSubject(emailRow.subject || '')}`);
		headers.push(`Date: ${date.toUTCString()}`);
		headers.push(`MIME-Version: 1.0`);

		if (emailRow.messageId) {
			headers.push(`Message-ID: ${emailRow.messageId}`);
		}
		if (emailRow.inReplyTo) {
			headers.push(`In-Reply-To: ${emailRow.inReplyTo}`);
		}

		// Content-Type
		if (isMultipart) {
			headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		} else if (hasHtml) {
			headers.push(`Content-Type: text/html; charset=utf-8`);
			headers.push(`Content-Transfer-Encoding: base64`);
		} else {
			headers.push(`Content-Type: text/plain; charset=utf-8`);
			headers.push(`Content-Transfer-Encoding: base64`);
		}

		const parts = [];
		parts.push(headers.join('\r\n'));
		parts.push('');

		if (!isMultipart) {
			// Simple message
			const body = hasHtml ? emailRow.content : (emailRow.text || '');
			parts.push(this._toBase64Lines(body));
		} else {
			// Multipart
			// Text + HTML alternative
			if (hasHtml || hasText) {
				parts.push(`--${boundary}`);
				if (hasHtml && hasText) {
					parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
					parts.push('');
					parts.push(`--${altBoundary}`);
					parts.push('Content-Type: text/plain; charset=utf-8');
					parts.push('Content-Transfer-Encoding: base64');
					parts.push('');
					parts.push(this._toBase64Lines(emailRow.text));
					parts.push(`--${altBoundary}`);
					parts.push('Content-Type: text/html; charset=utf-8');
					parts.push('Content-Transfer-Encoding: base64');
					parts.push('');
					parts.push(this._toBase64Lines(emailRow.content));
					parts.push(`--${altBoundary}--`);
				} else if (hasHtml) {
					parts.push('Content-Type: text/html; charset=utf-8');
					parts.push('Content-Transfer-Encoding: base64');
					parts.push('');
					parts.push(this._toBase64Lines(emailRow.content));
				} else {
					parts.push('Content-Type: text/plain; charset=utf-8');
					parts.push('Content-Transfer-Encoding: base64');
					parts.push('');
					parts.push(this._toBase64Lines(emailRow.text));
				}
			}

			// Attachments
			for (const attRow of attachments) {
				let attContent = null;
				try {
					const obj = await r2Service.getObj(c, attRow.key);
					if (obj) {
						const buf = await obj.arrayBuffer();
						attContent = this._arrayBufferToBase64(buf);
					}
				} catch (e) {
					console.error(`[eml-export] failed to fetch attachment ${attRow.key}: ${e.message}`);
					continue;
				}

				if (!attContent) continue;

				parts.push(`--${boundary}`);
				const mimeType = attRow.mimeType || 'application/octet-stream';
				const filename = attRow.filename || 'attachment';

				if (attRow.contentId) {
					parts.push(`Content-Type: ${mimeType}; name="${filename}"`);
					parts.push(`Content-Disposition: inline; filename="${filename}"`);
					parts.push(`Content-Transfer-Encoding: base64`);
					parts.push(`Content-ID: <${attRow.contentId.replace(/^<|>$/g, '')}>`);
				} else {
					parts.push(`Content-Type: ${mimeType}; name="${filename}"`);
					parts.push(`Content-Disposition: attachment; filename="${filename}"`);
					parts.push(`Content-Transfer-Encoding: base64`);
				}
				parts.push('');
				parts.push(this._splitBase64(attContent));
			}

			parts.push(`--${boundary}--`);
		}

		return parts.join('\r\n');
	},

	_parseRecipients(jsonStr) {
		if (!jsonStr) return [];
		try {
			const arr = JSON.parse(jsonStr);
			return arr.map(r => {
				if (r.name) return `${r.name} <${r.address}>`;
				return r.address;
			}).filter(Boolean);
		} catch {
			return [];
		}
	},

	_encodeSubject(subject) {
		if (/^[\x20-\x7E]*$/.test(subject)) return subject;
		return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
	},

	_toBase64Lines(text) {
		if (!text) return '';
		const b64 = btoa(unescape(encodeURIComponent(text)));
		return this._splitBase64(b64);
	},

	_splitBase64(b64) {
		const lines = [];
		for (let i = 0; i < b64.length; i += 76) {
			lines.push(b64.slice(i, i + 76));
		}
		return lines.join('\r\n');
	},

	_arrayBufferToBase64(buffer) {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}
};

export default emlService;
