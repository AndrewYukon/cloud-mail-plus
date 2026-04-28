import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import starService from '../service/star-service';
import emlService from '../service/eml-service';
import { buildZip } from '../utils/zip-utils';
import orm from '../entity/orm';
import email from '../entity/email';
import { eq, and, inArray } from 'drizzle-orm';

app.get('/email/list', async (c) => {
	const data = await emailService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await emailService.latest(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

// Permanent delete — removes email + R2 attachments + stars (#293 + #318)
app.delete('/email/permanentDelete', async (c) => {
	const userId = userContext.getUserId(c);
	const { emailIds } = c.req.query();
	const emailIdList = emailIds.split(',').map(Number);

	// Verify ownership — only delete emails belonging to this user
	const userEmails = await orm(c).select({ emailId: email.emailId })
		.from(email)
		.where(and(eq(email.userId, userId), inArray(email.emailId, emailIdList)))
		.all();

	const ownedIds = userEmails.map(e => e.emailId);
	if (ownedIds.length === 0) {
		return c.json(result.ok());
	}

	await attService.removeByEmailIds(c, ownedIds);
	await starService.removeByEmailIds(c, ownedIds);
	await orm(c).delete(email).where(inArray(email.emailId, ownedIds)).run();

	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = await attService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
	const email = await emailService.send(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
})

// Export email as .eml file (#323)
app.get('/email/export', async (c) => {
	const userId = userContext.getUserId(c);
	const emailId = Number(c.req.query('emailId'));
	if (!emailId || isNaN(emailId)) {
		return c.json(result.fail('Invalid emailId'));
	}

	// Verify ownership
	const emailRow = await orm(c).select().from(email)
		.where(and(eq(email.emailId, emailId), eq(email.userId, userId))).get();
	if (!emailRow) {
		return c.json(result.fail('Email not found'));
	}

	const eml = await emlService.buildEml(c, emailId);
	return new Response(eml, {
		headers: {
			'Content-Type': 'message/rfc822',
			'Content-Disposition': `attachment; filename="email-${emailId}.eml"`,
		},
	});
})

// Batch export emails as zip (#323)
app.get('/email/batchExport', async (c) => {
	const userId = userContext.getUserId(c);
	const emailIdsStr = c.req.query('emailIds');
	if (!emailIdsStr) return c.json(result.fail('emailIds required'));

	const emailIds = emailIdsStr.split(',').map(Number).filter(id => !isNaN(id));
	if (emailIds.length === 0) return c.json(result.fail('No valid emailIds'));
	if (emailIds.length > 50) return c.json(result.fail('Maximum 50 emails per export'));

	// Verify ownership
	const owned = await orm(c).select({ emailId: email.emailId })
		.from(email)
		.where(and(eq(email.userId, userId), inArray(email.emailId, emailIds)))
		.all();
	const ownedIds = owned.map(e => e.emailId);
	if (ownedIds.length === 0) return c.json(result.fail('No emails found'));

	// Build a simple zip using raw zip format (no library needed)
	const files = [];
	for (const id of ownedIds) {
		try {
			const eml = await emlService.buildEml(c, id);
			files.push({ name: `email-${id}.eml`, data: new TextEncoder().encode(eml) });
		} catch (e) {
			console.error(`[batch-export] skip ${id}: ${e.message}`);
		}
	}

	if (files.length === 0) return c.json(result.fail('No emails could be exported'));

	const zip = buildZip(files);
	return new Response(zip, {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="emails-export.zip"`,
		},
	});
})

