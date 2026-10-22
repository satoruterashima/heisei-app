import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../apps/api/src/index';

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /health', () => {
  it('returns the service identity and current timestamp as JSON', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'HEISEI API',
      timestamp: '2026-10-22T00:00:00.000Z',
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('responds to CORS preflight without requiring external services', async () => {
    const response = await app.request('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
