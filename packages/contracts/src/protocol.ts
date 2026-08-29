import { Type, type Static } from '@sinclair/typebox';
import {
  CONTRACT_VERSION,
  JsonObject,
  RunId,
  Sequence,
  StrictObject,
  TaskId,
  UtcTimestamp,
  UuidV7,
} from './primitives.js';

export const ProtocolMessageType = Type.Union([
  Type.Literal('handshake'),
  Type.Literal('request'),
  Type.Literal('response'),
  Type.Literal('event'),
  Type.Literal('cancel'),
  Type.Literal('ping'),
  Type.Literal('pong'),
  Type.Literal('shutdown'),
]);

export const ProtocolLineage = StrictObject({
  runId: Type.Optional(RunId),
  taskId: Type.Optional(TaskId),
  parentRunId: Type.Optional(RunId),
});

export const ProtocolEnvelope = StrictObject(
  {
    version: Type.Literal(CONTRACT_VERSION),
    messageId: UuidV7,
    correlationId: UuidV7,
    sessionId: UuidV7,
    sequence: Sequence,
    deadline: UtcTimestamp,
    lineage: ProtocolLineage,
    type: ProtocolMessageType,
    payload: JsonObject,
    authTag: Type.String({
      description: 'Base64url HMAC of the canonical envelope fields, excluding authTag.',
      pattern: '^[A-Za-z0-9_-]{43}$',
    }),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/protocol-envelope.schema.json' },
);

export type ProtocolMessageType = Static<typeof ProtocolMessageType>;
export type ProtocolLineage = Static<typeof ProtocolLineage>;
export type ProtocolEnvelope = Static<typeof ProtocolEnvelope>;
