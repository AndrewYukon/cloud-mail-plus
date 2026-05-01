import app from '../hono/hono';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import result from '../model/result';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { buildTools, executeConfirmedTool } from '../agent/tools';
import { buildSystemPrompt } from '../agent/system-prompt';

const MODEL_ID = '@cf/moonshotai/kimi-k2.5';

// ---- chat: AI SDK v6 streaming, direct (no DO routing — protocol mismatch with AIChatAgent) ----
app.post('/agent/chat', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const user = await userService.findById(c, userId);
  if (!user?.agentEnabled) return c.json(result.fail('agent-disabled'), 403);
  if (!c.env.AI) return c.json(result.fail('AI binding not configured on this Worker'), 503);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json(result.fail('invalid-body'), 400); }

  // Accept both shapes: UI messages array or already-converted model messages
  const uiMessages = Array.isArray(body?.messages) ? body.messages : [];
  console.log('[agent/chat] request body keys:', Object.keys(body || {}), 'msg count:', uiMessages.length);

  // Build ModelMessage[] manually — convertToModelMessages in AI SDK v6 produces
  // unexpected shapes for the @ai-sdk/vue Chat payload format on Workers runtime.
  const modelMessages = uiMessages.map(m => {
    const text = Array.isArray(m.parts)
      ? m.parts.filter(p => p?.type === 'text').map(p => p.text).join('\n')
      : (m.content || '');
    return { role: m.role || 'user', content: text };
  }).filter(m => m.content);

  if (modelMessages.length === 0) {
    return c.json(result.fail('no-messages-in-request'), 400);
  }

  // Diagnostic logs
  console.log('[agent/chat] model messages:', JSON.stringify(modelMessages).slice(0, 500));
  console.log('[agent/chat] is array:', Array.isArray(modelMessages), 'len:', modelMessages.length);

  const workersai = createWorkersAI({ binding: c.env.AI });
  const tools = buildTools({ env: c.env, userId, userEmail: user.email });

  try {
    const stream = streamText({
      model: workersai(MODEL_ID),
      system: buildSystemPrompt({
        userEmail: user.email,
        persona: user.agentPersona || '',
        currentBoxName: c.req.query('box') || 'inbox',
        locale: c.req.header('Accept-Language')?.split(',')[0] || 'en',
      }),
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(8),
      onError: (err) => {
        const msg = err?.error?.message || err?.message || JSON.stringify(err);
        console.error('[agent/chat] streamText onError:', msg);
        console.error('[agent/chat] stack:', err?.error?.stack || err?.stack);
      },
    });
    return stream.toUIMessageStreamResponse();
  } catch (err) {
    console.error('[agent/chat] outer catch:', err?.message, err?.stack);
    return c.json(result.fail('streamText-failed: ' + err?.message), 500);
  }
});

app.post('/agent/confirm', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const user = await userService.findById(c, userId);
  if (!user) return c.json(result.fail('user-not-found'), 404);
  const { name, args } = await c.req.json();
  if (!['sendDraft', 'deleteEmail'].includes(name)) return c.json(result.fail('unknown-tool'), 400);
  const r = await executeConfirmedTool({ env: c.env, userId, userEmail: user.email, name, args });
  return c.json(result.ok(r));
});

app.get('/agent/state', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  // Stateless for now — frontend Chat class keeps history in-memory.
  // Persistent history can be added later by reading from agent_message table.
  return c.json(result.ok({ messages: [] }));
});

app.get('/agent/settings', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const u = await userService.findById(c, userId);
  return c.json(result.ok({
    agentEnabled: !!u?.agentEnabled,
    agentAutoDraft: !!u?.agentAutoDraft,
    agentPersona: u?.agentPersona || '',
    bindingAvailable: !!c.env.EMAIL_AGENT,
  }));
});

app.post('/agent/clear', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  // Frontend handles its own in-memory clear; this is a no-op until D1 history is added.
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
