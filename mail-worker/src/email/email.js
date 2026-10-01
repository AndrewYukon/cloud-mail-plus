import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import { decideInboundFolder } from '../utils/folder-utils';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}


		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		// Plus-addressing fallback: strip "+suffix" so jane.doe+anything@domain
		// delivers into jane.doe@domain mailbox (Gmail/Outlook-style).
		if (!account) {
			const canonical = message.to.replace(/^([^@+]+)\+[^@]*@/, '$1@');
			if (canonical !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, canonical);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		// Folder routing: phishing-suspect -> Junk, DMARC reports -> Archive
		let folder = emailConst.folder.INBOX;

		if (account) {
			const decision = decideInboundFolder({
				fromAddress: email.from?.address || '',
				fromName: email.from?.name || '',
				recipient: account.email,
				subject: email.subject || '',
				html: email.html || '',
				text: email.text || '',
				authResults: message.headers?.get?.('authentication-results') || ''
			});
			folder = decision.folder;

			if (folder === emailConst.folder.JUNK) {
				console.warn(`[phish] → Junk for ${account.email} from ${email.from?.address}: ${decision.reasons.join(' | ')}`);
			} else if (folder === emailConst.folder.ARCHIVE) {
				console.warn(`[dmarc] → Archive for ${account.email} from ${email.from?.address}`);
			}
		}

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			folder: folder,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		// AI auto-draft hook (no-op if user has agent.autoDraft disabled or bindings missing)
		// Only for inbox mail: never draft replies to junk or archived reports
		if (folder === emailConst.folder.INBOX) {
			try {
				const { maybeAutoDraft } = await import('../agent/auto-draft.js');
				await maybeAutoDraft({ env, executionCtx: { waitUntil: (p) => p } }, { emailId: emailRow.emailId, userId: emailRow.userId });
			} catch (err) { console.error('[auto-draft hook]', err); }
		}

		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG（仅收件箱邮件：垃圾/归档不推送通知）
		if (folder === emailConst.folder.INBOX && tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱（垃圾邮件不转发；归档仍转发，转发是用户的显式配置）
		if (folder !== emailConst.folder.JUNK && forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}
