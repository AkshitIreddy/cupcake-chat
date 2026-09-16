import { describe, expect, it } from 'vitest';
import { classifyProviderError } from './provider-errors';

describe('provider connection diagnostics', () => {
  it.each([
    'SECURE_REQUEST_FAILED: broker rejected a malformed or unauthenticated frame',
    'secure request failed: credential lease unavailable',
    'The credential vault could not save the API key',
  ])('does not blame working keys for an internal failure: %s', (message) => {
    expect(classifyProviderError(new Error(message)).title).toBe(
      'Cupcake could not complete the connection',
    );
  });
  it('keeps an explicit provider authentication error actionable', () => {
    expect(classifyProviderError('authentication_failed: Provider returned 401').title).toBe(
      'The credential was rejected',
    );
  });
  it('preserves rate limit codes', () => {
    expect(classifyProviderError('rate_limit: Provider returned 429')).toMatchObject({
      code: 'rate_limit',
      title: 'The provider is rate-limiting this test',
    });
  });
});
