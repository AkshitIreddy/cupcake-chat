import { Type, type Static } from '@sinclair/typebox';
import { ModelSelection } from './models.js';
import {
  ArtifactId,
  BranchId,
  ByteCount,
  ConversationId,
  FileId,
  JsonObject,
  MemoryId,
  MessageId,
  MimeType,
  Nullable,
  ProjectId,
  Provenance,
  RevisionId,
  RunId,
  Sha256,
  StrictObject,
  TaskId,
  UtcTimestamp,
} from './primitives.js';

export const Project = StrictObject(
  {
    id: ProjectId,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    archivedAt: Type.Optional(Nullable(UtcTimestamp)),
    defaultModel: Type.Optional(ModelSelection),
    rootHandles: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { uniqueItems: true }),
    readOnlyByDefault: Type.Boolean(),
    instructions: Type.Optional(Type.String({ maxLength: 32_768 })),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/project.schema.json' },
);

export const ContentBlock = Type.Union([
  StrictObject({ type: Type.Literal('text'), text: Type.String({ maxLength: 2_000_000 }) }),
  StrictObject({
    type: Type.Literal('code'),
    language: Type.Optional(Type.String({ maxLength: 64 })),
    code: Type.String({ maxLength: 2_000_000 }),
  }),
  StrictObject({
    type: Type.Literal('file'),
    fileId: FileId,
    label: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  StrictObject({
    type: Type.Literal('artifact'),
    artifactId: ArtifactId,
    revisionId: RevisionId,
    label: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  StrictObject({
    type: Type.Literal('citation'),
    fileId: Type.Optional(FileId),
    url: Type.Optional(Type.String({ format: 'uri', maxLength: 4096 })),
    locator: Type.String({ minLength: 1, maxLength: 2048 }),
    label: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  StrictObject({
    type: Type.Literal('tool'),
    toolIntentId: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  StrictObject({ type: Type.Literal('task'), taskId: TaskId }),
  StrictObject({
    type: Type.Literal('memory-notice'),
    memoryId: MemoryId,
    action: Type.Union([
      Type.Literal('added'),
      Type.Literal('updated'),
      Type.Literal('removed'),
      Type.Literal('suggested'),
    ]),
  }),
]);

export const Message = StrictObject(
  {
    id: MessageId,
    conversationId: ConversationId,
    branchId: BranchId,
    parentMessageId: Type.Optional(Nullable(MessageId)),
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system')]),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('streaming'),
      Type.Literal('completed'),
      Type.Literal('stopped'),
      Type.Literal('failed'),
      Type.Literal('superseded'),
    ]),
    content: Type.Array(ContentBlock, { maxItems: 10_000 }),
    createdAt: UtcTimestamp,
    completedAt: Type.Optional(Nullable(UtcTimestamp)),
    runId: Type.Optional(RunId),
    model: Type.Optional(ModelSelection),
    providerContinuityToken: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    tokenUsage: Type.Optional(
      StrictObject({
        input: Type.Integer({ minimum: 0 }),
        cachedInput: Type.Integer({ minimum: 0 }),
        output: Type.Integer({ minimum: 0 }),
      }),
    ),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/message.schema.json' },
);

export const ConversationBranch = StrictObject(
  {
    id: BranchId,
    conversationId: ConversationId,
    parentBranchId: Type.Optional(Nullable(BranchId)),
    forkedFromMessageId: Type.Optional(Nullable(MessageId)),
    headMessageId: Type.Optional(Nullable(MessageId)),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    createdAt: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/conversation-branch.schema.json' },
);

export const Conversation = StrictObject(
  {
    id: ConversationId,
    projectId: Type.Optional(Nullable(ProjectId)),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    activeBranchId: BranchId,
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    archivedAt: Type.Optional(Nullable(UtcTimestamp)),
    pinnedAt: Type.Optional(Nullable(UtcTimestamp)),
    model: ModelSelection,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/conversation.schema.json' },
);

export const FileLocator = Type.Union([
  StrictObject({
    kind: Type.Literal('page'),
    page: Type.Integer({ minimum: 1 }),
    boundingBox: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
    ),
  }),
  StrictObject({
    kind: Type.Literal('cell-range'),
    sheet: Type.String({ minLength: 1, maxLength: 255 }),
    range: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  StrictObject({
    kind: Type.Literal('line-range'),
    start: Type.Integer({ minimum: 1 }),
    end: Type.Integer({ minimum: 1 }),
  }),
  StrictObject({
    kind: Type.Literal('archive-entry'),
    entry: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  StrictObject({
    kind: Type.Literal('media-time'),
    startMs: Type.Integer({ minimum: 0 }),
    endMs: Type.Integer({ minimum: 0 }),
  }),
  StrictObject({
    kind: Type.Literal('section'),
    heading: Type.String({ minLength: 1, maxLength: 1024 }),
    ordinal: Type.Integer({ minimum: 0 }),
  }),
]);

export const FileRecord = StrictObject(
  {
    id: FileId,
    projectId: Type.Optional(Nullable(ProjectId)),
    displayName: Type.String({ minLength: 1, maxLength: 512 }),
    sourceHandle: Type.String({ minLength: 1, maxLength: 512 }),
    mimeType: MimeType,
    byteSize: ByteCount,
    contentSha256: Sha256,
    modifiedAt: UtcTimestamp,
    destination: Type.Union([Type.Literal('local'), Type.Literal('cloud')]),
    ingestion: Type.Union([
      StrictObject({ state: Type.Literal('pending') }),
      StrictObject({
        state: Type.Literal('parsing'),
        progress: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      StrictObject({
        state: Type.Literal('indexed'),
        indexedAt: UtcTimestamp,
        chunkCount: Type.Integer({ minimum: 0 }),
      }),
      StrictObject({
        state: Type.Literal('unsupported'),
        reason: Type.String({ minLength: 1, maxLength: 2048 }),
      }),
      StrictObject({
        state: Type.Literal('failed'),
        reason: Type.String({ minLength: 1, maxLength: 2048 }),
        retryable: Type.Boolean(),
      }),
    ]),
    provenance: Provenance,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/file-record.schema.json' },
);

export const ArtifactKind = Type.Union([
  Type.Literal('document'),
  Type.Literal('code'),
  Type.Literal('configuration'),
  Type.Literal('table'),
  Type.Literal('spreadsheet'),
  Type.Literal('image'),
  Type.Literal('diagram'),
  Type.Literal('webpage'),
  Type.Literal('report'),
]);

export const Artifact = StrictObject(
  {
    id: ArtifactId,
    projectId: Type.Optional(Nullable(ProjectId)),
    conversationId: ConversationId,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    kind: ArtifactKind,
    currentRevisionId: RevisionId,
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/artifact.schema.json' },
);

export const ArtifactRevision = StrictObject(
  {
    id: RevisionId,
    artifactId: ArtifactId,
    parentRevisionId: Type.Optional(Nullable(RevisionId)),
    contentObjectSha256: Sha256,
    mimeType: MimeType,
    byteSize: ByteCount,
    summary: Type.Optional(Type.String({ maxLength: 4096 })),
    createdAt: UtcTimestamp,
    provenance: Provenance,
    metadata: Type.Optional(JsonObject),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/artifact-revision.schema.json' },
);

export type Project = Static<typeof Project>;
export type ContentBlock = Static<typeof ContentBlock>;
export type Message = Static<typeof Message>;
export type ConversationBranch = Static<typeof ConversationBranch>;
export type Conversation = Static<typeof Conversation>;
export type FileLocator = Static<typeof FileLocator>;
export type FileRecord = Static<typeof FileRecord>;
export type Artifact = Static<typeof Artifact>;
export type ArtifactRevision = Static<typeof ArtifactRevision>;
