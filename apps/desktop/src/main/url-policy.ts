const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);

export function isTrustedRendererUrl(
  rawUrl: string,
  developmentServerUrl?: string,
  allowDevelopmentOrigin = false,
): boolean {
  try {
    const candidate = new URL(rawUrl);
    if (candidate.protocol === 'cupcake:' && candidate.hostname === 'app') return true;
    if (!developmentServerUrl || !allowDevelopmentOrigin) return false;
    return candidate.origin === new URL(developmentServerUrl).origin;
  } catch {
    return false;
  }
}

export function normalizeExternalUrl(rawUrl: string): string | null {
  if (rawUrl.length > 4096) return null;
  try {
    const candidate = new URL(rawUrl);
    if (!EXTERNAL_PROTOCOLS.has(candidate.protocol)) return null;
    if (candidate.username || candidate.password || !candidate.hostname) return null;
    return candidate.toString();
  } catch {
    return null;
  }
}
