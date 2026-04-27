import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import starService from '../service/star-service';
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

