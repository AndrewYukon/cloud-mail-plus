// Pure helper functions for AI endpoint normalization, comparison, and SSRF prevention.
// Zero external dependencies. Kept in sync with mail-vue/src/views/setting/agent-endpoint.js.

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
    throw new Error('Only http:// and https:// protocols are supported');
  }
  let hostname = parsed.hostname.toLowerCase();
  // Strip IPv6 enclosing brackets e.g. [::1] -> ::1
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  // Disallow loopback, private RFC1918, link-local, cloud metadata, CGNAT
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('0.') ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname === '::1' ||
    hostname.startsWith('::ffff:') || // IPv4-mapped IPv6 e.g. [::ffff:127.0.0.1]
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(hostname)
  ) {
    throw new Error('Access to private or local IP addresses is prohibited');
  }
  return parsed.toString().replace(/\/+$/, '');
}
