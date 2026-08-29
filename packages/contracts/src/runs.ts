import { Type, type Static } from '@sinclair/typebox';
import { ModelSelection } from './models.js';
import {
  ApprovalId,
  ArtifactId,
  BranchId,
  ConversationId,
  DurationMs,
  JsonObject,
  MessageId,
  Nullable,
  ProjectId,
  RevisionId,
  RunId,
  Sequence,
  StrictObject,
  TaskId,
  ToolId,
  UtcTimestamp,
} from './primitives.js';
import { SubagentRecord, TaskState } from './tasks.js';
import { ToolPreflight, ToolResult } from './tools.js';

export const UsageRecord = StrictObject({
  model: ModelSelection,
  inputTokens: Type.Integer({ minimum: 0 }),
  cachedInputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  costMicrounits: Type.Optional(Type.Integer({ minimum: 0 })),
  currency: Type.Optional(Type.String({ pattern: '^[A-Z]{3}$' })),
  latencyMs: DurationMs,
});

export const RunEventPayload = Type.Union([
  StrictObject({
    kind: Type.Literal('run-started'),
    model: ModelSelection,
    resumedFromCheckpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  }),
  StrictObject({
    kind: Type.Literal('message-started'),
    messageId: MessageId,
    role: Type.Literal('assistant'),
  }),
  StrictObject({
    kind: Type.Literal('message-delta'),
    messageId: MessageId,
    delta: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  }),
  StrictObject({
    kind: Type.Literal('message-completed'),
    messageId: MessageId,
    finishReason: Type.Union([
      Type.Literal('stop'),
      Type.Literal('length'),
      Type.Literal('tool-call'),
      Type.Literal('cancelled'),
      Type.Literal('error'),
    ]),
  }),
  StrictObject({ kind: Type.Literal('tool-preflight'), preflight: ToolPreflight }),
  StrictObject({ kind: Type.Literal('tool-started'), intentId: ToolId, startedAt: UtcTimestamp }),
  StrictObject({ kind: Type.Literal('tool-completed'), result: ToolResult }),
  StrictObject({
    kind: Type.Literal('approval-required'),
    approvalId: ApprovalId,
    preflight: ToolPreflight,
  }),
  StrictObject({
    kind: Type.Literal('approval-resolved'),
    approvalId: ApprovalId,
    decision: Type.Union([
      Type.Literal('approved'),
      Type.Literal('denied'),
      Type.Literal('expired'),
    ]),
  }),
  StrictObject({
    kind: Type.Literal('task-state'),
    taskId: TaskId,
    state: TaskState,
    detail: Type.Optional(Type.String({ maxLength: 2048 })),
  }),
  StrictObject({ kind: Type.Literal('subagent-state'), subagent: SubagentRecord }),
  StrictObject({
    kind: Type.Literal('artifact-created'),
    artifactId: ArtifactId,
    revisionId: RevisionId,
    title: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  StrictObject({
    kind: Type.Literal('artifact-revised'),
    artifactId: ArtifactId,
    revisionId: RevisionId,
    parentRevisionId: RevisionId,
  }),
  StrictObject({ kind: Type.Literal('usage'), usage: UsageRecord }),
  StrictObject({
    kind: Type.Literal('checkpoint'),
    checkpointId: Type.String({ minLength: 1, maxLength: 512 }),
    checkpointVersion: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  StrictObject({
    kind: Type.Literal('recovery'),
    state: Type.Union([
      Type.Literal('detected'),
      Type.Literal('resuming'),
      Type.Literal('recovered'),
      Type.Literal('incompatible'),
    ]),
    detail: Type.Optional(Type.String({ maxLength: 2048 })),
  }),
  StrictObject({
    kind: Type.Literal('error'),
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 4096 }),
    retryable: Type.Boolean(),
    details: Type.Optional(JsonObject),
  }),
  StrictObject({
    kind: Type.Literal('run-completed'),
    outcome: Type.Union([
      Type.Literal('completed'),
      Type.Literal('cancelled'),
      Type.Literal('failed'),
    ]),
  }),
]);

export const RunEvent = StrictObject(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    runId: RunId,
    taskId: Type.Optional(Nullable(TaskId)),
    projectId: Type.Optional(Nullable(ProjectId)),
    conversationId: ConversationId,
    branchId: BranchId,
    sequence: Sequence,
    occurredAt: UtcTimestamp,
    visibility: Type.Union([
      Type.Literal('user'),
      Type.Literal('developer'),
      Type.Literal('internal'),
    ]),
    event: RunEventPayload,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/run-event.schema.json' },
);

export type UsageRecord = Static<typeof UsageRecord>;
export type RunEventPayload = Static<typeof RunEventPayload>;
export type RunEvent = Static<typeof RunEvent>;
