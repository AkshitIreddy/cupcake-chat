import { Type, type Static, type TObject, type TProperties, type TSchema } from '@sinclair/typebox';

export const CONTRACT_VERSION = 1 as const;
export const MAX_PROTOCOL_FRAME_BYTES = 8 * 1024 * 1024;

export function StrictObject<T extends TProperties>(
  properties: T,
  options: Record<string, unknown> = {},
): TObject<T> {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

export const UuidV7 = Type.String({
  description: 'Lowercase RFC 9562 UUID version 7.',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const UtcTimestamp = Type.String({
  description: 'UTC RFC 3339 timestamp with a trailing Z.',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$',
});

export const Sha256 = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const MimeType = Type.String({
  minLength: 3,
  maxLength: 255,
  pattern: '^[^/\\s]+/[^/\\s]+$',
});
export const NonEmptyString = Type.String({ minLength: 1 });
export const BoundedString = Type.String({ minLength: 1, maxLength: 16_384 });
export const ByteCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const DurationMs = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const Sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const UnitInterval = Type.Number({ minimum: 0, maximum: 1 });
export const CurrencyCode = Type.String({ pattern: '^[A-Z]{3}$' });

export const JsonValue = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);

export const JsonObject = Type.Record(Type.String(), JsonValue);

export const ProductId = UuidV7;
export const ConversationId = UuidV7;
export const BranchId = UuidV7;
export const MessageId = UuidV7;
export const RunId = UuidV7;
export const TaskId = UuidV7;
export const ToolId = UuidV7;
export const ApprovalId = UuidV7;
export const ProjectId = UuidV7;
export const FileId = UuidV7;
export const MemoryId = UuidV7;
export const ArtifactId = UuidV7;
export const RevisionId = UuidV7;

export const PrivacyRoute = Type.Union([
  Type.Literal('local'),
  Type.Literal('direct-cloud'),
  Type.Literal('custom-endpoint'),
]);

export const Provenance = StrictObject({
  kind: Type.Union([
    Type.Literal('user'),
    Type.Literal('assistant'),
    Type.Literal('tool'),
    Type.Literal('import'),
    Type.Literal('system'),
  ]),
  sourceId: Type.Optional(UuidV7),
  sourceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  createdAt: UtcTimestamp,
});

export const PageCursor = Type.String({ minLength: 1, maxLength: 2048 });

export type JsonValue = Static<typeof JsonValue>;
export type Provenance = Static<typeof Provenance>;
