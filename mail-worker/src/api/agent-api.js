import app from '../hono/hono';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import result from '../model/result';

// ---- chat: bridges browser <-> EmailAgent DO over SSE/streaming ----
app.post('/agent/chat', async (c) => {
  if (!c.env.EMAIL_AGENT) return c.json(result.fail('agent-binding-missing'), 503);
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const user = await userService.findById(c, userId);
  if (!user?.agentEnabled) return c.json(result.fail('agent-disabled'), 403);

  const stub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(`user-${userId}`));
  await stub.setContext({
    userId,
    userEmail: user.email,
    persona: user.agentPersona || '',
    currentBoxName: c.req.query('box') || 'inbox',
    locale: c.req.header('Accept-Language')?.split(',')[0] || 'en',
  });

  return stub.fetch(c.req.raw);
});

app.post('/agent/confirm', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const { name, args } = await c.req.json();
  if (!['sendDraft', 'deleteEmail'].includes(name)) return c.json(result.fail('unknown-tool'), 400);
  const stub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(`user-${userId}`));
  const r = await stub.runConfirmedTool({ name, args });
  return c.json(result.ok(r));
});

app.get('/agent/state', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  if (!c.env.EMAIL_AGENT) return c.json(result.ok({ messages: [] }));
  const stub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(`user-${userId}`));
  const messages = (await stub.getMessages?.()) ?? [];
  return c.json(result.ok({ messages }));
});

app.post('/agent/clear', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  if (!c.env.EMAIL_AGENT) return c.json(result.ok({}));
  const stub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(`user-${userId}`));
  await stub.clearHistory?.();
  return c.json(result.ok({}));
});

app.put('/agent/settings', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const { agentEnabled, agentAutoDraft, agentPersona } = await c.req.json();
  await userService.updateAgentSettings(c, userId, {
    agentEnabled: agentEnabled ? 1 : 0,
    agentAutoDraft: agentAutoDraft ? 1 : 0,
    agentPersona: (agentPersona || '').slice(0, 4000),
  });
  return c.json(result.ok({}));
});
