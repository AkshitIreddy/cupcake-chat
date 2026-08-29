import { Type, type Static } from '@sinclair/typebox';
import { ModelSelection } from './models.js';
import {
  ArtifactId,
  ConversationId,
  FileId,
  MemoryId,
  Nullable,
  PageCursor,
  ProjectId,
  StrictObject,
  TaskId,
  ToolId,
  UnitInterval,
  UtcTimestamp,
} from './primitives.js';

export const SearchEntityKind = Type.Union([
  Type.Literal('conversation'),
  Type.Literal('project'),
  Type.Literal('file'),
  Type.Literal('memory'),
  Type.Literal('task'),
  Type.Literal('artifact'),
]);

export const SearchRequest = StrictObject(
  {
    query: Type.String({ minLength: 1, maxLength: 4096 }),
    projectId: Type.Optional(Nullable(ProjectId)),
    kinds: Type.Array(SearchEntityKind, { minItems: 1, uniqueItems: true }),
    mode: Type.Union([Type.Literal('lexical'), Type.Literal('hybrid')]),
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    cursor: Type.Optional(PageCursor),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/search-request.schema.json' },
);

export const SearchResult = StrictObject(
  {
    kind: SearchEntityKind,
    id: Type.Union([ConversationId, ProjectId, FileId, MemoryId, TaskId, ArtifactId]),
    projectId: Type.Optional(Nullable(ProjectId)),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    excerpt: Type.String({ maxLength: 4096 }),
    lexicalScore: Type.Number({ minimum: 0 }),
    semanticScore: Type.Optional(UnitInterval),
    updatedAt: UtcTimestamp,
    locator: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/search-result.schema.json' },
);

export const ContextItem = Type.Union([
  StrictObject({
    kind: Type.Literal('instruction'),
    id: Type.String({ minLength: 1, maxLength: 512 }),
    label: Type.String({ minLength: 1, maxLength: 512 }),
    tokenCount: Type.Integer({ minimum: 0 }),
  }),
  StrictObject({
    kind: Type.Literal('file'),
    id: FileId,
    label: Type.String({ minLength: 1, maxLength: 512 }),
    tokenCount: Type.Integer({ minimum: 0 }),
  }),
  StrictObject({
    kind: Type.Literal('memory'),
    id: MemoryId,
    label: Type.String({ minLength: 1, maxLength: 512 }),
    tokenCount: Type.Integer({ minimum: 0 }),
    confidence: UnitInterval,
  }),
  StrictObject({
    kind: Type.Literal('tool'),
    id: ToolId,
    label: Type.String({ minLength: 1, maxLength: 512 }),
    tokenCount: Type.Integer({ minimum: 0 }),
  }),
]);

export const ContextSnapshot = StrictObject(
  {
    projectId: Type.Optional(Nullable(ProjectId)),
    conversationId: ConversationId,
    model: ModelSelection,
    items: Type.Array(ContextItem, { maxItems: 10_000 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    maximumTokens: Type.Integer({ minimum: 1 }),
    outboundDestination: Type.Union([
      StrictObject({ route: Type.Literal('local') }),
      StrictObject({
        route: Type.Literal('cloud'),
        provider: Type.String({ minLength: 1, maxLength: 128 }),
        displayName: Type.String({ minLength: 1, maxLength: 255 }),
      }),
    ]),
    compiledAt: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/context-snapshot.schema.json' },
);

export type SearchRequest = Static<typeof SearchRequest>;
export type SearchResult = Static<typeof SearchResult>;
export type ContextSnapshot = Static<typeof ContextSnapshot>;
