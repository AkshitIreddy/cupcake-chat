import type { TSchema } from '@sinclair/typebox';
import { BrokerRuntimeRequest, BrokerToolResult } from './broker-wire.js';
import { MemoryMutation, MemoryRecord } from './memory.js';
import { ModelDescriptor, ProviderDescriptor } from './models.js';
import { ProtocolEnvelope } from './protocol.js';
import { RunEvent } from './runs.js';
import { ContextSnapshot, SearchRequest, SearchResult } from './search.js';
import { AppSettings, ThemeTokens } from './settings.js';
import { TaskCommand, TaskRecord } from './tasks.js';
import { ToolDescriptor, ToolIntent, ToolPreflight, ToolResult } from './tools.js';
import {
  Artifact,
  ArtifactRevision,
  Conversation,
  ConversationBranch,
  FileRecord,
  Message,
  Project,
} from './workspace.js';

/** Stable kebab-case keys map directly to checked-in `schema/v1/*.schema.json` files. */
export const contractSchemas = {
  'app-settings': AppSettings,
  artifact: Artifact,
  'artifact-revision': ArtifactRevision,
  'broker-request': BrokerRuntimeRequest,
  'broker-tool-result': BrokerToolResult,
  context: ContextSnapshot,
  conversation: Conversation,
  'conversation-branch': ConversationBranch,
  file: FileRecord,
  memory: MemoryRecord,
  'memory-mutation': MemoryMutation,
  message: Message,
  model: ModelDescriptor,
  project: Project,
  protocol: ProtocolEnvelope,
  provider: ProviderDescriptor,
  'run-event': RunEvent,
  'search-request': SearchRequest,
  'search-result': SearchResult,
  'task-command': TaskCommand,
  task: TaskRecord,
  theme: ThemeTokens,
  tool: ToolDescriptor,
  'tool-intent': ToolIntent,
  'tool-preflight': ToolPreflight,
  'tool-result': ToolResult,
} as const satisfies Record<string, TSchema>;

export type ContractSchemaName = keyof typeof contractSchemas;
