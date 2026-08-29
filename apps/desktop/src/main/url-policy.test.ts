import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl, normalizeExternalUrl } from './url-policy';

describe('renderer origin policy', () => {
  it('accepts only the packaged application host', () => {
    expect(isTrustedRendererUrl('cupcake://app/')).toBe(true);
    expect(isTrustedRendererUrl('cupcake://app/assets/main.js')).toBe(true);
    expect(isTrustedRendererUrl('cupcake://evil/')).toBe(false);
    expect(isTrustedRendererUrl('file:///tmp/index.html')).toBe(false);
  });

  it('allows the exact development origin only when explicitly enabled', () => {
    const dev = 'http://localhost:5173';
    expect(isTrustedRendererUrl('http://localhost:5173/src/main.tsx', dev, true)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', dev, true)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173.evil.test/', dev, true)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', dev, false)).toBe(false);
  });
});

describe('external navigation policy', () => {
  it('allows ordinary web links without credentials', () => {
    expect(normalizeExternalUrl('https://example.com/docs?q=1')).toBe(
      'https://example.com/docs?q=1',
    );
    expect(normalizeExternalUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
  });

  it('rejects executable, local, credential-bearing, and malformed URLs', () => {
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeExternalUrl('cupcake://app/')).toBeNull();
    expect(normalizeExternalUrl('https://user:secret@example.com/')).toBeNull();
    expect(normalizeExternalUrl('not a url')).toBeNull();
  });
});
