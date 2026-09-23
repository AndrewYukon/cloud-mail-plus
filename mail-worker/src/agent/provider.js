import { createWorkersAI } from 'workers-ai-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

export const DEFAULT_WORKERS_AI_MODEL = '@cf/moonshotai/kimi-k2.5';

export const WORKERS_AI_MODELS = [
  { id: '@cf/moonshotai/kimi-k2.5', name: 'Kimi K2.5 (推荐 · 默认)' },
  { id: '@cf/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fast', name: 'Llama 3.1 8B Instruct Fast' },
  { id: '@cf/qwen/qwen2.5-7b-instruct', name: 'Qwen 2.5 7B Instruct' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B' },
];

export function validateSafeEndpointUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Invalid endpoint URL');
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL format');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only https:// protocols are supported');
  }
  const hostname = parsed.hostname.toLowerCase();
  // Disallow loopback, private RFC1918, link-local, cloud metadata
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  ) {
    throw new Error('Access to private or local IP addresses is prohibited');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function buildAiGatewayBaseUrl(accountId, gatewayId, provider = 'openai') {
  const cleanAccount = (accountId || '').trim();
  const cleanGateway = (gatewayId || '').trim();
  let cleanProvider = (provider || 'openai').trim().toLowerCase();
  if (!cleanAccount || !cleanGateway) return '';
  if (cleanProvider === 'custom') {
    cleanProvider = 'custom-default';
  }
  return `https://gateway.ai.cloudflare.com/v1/${cleanAccount}/${cleanGateway}/${cleanProvider}`;
}

export function maskApiKey(key) {
  if (!key) return '';
  const str = String(key).trim();
  if (str.length <= 8) return '****';
  return `${str.slice(0, 3)}****${str.slice(-4)}`;
}

export function resolveLanguageModel(c, user = {}) {
  const provider = user.agentProvider || 'workers-ai';

  if (provider === 'workers-ai') {
    if (!c.env?.AI) {
      throw new Error('Cloudflare Workers AI binding [AI] not configured on this Worker');
    }
    const workersai = createWorkersAI({ binding: c.env.AI });
    const modelId = user.agentModel || DEFAULT_WORKERS_AI_MODEL;
    return workersai(modelId);
  }

  if (provider === 'cf-ai-gateway') {
    const accountId = user.agentCfAccountId;
    const gatewayId = user.agentAiGatewayId;
    const gatewayProvider = user.agentGatewayProvider || 'openai';
    const baseURL = buildAiGatewayBaseUrl(accountId, gatewayId, gatewayProvider);
    if (!baseURL) {
      throw new Error('Cloudflare AI Gateway Account ID and Gateway ID are required');
    }
    const apiKey = user.agentApiKey || '';
    const modelId = user.agentModel || (gatewayProvider === 'openai' ? 'gpt-4o-mini' : 'deepseek-chat');
    const openai = createOpenAI({
      baseURL,
      apiKey: apiKey || 'dummy-key-for-gateway',
    });
    return openai.chat(modelId);
  }

  if (provider === 'openai-compatible') {
    let baseURL = (user.agentBaseUrl || '').trim();
    if (!baseURL) {
      baseURL = 'https://api.openai.com/v1';
    }
    baseURL = validateSafeEndpointUrl(baseURL);
    const apiKey = user.agentApiKey || '';
    const modelId = user.agentModel || 'gpt-4o-mini';
    const openai = createOpenAI({
      baseURL,
      apiKey,
    });
    return openai.chat(modelId);
  }

  throw new Error(`Unsupported AI provider: ${provider}`);
}

export async function fetchAvailableModels({
  provider = 'workers-ai',
  cfAccountId,
  aiGatewayId,
  gatewayProvider = 'openai',
  baseUrl,
  apiKey,
  savedApiKey,
}) {
  const effectiveKey = (apiKey && !apiKey.includes('****')) ? apiKey : (savedApiKey || '');

  if (provider === 'workers-ai') {
    return WORKERS_AI_MODELS;
  }

  let targetBaseUrl = '';
  if (provider === 'cf-ai-gateway') {
    if (!cfAccountId || !aiGatewayId) {
      throw new Error('Account ID and Gateway ID are required to fetch models from AI Gateway');
    }
    targetBaseUrl = buildAiGatewayBaseUrl(cfAccountId, aiGatewayId, gatewayProvider);
  } else if (provider === 'openai-compatible') {
    const rawUrl = (baseUrl || 'https://api.openai.com/v1').trim();
    targetBaseUrl = validateSafeEndpointUrl(rawUrl);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  let modelsUrl = targetBaseUrl;
  if (!modelsUrl.endsWith('/models')) {
    modelsUrl = `${modelsUrl}/models`;
  }

  const headers = {};
  if (effectiveKey) {
    headers['Authorization'] = `Bearer ${effectiveKey}`;
  }

  const res = await fetch(modelsUrl, {
    method: 'GET',
    headers,
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Upstream provider error (HTTP ${res.status})`;
    try {
      const json = JSON.parse(errText);
      if (json?.error?.message) msg = json.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);

  const filtered = rawList.filter(item => {
    const id = (item?.id || item?.name || '').toLowerCase();
    if (!id) return false;
    if (id.includes('embed') || id.includes('whisper') || id.includes('tts') ||
        id.includes('dall-e') || id.includes('moderation') || id.includes('davinci') ||
        id.includes('babbage') || id.includes('curie') || id.includes('realtime') ||
        id.includes('transcription')) {
      return false;
    }
    return true;
  });

  const formatted = filtered.map(m => ({
    id: m.id || m.name,
    name: m.id || m.name,
  }));

  formatted.sort((a, b) => a.id.localeCompare(b.id));

  return formatted;
}

export async function testModelConnectivity(c, {
  provider = 'workers-ai',
  cfAccountId,
  aiGatewayId,
  gatewayProvider = 'openai',
  baseUrl,
  apiKey,
  savedApiKey,
  model,
}) {
  const effectiveKey = (apiKey && !apiKey.includes('****')) ? apiKey : (savedApiKey || '');

  const tempUser = {
    agentProvider: provider,
    agentCfAccountId: cfAccountId,
    agentAiGatewayId: aiGatewayId,
    agentGatewayProvider: gatewayProvider,
    agentBaseUrl: baseUrl,
    agentApiKey: effectiveKey,
    agentModel: model,
  };

  const modelInstance = resolveLanguageModel(c, tempUser);
  const startTime = Date.now();

  try {
    const { text } = await generateText({
      model: modelInstance,
      prompt: 'Ping! Please reply with 1 short sentence or "OK".',
      maxOutputTokens: 30,
      abortSignal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });

    const latencyMs = Date.now() - startTime;
    return {
      success: true,
      latencyMs,
      reply: (text || '').trim().slice(0, 100),
    };
  } catch (err) {
    let msg = err.message || String(err);
    if (err?.responseBody) {
      try {
        const parsed = JSON.parse(err.responseBody);
        if (typeof parsed?.error === 'string') {
          msg = parsed.error;
        } else if (parsed?.error?.message) {
          msg = parsed.error.message;
        } else if (Array.isArray(parsed?.error) && parsed.error[0]?.message) {
          msg = parsed.error[0].message;
        } else if (parsed?.message) {
          msg = parsed.message;
        } else if (parsed?.description) {
          msg = parsed.description;
        }
      } catch {}
    }
    if ((msg === 'AI_APICallError' || !msg) && err?.statusCode) {
      msg = `HTTP ${err.statusCode} from ${err.url || 'API'}`;
    }
    throw new Error(msg);
  }
}
