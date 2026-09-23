import { describe, it, expect } from 'vitest';
import {
  normalizeEndpoint,
  isSameEndpoint,
  validateSafeEndpointUrl,
} from '../src/agent/endpoint.js';

describe('normalizeEndpoint', () => {
  it('defaults to workers-ai when empty or unspecified', () => {
    expect(normalizeEndpoint({})).toEqual({ provider: 'workers-ai' });
    expect(normalizeEndpoint({ provider: 'workers-ai' })).toEqual({ provider: 'workers-ai' });
  });

  it('normalizes openai-compatible and applies default baseUrl', () => {
    const res = normalizeEndpoint({ provider: 'openai-compatible' });
    expect(res).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('strips trailing slashes and trims baseUrl for openai-compatible', () => {
    const res = normalizeEndpoint({
      provider: 'openai-compatible',
      baseUrl: '  https://custom.api.com/v1///  ',
    });
    expect(res).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://custom.api.com/v1',
    });
  });

  it('normalizes cf-ai-gateway and ignores extraneous baseUrl', () => {
    const res = normalizeEndpoint({
      provider: 'cf-ai-gateway',
      cfAccountId: ' acc123 ',
      aiGatewayId: ' gw456 ',
      gatewayProvider: ' OPENAI ',
      baseUrl: 'https://ignored.com',
    });
    expect(res).toEqual({
      provider: 'cf-ai-gateway',
      cfAccountId: 'acc123',
      aiGatewayId: 'gw456',
      gatewayProvider: 'openai',
    });
  });
});

describe('isSameEndpoint', () => {
  it('recognizes identical workers-ai configs', () => {
    expect(isSameEndpoint({}, { provider: 'workers-ai' })).toBe(true);
    expect(isSameEndpoint({ provider: 'workers-ai' }, { provider: 'workers-ai' })).toBe(true);
  });

  it('detects provider change', () => {
    expect(isSameEndpoint({ provider: 'workers-ai' }, { provider: 'openai-compatible' })).toBe(false);
  });

  it('ignores stale baseUrl when in cf-ai-gateway mode', () => {
    const dbConfig = {
      provider: 'cf-ai-gateway',
      cfAccountId: 'acc1',
      aiGatewayId: 'gw1',
      gatewayProvider: 'openai',
      baseUrl: 'https://old-api.com',
    };
    const incomingConfig = {
      provider: 'cf-ai-gateway',
      cfAccountId: 'acc1',
      aiGatewayId: 'gw1',
      gatewayProvider: 'openai',
      baseUrl: '', // hidden/empty in UI
    };
    expect(isSameEndpoint(incomingConfig, dbConfig)).toBe(true);
  });

  it('handles openai-compatible default URL comparison', () => {
    const a = { provider: 'openai-compatible', baseUrl: '' };
    const b = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/' };
    expect(isSameEndpoint(a, b)).toBe(true);
  });

  it('detects changes in openai-compatible baseUrl', () => {
    const a = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };
    const b = { provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com' };
    expect(isSameEndpoint(a, b)).toBe(false);
  });
});

describe('validateSafeEndpointUrl', () => {
  it('accepts valid public https and http endpoints', () => {
    expect(validateSafeEndpointUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(validateSafeEndpointUrl('http://my-public-domain.com:8080/')).toBe('http://my-public-domain.com:8080');
  });

  it('rejects unsupported protocols', () => {
    expect(() => validateSafeEndpointUrl('ftp://example.com')).toThrow(/protocols are supported/);
    expect(() => validateSafeEndpointUrl('javascript:alert(1)')).toThrow();
  });

  it('blocks IPv6 loopback including brackets and IPv4-mapped IPv6', () => {
    expect(() => validateSafeEndpointUrl('http://[::1]:8080/v1')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('https://[::1]')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://[::ffff:127.0.0.1]:8080')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://[::ffff:10.0.0.1]')).toThrow(/prohibited/);
  });

  it('blocks IPv4 loopback and 127.0.0.0/8', () => {
    expect(() => validateSafeEndpointUrl('http://127.0.0.1:8080')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://127.0.0.2:8080')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://127.255.255.255')).toThrow(/prohibited/);
  });

  it('blocks private RFC1918 networks and CGNAT', () => {
    expect(() => validateSafeEndpointUrl('http://10.0.0.1')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://172.16.0.1')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://172.31.255.255')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://192.168.1.1')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://169.254.169.254')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://100.64.0.1')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://100.127.255.255')).toThrow(/prohibited/);
    expect(() => validateSafeEndpointUrl('http://0.0.0.0')).toThrow(/prohibited/);
  });
});
