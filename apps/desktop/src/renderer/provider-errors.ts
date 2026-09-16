export function classifyProviderError(reason: unknown): {
  title: string;
  detail: string;
  code?: string;
} {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Unknown provider error';
  const code = /^([a-z][a-z0-9_-]{2,}):\s*/i.exec(message)?.[1];
  // A broker protocol/vault error is not evidence that a provider rejected the key.
  if (
    /SECURE_REQUEST_FAILED|secure request failed|unauthenticated frame|malformed.*frame|credential (?:vault|store|storage|lease)|broker/i.test(
      message,
    )
  )
    return { title: 'Cupcake could not complete the connection', detail: message, code };
  if (
    /\b(?:401|403)\b|authentication_failed|invalid[_ -](?:api[_ -]?)?key|incorrect api key|(?:credential|api key).*(?:rejected|invalid)|unauthorized|forbidden/i.test(
      message,
    )
  )
    return {
      title: 'The credential was rejected',
      detail: message,
      code: code ?? 'AUTHENTICATION_FAILED',
    };
  if (/\b429\b|rate[_ -]?limit|quota/i.test(message))
    return {
      title: 'The provider is rate-limiting this test',
      detail: message,
      code: code ?? 'RATE_LIMITED',
    };
  if (/offline|network|dns|timeout|fetch|provider_unavailable|\b50[0234]\b/i.test(message))
    return {
      title: 'Cupcake could not reach the provider',
      detail: message,
      code: code ?? 'PROVIDER_OFFLINE',
    };
  return { title: 'The connection test did not complete', detail: message, code };
}
