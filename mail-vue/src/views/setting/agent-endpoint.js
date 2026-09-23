// Pure helper functions for AI endpoint normalization and comparison on the frontend.
// Kept strictly in sync with mail-worker/src/agent/endpoint.js.

export function normalizeEndpoint(cfg = {}) {
  const provider = cfg.provider || cfg.agentProvider || 'workers-ai';
  if (provider === 'workers-ai') {
    return { provider: 'workers-ai' };
  }
  if (provider === 'cf-ai-gateway') {
    return {
      provider: 'cf-ai-gateway',
      cfAccountId: (cfg.cfAccountId ?? cfg.agentCfAccountId ?? '').trim(),
      aiGatewayId: (cfg.aiGatewayId ?? cfg.agentAiGatewayId ?? '').trim(),
      gatewayProvider: (cfg.gatewayProvider ?? cfg.agentGatewayProvider ?? 'openai').trim().toLowerCase(),
    };
  }
  if (provider === 'openai-compatible') {
    let baseUrl = (cfg.baseUrl ?? cfg.agentBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) baseUrl = 'https://api.openai.com/v1';
    return {
      provider: 'openai-compatible',
      baseUrl,
    };
  }
  return { provider };
}

export function isSameEndpoint(a = {}, b = {}) {
  const na = normalizeEndpoint(a);
  const nb = normalizeEndpoint(b);
  if (na.provider !== nb.provider) return false;
  if (na.provider === 'cf-ai-gateway') {
    return (
      na.cfAccountId === nb.cfAccountId &&
      na.aiGatewayId === nb.aiGatewayId &&
      na.gatewayProvider === nb.gatewayProvider
    );
  }
  if (na.provider === 'openai-compatible') {
    return na.baseUrl === nb.baseUrl;
  }
  return true;
}
