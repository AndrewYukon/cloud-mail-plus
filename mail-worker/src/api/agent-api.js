import app from '../hono/hono';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import result from '../model/result';
import { streamText, stepCountIs } from 'ai';
import { buildTools, executeConfirmedTool } from '../agent/tools';
import { buildSystemPrompt } from '../agent/system-prompt';
import { resolveLanguageModel, fetchAvailableModels, testModelConnectivity, maskApiKey } from '../agent/provider';

// ---- chat: AI SDK v6 streaming, direct (no DO routing — protocol mismatch with AIChatAgent) ----
app.post('/agent/chat', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const user = await userService.findById(c, userId);
  if (!user?.agentEnabled) return c.json(result.fail('agent-disabled'), 403);

  const provider = user.agentProvider || 'workers-ai';
  if (provider === 'workers-ai' && !c.env.AI) {
    return c.json(result.fail('AI binding not configured on this Worker'), 503);
  }

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

  let model;
  try {
    model = resolveLanguageModel(c, user);
  } catch (err) {
    console.error('[agent/chat] resolveLanguageModel error:', err?.message);
    return c.json(result.fail('model-resolve-failed: ' + err?.message), 400);
  }

  const tools = buildTools({ env: c.env, userId, userEmail: user.email, user });

  try {
    const stream = streamText({
      model,
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
    agentProvider: u?.agentProvider || 'workers-ai',
    agentCfAccountId: u?.agentCfAccountId || '',
    agentAiGatewayId: u?.agentAiGatewayId || '',
    agentGatewayProvider: u?.agentGatewayProvider || 'openai',
    agentBaseUrl: u?.agentBaseUrl || '',
    agentApiKeyMasked: maskApiKey(u?.agentApiKey),
    hasApiKey: !!u?.agentApiKey,
    agentModel: u?.agentModel || '',
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

  const body = await c.req.json().catch(() => ({}));
  const {
    agentEnabled,
    agentAutoDraft,
    agentPersona,
    agentProvider,
    agentCfAccountId,
    agentAiGatewayId,
    agentGatewayProvider,
    agentBaseUrl,
    agentApiKey,
    agentModel,
  } = body;

  const updatePayload = {};
  if ('agentEnabled' in body) updatePayload.agentEnabled = body.agentEnabled ? 1 : 0;
  if ('agentAutoDraft' in body) updatePayload.agentAutoDraft = body.agentAutoDraft ? 1 : 0;
  if ('agentPersona' in body) updatePayload.agentPersona = (body.agentPersona || '').slice(0, 4000);
  if ('agentProvider' in body) updatePayload.agentProvider = body.agentProvider || 'workers-ai';
  if ('agentCfAccountId' in body) updatePayload.agentCfAccountId = (body.agentCfAccountId || '').trim();
  if ('agentAiGatewayId' in body) updatePayload.agentAiGatewayId = (body.agentAiGatewayId || '').trim();
  if ('agentGatewayProvider' in body) updatePayload.agentGatewayProvider = (body.agentGatewayProvider || 'openai').trim();
  if ('agentBaseUrl' in body) updatePayload.agentBaseUrl = (body.agentBaseUrl || '').trim();
  if ('agentModel' in body) updatePayload.agentModel = (body.agentModel || '').trim();

  // Support clearing key: empty string or null explicitly clears saved key
  if ('agentApiKey' in body) {
    if (body.agentApiKey === '' || body.agentApiKey === null) {
      updatePayload.agentApiKey = '';
    } else if (typeof body.agentApiKey === 'string' && body.agentApiKey.trim() !== '' && !body.agentApiKey.includes('****')) {
      updatePayload.agentApiKey = body.agentApiKey.trim();
    }
  }

  await userService.updateAgentSettings(c, userId, updatePayload);
  return c.json(result.ok({}));
});

app.post('/agent/models', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const u = await userService.findById(c, userId);
  const body = await c.req.json().catch(() => ({}));

  const provider = body.provider || u?.agentProvider || 'workers-ai';
  const cfAccountId = body.cfAccountId ?? u?.agentCfAccountId;
  const aiGatewayId = body.aiGatewayId ?? u?.agentAiGatewayId;
  const gatewayProvider = body.gatewayProvider ?? u?.agentGatewayProvider;
  const baseUrl = body.baseUrl ?? u?.agentBaseUrl;
  const apiKey = body.apiKey;

  // Security: only reuse savedApiKey if endpoint/provider matches what is stored in DB
  const isSameEndpoint = provider === (u?.agentProvider || 'workers-ai') &&
    (baseUrl || '').trim() === (u?.agentBaseUrl || '').trim() &&
    (aiGatewayId || '').trim() === (u?.agentAiGatewayId || '').trim() &&
    (cfAccountId || '').trim() === (u?.agentCfAccountId || '').trim();
  const savedApiKey = isSameEndpoint ? u?.agentApiKey : undefined;

  try {
    const models = await fetchAvailableModels({
      provider,
      cfAccountId,
      aiGatewayId,
      gatewayProvider,
      baseUrl,
      apiKey,
      savedApiKey,
    });
    return c.json(result.ok(models));
  } catch (err) {
    console.error('[agent/models] failed to fetch models:', err);
    return c.json(result.fail(err.message || 'Failed to fetch models'), 400);
  }
});

app.post('/agent/test', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const u = await userService.findById(c, userId);
  const body = await c.req.json().catch(() => ({}));

  const provider = body.provider || u?.agentProvider || 'workers-ai';
  const cfAccountId = body.cfAccountId ?? u?.agentCfAccountId;
  const aiGatewayId = body.aiGatewayId ?? u?.agentAiGatewayId;
  const gatewayProvider = body.gatewayProvider ?? u?.agentGatewayProvider;
  const baseUrl = body.baseUrl ?? u?.agentBaseUrl;
  const apiKey = body.apiKey;

  // Security: only reuse savedApiKey if endpoint/provider matches what is stored in DB
  const isSameEndpoint = provider === (u?.agentProvider || 'workers-ai') &&
    (baseUrl || '').trim() === (u?.agentBaseUrl || '').trim() &&
    (aiGatewayId || '').trim() === (u?.agentAiGatewayId || '').trim() &&
    (cfAccountId || '').trim() === (u?.agentCfAccountId || '').trim();
  const savedApiKey = isSameEndpoint ? u?.agentApiKey : undefined;
  const model = (body.model || body.agentModel || u?.agentModel || '').trim();

  try {
    const testRes = await testModelConnectivity(c, {
      provider,
      cfAccountId,
      aiGatewayId,
      gatewayProvider,
      baseUrl,
      apiKey,
      savedApiKey,
      model,
    });
    return c.json(result.ok(testRes));
  } catch (err) {
    console.error('[agent/test] connectivity test failed:', err);
    return c.json(result.fail(err.message || '连接测试失败'), 400);
  }
});
