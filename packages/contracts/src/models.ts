import { Type, type Static } from '@sinclair/typebox';
import {
  CurrencyCode,
  DurationMs,
  JsonObject,
  Nullable,
  PrivacyRoute,
  StrictObject,
  UtcTimestamp,
} from './primitives.js';

export const ProviderKind = Type.Union([
  Type.Literal('openai'),
  Type.Literal('anthropic'),
  Type.Literal('gemini'),
  Type.Literal('xai'),
  Type.Literal('mistral'),
  Type.Literal('cohere'),
  Type.Literal('nvidia-nim'),
  Type.Literal('openai-compatible'),
  Type.Literal('cupcake-local'),
  Type.Literal('ollama'),
  Type.Literal('lm-studio'),
  Type.Literal('vllm'),
  Type.Literal('mock'),
]);

export const ReasoningLevel = Type.Union([
  Type.Literal('none'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
]);

export const ModelCapabilities = StrictObject({
  streaming: Type.Boolean(),
  toolCalling: Type.Boolean(),
  structuredOutput: Type.Boolean(),
  imageInput: Type.Boolean(),
  documentInput: Type.Boolean(),
  webSearch: Type.Boolean(),
  citations: Type.Boolean(),
  reasoning: Type.Boolean(),
  embeddings: Type.Boolean(),
});

export const TokenPricing = StrictObject({
  currency: CurrencyCode,
  inputPerMillion: Type.Number({ minimum: 0 }),
  cachedInputPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  outputPerMillion: Type.Number({ minimum: 0 }),
  provenanceUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 4096 })),
  checkedAt: UtcTimestamp,
});

export const ModelDescriptor = StrictObject(
  {
    id: Type.String({ minLength: 1, maxLength: 255 }),
    provider: ProviderKind,
    family: Type.String({ minLength: 1, maxLength: 255 }),
    displayName: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    capabilities: ModelCapabilities,
    reasoningLevels: Type.Array(ReasoningLevel, { uniqueItems: true, maxItems: 6 }),
    contextWindowTokens: Type.Integer({ minimum: 1 }),
    maximumOutputTokens: Type.Integer({ minimum: 1 }),
    privacyRoute: PrivacyRoute,
    speedClass: Type.Union([Type.Literal('fast'), Type.Literal('balanced'), Type.Literal('deep')]),
    costClass: Type.Union([
      Type.Literal('free'),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
    ]),
    pricing: Type.Optional(TokenPricing),
    lifecycle: Type.Union([
      Type.Literal('available'),
      Type.Literal('preview'),
      Type.Literal('deprecated'),
      Type.Literal('unavailable'),
    ]),
    metadata: Type.Optional(JsonObject),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/model-descriptor.schema.json' },
);

export const ProviderDescriptor = StrictObject(
  {
    id: ProviderKind,
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    privacyRoute: PrivacyRoute,
    authentication: Type.Union([
      Type.Literal('none'),
      Type.Literal('api-key'),
      Type.Literal('oauth-pkce'),
      Type.Literal('external-runtime'),
    ]),
    endpoint: Type.Optional(Type.String({ format: 'uri', maxLength: 4096 })),
    health: Type.Union([
      StrictObject({ state: Type.Literal('unknown') }),
      StrictObject({ state: Type.Literal('checking'), startedAt: UtcTimestamp }),
      StrictObject({
        state: Type.Literal('ready'),
        checkedAt: UtcTimestamp,
        latencyMs: DurationMs,
      }),
      StrictObject({
        state: Type.Literal('degraded'),
        checkedAt: UtcTimestamp,
        reason: Type.String({ minLength: 1, maxLength: 1024 }),
      }),
      StrictObject({
        state: Type.Literal('unavailable'),
        checkedAt: UtcTimestamp,
        reason: Type.String({ minLength: 1, maxLength: 1024 }),
      }),
    ]),
    credentialState: Type.Union([
      Type.Literal('not-required'),
      Type.Literal('missing'),
      Type.Literal('configured'),
      Type.Literal('invalid'),
    ]),
    modelCatalogEtag: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 512 }))),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/provider-descriptor.schema.json' },
);

export const ModelSelection = StrictObject({
  provider: ProviderKind,
  modelId: Type.String({ minLength: 1, maxLength: 255 }),
  reasoningLevel: ReasoningLevel,
  fallback: Type.Optional(
    StrictObject({
      enabled: Type.Boolean({ default: false }),
      provider: ProviderKind,
      modelId: Type.String({ minLength: 1, maxLength: 255 }),
      requiresBoundaryConfirmation: Type.Boolean(),
    }),
  ),
});

export type ProviderKind = Static<typeof ProviderKind>;
export type ModelDescriptor = Static<typeof ModelDescriptor>;
export type ProviderDescriptor = Static<typeof ProviderDescriptor>;
export type ModelSelection = Static<typeof ModelSelection>;
