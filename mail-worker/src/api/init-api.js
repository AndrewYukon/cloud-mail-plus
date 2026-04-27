import app from '../hono/hono';
import { dbInit } from '../init/init';
import userService from '../service/user-service';
import saltHashUtils from '../utils/crypto-utils';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';

app.get('/init/:secret', (c) => {
	return dbInit.init(c);
})

// Admin password reset (#292)
// Usage: POST /api/reset-admin/<jwt_secret> -d '{"password":"newpassword"}'
app.post('/reset-admin/:secret', async (c) => {
	const secret = c.req.param('secret');
	if (secret !== c.env.jwt_secret) {
		return c.text('unauthorized', 401);
	}

	const body = await c.req.json();
	const newPassword = body.password;

	if (!newPassword || newPassword.length < 6) {
		return c.json({ error: 'Password must be at least 6 characters' }, 400);
	}

	const adminEmail = c.env.admin;
	if (!adminEmail) {
		return c.json({ error: 'No admin email configured' }, 400);
	}

	const adminUser = await orm(c).select().from(user).where(eq(user.email, adminEmail)).get();
	if (!adminUser) {
		return c.json({ error: `Admin user '${adminEmail}' not found` }, 404);
	}

	const { salt, hash } = await saltHashUtils.hashPassword(newPassword);
	await orm(c).update(user).set({ password: hash, salt }).where(eq(user.userId, adminUser.userId)).run();

	return c.json({ success: true, email: adminEmail, message: 'Password reset successfully' });
})
