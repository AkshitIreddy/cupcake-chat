import { Type, type Static } from '@sinclair/typebox';
import {
  BranchId,
  ConversationId,
  JsonObject,
  Nullable,
  ProjectId,
  RunId,
  StrictObject,
  TaskId,
  UtcTimestamp,
} from './primitives.js';

export const TaskState = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('waiting-for-approval'),
  Type.Literal('waiting-for-input'),
  Type.Literal('pausing'),
  Type.Literal('paused'),
  Type.Literal('cancelling'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
  Type.Literal('completed'),
]);

export const TaskProgress = StrictObject({
  completedUnits: Type.Integer({ minimum: 0 }),
  totalUnits: Type.Optional(Type.Integer({ minimum: 1 })),
  label: Type.Optional(Type.String({ maxLength: 512 })),
});

export const TaskRecord = StrictObject(
  {
    id: TaskId,
    parentTaskId: Type.Optional(Nullable(TaskId)),
    runId: RunId,
    projectId: Type.Optional(Nullable(ProjectId)),
    conversationId: ConversationId,
    branchId: BranchId,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    state: TaskState,
    promotionReason: Type.Union([
      Type.Literal('explicit'),
      Type.Literal('estimated-duration'),
      Type.Literal('repository-indexing'),
      Type.Literal('document-indexing'),
      Type.Literal('code-execution'),
      Type.Literal('artifact-generation'),
      Type.Literal('multi-stage-tools'),
    ]),
    progress: TaskProgress,
    checkpointVersion: Type.String({ minLength: 1, maxLength: 128 }),
    checkpointId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    attempt: Type.Integer({ minimum: 1 }),
    maximumAttempts: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestamp,
    startedAt: Type.Optional(Nullable(UtcTimestamp)),
    finishedAt: Type.Optional(Nullable(UtcTimestamp)),
    lastHeartbeatAt: Type.Optional(Nullable(UtcTimestamp)),
    error: Type.Optional(
      StrictObject({
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1, maxLength: 4096 }),
        retryable: Type.Boolean(),
      }),
    ),
    metadata: Type.Optional(JsonObject),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/task-record.schema.json' },
);

export const TaskCommand = Type.Union(
  [
    StrictObject({ command: Type.Literal('pause'), taskId: TaskId, requestedAt: UtcTimestamp }),
    StrictObject({ command: Type.Literal('resume'), taskId: TaskId, requestedAt: UtcTimestamp }),
    StrictObject({
      command: Type.Literal('cancel'),
      taskId: TaskId,
      requestedAt: UtcTimestamp,
      reason: Type.Optional(Type.String({ maxLength: 2048 })),
    }),
    StrictObject({ command: Type.Literal('retry'), taskId: TaskId, requestedAt: UtcTimestamp }),
    StrictObject({
      command: Type.Literal('steer'),
      taskId: TaskId,
      requestedAt: UtcTimestamp,
      message: Type.String({ minLength: 1, maxLength: 32_768 }),
    }),
  ],
  { $id: 'https://schemas.cupcakeagi.local/v1/task-command.schema.json' },
);

export const SubagentRecord = StrictObject({
  taskId: TaskId,
  parentTaskId: TaskId,
  role: Type.Union([
    Type.Literal('researcher'),
    Type.Literal('coder'),
    Type.Literal('reviewer'),
    Type.Literal('document-analyst'),
  ]),
  state: TaskState,
  modelBudgetTokens: Type.Integer({ minimum: 0 }),
  toolBudget: Type.Integer({ minimum: 0 }),
  summary: Type.Optional(Type.String({ maxLength: 4096 })),
});

export type TaskState = Static<typeof TaskState>;
export type TaskRecord = Static<typeof TaskRecord>;
export type TaskCommand = Static<typeof TaskCommand>;
export type SubagentRecord = Static<typeof SubagentRecord>;
