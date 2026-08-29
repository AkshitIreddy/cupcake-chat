import { Type, type Static } from '@sinclair/typebox';
import {
  ConversationId,
  JsonObject,
  MemoryId,
  MessageId,
  Nullable,
  ProjectId,
  Provenance,
  RevisionId,
  StrictObject,
  UnitInterval,
  UtcTimestamp,
} from './primitives.js';

export const MemoryKind = Type.Union([
  Type.Literal('preference'),
  Type.Literal('fact'),
  Type.Literal('instruction'),
  Type.Literal('decision'),
  Type.Literal('event'),
  Type.Literal('task-state'),
  Type.Literal('temporary-context'),
]);

export const MemoryScope = Type.Union([
  StrictObject({ kind: Type.Literal('global') }),
  StrictObject({ kind: Type.Literal('project'), projectId: ProjectId }),
  StrictObject({ kind: Type.Literal('conversation'), conversationId: ConversationId }),
]);

export const MemoryEvidence = StrictObject({
  conversationId: Type.Optional(ConversationId),
  messageId: Type.Optional(MessageId),
  excerpt: Type.String({ minLength: 1, maxLength: 4096 }),
  observedAt: UtcTimestamp,
});

export const MemoryRecord = StrictObject(
  {
    id: MemoryId,
    kind: MemoryKind,
    scope: MemoryScope,
    content: Type.String({ minLength: 1, maxLength: 32_768 }),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('candidate'),
      Type.Literal('superseded'),
      Type.Literal('expired'),
      Type.Literal('tombstoned'),
    ]),
    sensitivity: Type.Union([
      Type.Literal('ordinary'),
      Type.Literal('personal'),
      Type.Literal('sensitive'),
    ]),
    confidence: UnitInterval,
    explicit: Type.Boolean(),
    revisionId: RevisionId,
    supersedesRevisionId: Type.Optional(Nullable(RevisionId)),
    evidence: Type.Array(MemoryEvidence, { maxItems: 100 }),
    provenance: Provenance,
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    expiresAt: Type.Optional(Nullable(UtcTimestamp)),
    tombstonedAt: Type.Optional(Nullable(UtcTimestamp)),
    metadata: Type.Optional(JsonObject),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/memory-record.schema.json' },
);

export const MemoryMutation = Type.Union(
  [
    StrictObject({ action: Type.Literal('create'), record: MemoryRecord }),
    StrictObject({
      action: Type.Literal('confirm-candidate'),
      memoryId: MemoryId,
      expectedRevisionId: RevisionId,
      decidedAt: UtcTimestamp,
    }),
    StrictObject({
      action: Type.Literal('reject-candidate'),
      memoryId: MemoryId,
      expectedRevisionId: RevisionId,
      decidedAt: UtcTimestamp,
    }),
    StrictObject({
      action: Type.Literal('tombstone'),
      memoryId: MemoryId,
      expectedRevisionId: RevisionId,
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
      decidedAt: UtcTimestamp,
    }),
  ],
  { $id: 'https://schemas.cupcakeagi.local/v1/memory-mutation.schema.json' },
);

export type MemoryKind = Static<typeof MemoryKind>;
export type MemoryScope = Static<typeof MemoryScope>;
export type MemoryRecord = Static<typeof MemoryRecord>;
export type MemoryMutation = Static<typeof MemoryMutation>;
