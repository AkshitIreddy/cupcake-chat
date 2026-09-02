import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  artifacts as fixtureArtifacts,
  conversations as fixtureConversations,
  memories as fixtureMemories,
  models as fixtureModels,
  tasks as fixtureTasks,
  tools as fixtureTools,
} from './data';
import type { RuntimeEvent, RuntimeResponse } from '../shared/desktop-api';
import type {
  Conversation,
  LiveChatMessage,
  MemoryRecord,
  ModelDescriptor,
  Task,
  ToolDescriptor,
} from './types';
import { createKeyedRequestCoalescer, mergeModelDescriptors } from './model-selection';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BranchRecord {
  id: string;
  conversationId: string;
  name: string;
  headMessageId?: string | null;
  parentMessageId?: string | null;
}

export interface MessageRecord extends LiveChatMessage {
  branchId?: string;
  createdAt?: string;
  modelId?: string | null;
  providerId?: string | null;
  attachments?: AttachmentRecord[];
  references?: ReferenceRecord[];
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCost?: string };
  citations?: Array<{ id: string; title: string; url?: string }>;
  reasoningSummary?: string;
}

export interface AttachmentRecord {
  /** Present only while the desktop file grant is live in the composer. */
  handleId?: string;
  /** Product-owned persisted identity; never a raw path or desktop grant. */
  id?: string;
  name: string;
  size?: number;
  extension?: string;
  destination: 'local' | 'cloud';
}

export interface ReferenceRecord {
  id: string;
  type: 'project' | 'task' | 'artifact' | 'memory';
  label: string;
  projectId?: string | null;
  conversationId?: string | null;
  revisionId?: string;
}

export interface StagedAttachmentRecord extends AttachmentRecord {
  handleId: string;
}

export interface OutboundIntent {
  provider: string;
  modelId: string;
  privacyRoute: string;
  costClass: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  messageId: string | null;
  contentSha256: string;
  attachmentHandleIds: string[];
  attachmentBindings: Array<{ handleId: string; byteSize: number; sha256: string }>;
  referenceIds: string[];
  referenceBindings: Array<{
    id: string;
    type: ReferenceRecord['type'];
    contentSha256: string;
    revisionId?: string;
    objectDigest?: string;
    version?: number;
    status?: string;
  }>;
  memoryIds: string[];
  toolIds: string[];
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  content?: string;
  revisionId?: string;
  revisionNumber?: number;
  createdAt?: string;
  updatedAt?: string;
  size?: number;
}

export interface SearchRecord {
  id: string;
  entityType: string;
  title: string;
  snippet: string;
  projectId?: string | null;
  score?: number;
}

export interface HardwareRecord {
  os?: string;
  cpu?: string;
  cpuArchitecture?: string;
  cpuFeatures?: string[];
  ramBytes?: number;
  vramBytes?: number;
  gpu?: string;
  diskAvailableBytes?: number;
  windowsVersion?: string;
  acceleration?: string[];
}

export interface ProviderSetupInput {
  provider: string;
  apiKey: string;
  endpoint?: string;
  organization?: string;
  modelId?: string;
  connectionName?: string;
}

export interface ProviderTestResult {
  maskedIdentity: string;
  lastTested: string;
  models: Array<{ id: string; name: string; capabilities?: string[] }>;
  detail?: string;
}

export interface LocalRuntimeRecord {
  id: string;
  name: string;
  status: string;
  version?: string;
  models?: Array<Record<string, unknown> | string>;
  detail?: string;
  backend?: string;
  sizeBytes?: number;
  totalDownloadBytes?: number;
  license?: string;
  licenseUrls?: string[];
  prerequisites?: string[];
  compatible?: boolean;
  recommended?: boolean;
  active?: boolean;
}

type ModelAction =
  | 'download'
  | 'load'
  | 'unload'
  | 'remove'
  | 'status'
  | 'benchmark'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'reset';

export interface ToolActivity {
  id: string;
  type: 'preflight' | 'approval' | 'result' | 'audit';
  status: string;
  toolName: string;
  summary: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface LegacyMigrationState {
  state: string;
  available: boolean;
  source_fingerprint?: string | null;
  report?: {
    conversations?: number;
    memories?: number;
    tasks?: number;
    files?: number;
    warnings?: string[];
    [key: string]: unknown;
  } | null;
}

export interface WorkspaceSettings {
  theme: 'light' | 'dark' | 'minimal' | 'classic';
  wallpaper:
    'none' | 'moonlit-archive' | 'pistachio-atelier' | 'blueberry-observatory' | 'copper-workshop';
  offline: boolean;
  proactiveEnabled: boolean;
  developerMode: boolean;
  reducedMotion: boolean;
  scrollbarMode: 'slim' | 'minimal' | 'hidden';
  onboardingCompleted: boolean;
  profile: {
    displayName: string;
    role: string;
    bio: string;
    avatar: string;
  };
  assistantAvatar: string;
  reasoningEffort: ReasoningEffort;
  enabledToolIds: string[];
  personalityPreset: 'balanced' | 'concise' | 'warm' | 'analytical' | 'custom';
  personality: {
    warmth: number;
    brevity: number;
    initiative: number;
  };
  personalityInstructions: string;
  semanticEnrichment: { enabled: boolean; provider: string | null; modelId: string | null };
  permissionMode: 'guarded' | 'full-freedom';
  allowRamFallback: boolean;
  maxRamGb: number;
  autoEvictLocalModels: boolean;
  localModelIdleMinutes: number;
  reserveSystemRamGb: number;
  reserveVramGb: number;
}

interface RuntimeProject {
  id: string;
  name: string;
  description?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface RuntimeConversation {
  id: string;
  title: string;
  project_id?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface RuntimeBranch {
  id: string;
  conversation_id: string;
  name?: string;
  head_message_id?: string | null;
  parent_message_id?: string | null;
}

interface RuntimeMessage {
  id: string;
  branch_id?: string;
  run_id?: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at?: string;
  model_id?: string | null;
  provider_id?: string | null;
  canonical_metadata?: Record<string, unknown>;
}

interface RuntimeMemory {
  id: string;
  key: string;
  content: string;
  kind: string;
  state: string;
  confidence: number;
  scope: { kind: string; project_id?: string | null; conversation_id?: string | null };
}

interface RuntimeTask {
  run_id: string;
  status: string;
  current_step: number;
  spec: {
    title: string;
    prompt: string;
    project_id?: string | null;
    steps: Array<{ key: string }>;
  };
  created_at?: string;
  updated_at?: string;
}

interface RuntimeModel {
  id?: string;
  model_id?: string;
  provider?: string;
  model?: string;
  display_name?: string;
  privacy_route?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: string[] | Record<string, boolean>;
  reasoning_presets?: string[];
  pricing?: { input?: string; output?: string; provenance?: string };
  chat_compatibility?: 'chat' | 'unknown' | 'non_chat';
  pricing_provenance?: string;
  privacy_route_label?: string;
  metadata?: Record<string, unknown>;
}

interface CupcakeLocalStatus {
  endpoint?: Record<string, unknown>;
  hardware?: Record<string, unknown>;
  activeRuntime?: Record<string, unknown> | null;
  runtimes?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  downloads?: Array<Record<string, unknown>>;
  availableRuntimes?: Array<Record<string, unknown>>;
  runtimeRecommendations?: Array<Record<string, unknown>>;
  availableModels?: Array<Record<string, unknown>>;
  recommendations?: Array<Record<string, unknown>>;
  activeModelId?: string | null;
}

interface RuntimeTool {
  id?: string;
  name: string;
  display_name?: string;
  description: string;
  effects?: string[];
  required_grants?: string[];
  provider?: string;
  enabled?: boolean;
  kind?: string;
}

interface RuntimeArtifact {
  artifact_id?: string;
  id?: string;
  project_id: string;
  name: string;
  kind?: string;
  artifact_type?: string;
  content?: string;
  revision_id?: string;
  revision_number?: number;
  created_at?: string;
  updated_at?: string;
  size?: number;
}

interface WorkspaceContextValue {
  fixtureMode: boolean;
  ready: boolean;
  configurationReady: boolean;
  busy: boolean;
  error: string | null;
  runtimeEvents: RuntimeEvent[];
  projects: ProjectRecord[];
  conversations: Conversation[];
  branches: BranchRecord[];
  messages: MessageRecord[];
  tasks: Task[];
  artifacts: ArtifactRecord[];
  memories: MemoryRecord[];
  models: ModelDescriptor[];
  tools: ToolDescriptor[];
  searchResults: SearchRecord[];
  hardware: HardwareRecord | null;
  localRuntimes: LocalRuntimeRecord[];
  toolActivity: ToolActivity[];
  providers: Record<string, boolean>;
  legacyMigration: LegacyMigrationState | null;
  settings: WorkspaceSettings;
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeBranchId: string | null;
  activeRunId: string | null;
  setActiveProject(projectId: string | null): Promise<void>;
  createProject(name: string, description?: string): Promise<void>;
  createConversation(
    title?: string,
  ): Promise<{ conversationId: string; branchId: string; projectId: string | null } | null>;
  selectConversation(conversationId: string): Promise<void>;
  selectBranch(branchId: string): Promise<void>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  archiveConversation(conversationId: string, archived: boolean): Promise<void>;
  branchConversation(fromMessageId?: string, name?: string): Promise<void>;
  sendMessage(input: {
    content: string;
    modelId: string;
    attachments: StagedAttachmentRecord[];
    references?: ReferenceRecord[];
    reasoningEffort: ReasoningEffort;
    enabledToolIds: string[];
    mode?: 'send' | 'retry' | 'continue' | 'edit' | 'regenerate';
    messageId?: string;
    conversationId?: string;
    branchId?: string;
    projectId?: string | null;
    outboundConfirmationToken?: string;
    outboundIntent?: OutboundIntent;
  }): Promise<boolean>;
  preflightCloudDisclosure(input: {
    content: string;
    modelId: string;
    attachments: StagedAttachmentRecord[];
    references: ReferenceRecord[];
    enabledToolIds?: string[];
    messageId?: string;
    conversationId?: string;
    branchId?: string;
    projectId?: string | null;
  }): Promise<{
    confirmationToken: string | null;
    disclosure: { privacyRoute?: string; costClass?: string };
    outboundIntent: OutboundIntent;
  }>;
  stopRun(): Promise<void>;
  copyMessage(messageId: string): Promise<boolean>;
  cancelTask(runId: string): Promise<void>;
  resumeTask(runId: string): Promise<void>;
  steerTask(runId: string, instruction: string): Promise<void>;
  followupTask(runId: string, prompt: string): Promise<void>;
  remember(input: {
    key: string;
    content: string;
    kind?: string;
    sensitive?: boolean;
  }): Promise<void>;
  updateMemory(record: MemoryRecord): Promise<void>;
  setMemoryEnabled(record: MemoryRecord, enabled: boolean): Promise<void>;
  forgetMemory(record: MemoryRecord): Promise<void>;
  createArtifact(name: string, kind: string, content: string): Promise<void>;
  reviseArtifact(artifact: ArtifactRecord, content: string): Promise<void>;
  exportArtifact(artifact: ArtifactRecord): Promise<void>;
  querySearch(query: string, globalScope?: boolean): Promise<void>;
  selectModel(id: string, options?: { compatibilityConfirmed?: boolean }): Promise<void>;
  runModelAction(action: ModelAction, modelId: string): Promise<void>;
  installRuntimePack(runtimeId: string, acceptedLicenseUrls: string[]): Promise<void>;
  activateRuntimePack(runtime: LocalRuntimeRecord): Promise<void>;
  discoverCommunityModels: (query?: string, limit?: number) => Promise<ModelDescriptor[]>;
  setToolEnabled(toolId: string, enabled: boolean): Promise<void>;
  connectMcp(input: {
    name: string;
    transport: 'stdio' | 'streamable-http';
    endpoint: string;
  }): Promise<void>;
  disconnectMcp(connectionId: string): Promise<void>;
  preflightTool(tool: ToolDescriptor): Promise<void>;
  resolveApproval(activity: ToolActivity, approved: boolean): Promise<void>;
  updateSettings: (patch: Partial<WorkspaceSettings>) => Promise<void>;
  chooseLegacySource(): Promise<void>;
  executeLegacyMigration(): Promise<void>;
  declineLegacyMigration(): Promise<void>;
  preflightClearData(scopes: string[]): Promise<Record<string, unknown>>;
  executeClearData(preflight: Record<string, unknown>): Promise<void>;
  undoClearData(): Promise<void>;
  createBackup(): Promise<void>;
  refresh(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function displayDate(value?: string): string {
  if (!value) return 'recently';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'recently';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cap(value: unknown, fallback = 'Unknown'): string {
  const text = textValue(value).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1).replaceAll('_', ' ') : fallback;
}

function textValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export async function recoverWorkspaceSupportRequest<T>(
  label: string,
  operation: Promise<T>,
  fallback: T,
): Promise<{ value: T; failure?: string }> {
  try {
    return { value: await operation };
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : 'request failed';
    return { value: fallback, failure: `${label}: ${detail}` };
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((item): item is string => typeof item === 'string');
}

function recordValues(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map(recordValue)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function runtimeEventRunId(
  payload: Record<string, unknown>,
  activeRunId: string | null,
): string | null {
  return typeof payload.runId === 'string'
    ? payload.runId
    : typeof payload.run_id === 'string'
      ? payload.run_id
      : activeRunId;
}

function withFinalMessageProvenance(
  message: MessageRecord,
  payload: Record<string, unknown>,
): MessageRecord {
  const persisted = recordValue(payload.message);
  if (!persisted) return message;
  const branchId = textValue(persisted.branch_id ?? persisted.branchId, message.branchId);
  const createdAt = textValue(persisted.created_at ?? persisted.createdAt, message.createdAt);
  const modelId = textValue(persisted.model_id ?? persisted.modelId, message.modelId ?? '');
  const providerId = textValue(
    persisted.provider_id ?? persisted.providerId,
    message.providerId ?? '',
  );
  return {
    ...message,
    branchId: branchId || message.branchId,
    createdAt: createdAt || message.createdAt,
    modelId: modelId || message.modelId,
    providerId: providerId || message.providerId,
  };
}

function upsertAssistantMessage(
  messages: MessageRecord[],
  runId: string,
  update: (message: MessageRecord) => MessageRecord,
): MessageRecord[] {
  const existing = messages.find((message) => message.id === runId);
  if (!existing) {
    return [...messages, update({ id: runId, role: 'assistant', content: '', streaming: true })];
  }
  return messages.map((message) => (message.id === runId ? update(message) : message));
}

function runtimeFailureEvent(type: string): boolean {
  return (
    type === 'run.failed' ||
    type === 'message.failed' ||
    type === 'runtime.failed' ||
    type === 'runtime.error' ||
    type.endsWith('.error')
  );
}

function runtimeFailureMessage(payload: Record<string, unknown>): string {
  const error = recordValue(payload.error);
  return textValue(
    payload.message ?? error?.message ?? error?.detail,
    'The runtime could not complete the response.',
  );
}

class RuntimeRequestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeRequestFailure';
  }
}

export function applyRuntimeMessageEvent(
  messages: MessageRecord[],
  event: RuntimeEvent,
  activeRunId: string | null,
): MessageRecord[] {
  const payload = recordValue(event.payload) ?? {};
  const runId = runtimeEventRunId(payload, activeRunId);

  if (event.type === 'message.started' && runId) {
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      streaming: true,
    }));
  }
  if (event.type === 'message.delta' && runId && typeof payload.delta === 'string') {
    const delta = payload.delta;
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      content: message.content + delta,
      streaming: true,
    }));
  }
  if (event.type === 'provider.fallback.started' && runId && payload.discardPriorDeltas === true) {
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      content: '',
      reasoningSummary: undefined,
      citations: undefined,
      usage: undefined,
      streaming: true,
    }));
  }
  if (event.type === 'reasoning.summary.delta' && runId && typeof payload.delta === 'string') {
    const delta = payload.delta;
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      reasoningSummary: (message.reasoningSummary ?? '') + delta,
    }));
  }
  if (event.type === 'reasoning.summary' && runId && typeof payload.summary === 'string') {
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      reasoningSummary: payload.summary as string,
    }));
  }
  if (event.type === 'usage.updated' && runId) {
    const usage = recordValue(payload.usage) ?? {};
    const cost = recordValue(payload.cost);
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      usage: {
        inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
        estimatedCost: cost ? textValue(cost.amount, 'estimated') : undefined,
      },
    }));
  }
  if (event.type === 'citation.created' && runId) {
    return upsertAssistantMessage(messages, runId, (message) => {
      const citation = {
        id: textValue(payload.id, String(event.sequence)),
        title: textValue(payload.title ?? payload.source, 'Source'),
        url: typeof payload.url === 'string' ? payload.url : undefined,
      };
      const citations = message.citations ?? [];
      return citations.some((existing) => existing.id === citation.id)
        ? message
        : { ...message, citations: [...citations, citation] };
    });
  }
  if (event.type === 'message.completed' && runId) {
    return upsertAssistantMessage(messages, runId, (message) => {
      const persisted = recordValue(payload.message);
      const content = textValue(payload.content ?? persisted?.content, message.content);
      return withFinalMessageProvenance({ ...message, content, streaming: false }, payload);
    });
  }
  if (event.type === 'message.cancelled' && runId) {
    return upsertAssistantMessage(messages, runId, (message) => {
      const persisted = recordValue(payload.message);
      const partial = textValue(
        payload.partialContent ?? payload.partial_content ?? persisted?.content,
        message.content,
      );
      return withFinalMessageProvenance(
        { ...message, content: partial || 'Response stopped.', streaming: false },
        payload,
      );
    });
  }
  if (runtimeFailureEvent(event.type) && runId) {
    return upsertAssistantMessage(messages, runId, (message) => ({
      ...message,
      content: message.content || runtimeFailureMessage(payload),
      streaming: false,
    }));
  }
  return messages;
}

function mapConversation(item: RuntimeConversation, projects: ProjectRecord[]): Conversation {
  return {
    id: item.id,
    title: item.title,
    preview: 'Open to see this conversation',
    updated: displayDate(item.updated_at),
    project: projects.find((project) => project.id === item.project_id)?.name,
    archived: item.status === 'archived',
  };
}

function safeAttachmentMetadata(value: unknown, index: number): AttachmentRecord | null {
  const item = recordValue(value);
  if (!item) return null;
  const name = textValue(item.name ?? item.displayName ?? item.display_name);
  if (!name) return null;
  const size = Number(item.size ?? item.byteSize ?? item.byte_size);
  const route = textValue(item.destination ?? item.route ?? item.privacyRoute).toLowerCase();
  return {
    id: textValue(item.id ?? item.attachmentId ?? item.attachment_id, `attachment-${index}`),
    name,
    size: Number.isFinite(size) && size >= 0 ? size : undefined,
    extension: textValue(item.extension) || undefined,
    destination: route === 'cloud' ? 'cloud' : 'local',
  };
}

function safeReferenceMetadata(value: unknown): ReferenceRecord | null {
  const item = recordValue(value);
  if (!item) return null;
  const id = textValue(item.id ?? item.referenceId ?? item.reference_id);
  const type = textValue(item.type ?? item.referenceType ?? item.reference_type);
  const label = textValue(item.label ?? item.name ?? item.title);
  if (!id || !label || !['project', 'task', 'artifact', 'memory'].includes(type)) return null;
  return {
    id,
    type: type as ReferenceRecord['type'],
    label,
    projectId:
      typeof (item.projectId ?? item.project_id) === 'string'
        ? String(item.projectId ?? item.project_id)
        : null,
    conversationId:
      typeof (item.conversationId ?? item.conversation_id) === 'string'
        ? String(item.conversationId ?? item.conversation_id)
        : null,
    revisionId: textValue(item.revisionId ?? item.revision_id) || undefined,
  };
}

function metadataArray(metadata: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(metadata[key])) return metadata[key];
  }
  return [];
}

export function mapRuntimeMessage(item: RuntimeMessage): MessageRecord {
  const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'status';
  const metadata = recordValue(item.canonical_metadata) ?? {};
  const attachments = metadataArray(
    metadata,
    'attachments',
    'attachmentMetadata',
    'attachment_metadata',
  ).flatMap((value, index) => {
    const attachment = safeAttachmentMetadata(value, index);
    return attachment ? [attachment] : [];
  });
  const references = metadataArray(
    metadata,
    'references',
    'referenceMetadata',
    'reference_metadata',
  ).flatMap((value) => {
    const reference = safeReferenceMetadata(value);
    return reference ? [reference] : [];
  });
  return {
    id: item.id,
    role,
    content: item.content,
    branchId: item.branch_id,
    createdAt: item.created_at,
    modelId: item.model_id,
    providerId: item.provider_id,
    attachments: attachments.length ? attachments : undefined,
    references: references.length ? references : undefined,
  };
}

export function structuredAttachments(
  attachments: readonly StagedAttachmentRecord[],
): Array<{ handleId: string }> {
  return attachments.map(({ handleId }) => ({ handleId }));
}

export function structuredReferences(
  references: readonly ReferenceRecord[],
): Array<{ id: string; type: ReferenceRecord['type']; revisionId?: string }> {
  return references.map(({ id, type, revisionId }) => ({
    id,
    type,
    ...(revisionId ? { revisionId } : {}),
  }));
}

export function shouldOptimisticallyAppendUser(
  mode: Parameters<WorkspaceContextValue['sendMessage']>[0]['mode'],
): boolean {
  return !mode || mode === 'send';
}

export function scopedReferenceOptions(input: {
  projects: ProjectRecord[];
  tasks: Task[];
  artifacts: ArtifactRecord[];
  memories: MemoryRecord[];
  activeProjectId: string | null;
  activeConversationId: string | null;
}): ReferenceRecord[] {
  const { activeProjectId, activeConversationId } = input;
  const project = activeProjectId
    ? input.projects.find((item) => item.id === activeProjectId)
    : undefined;
  const projectReferences: ReferenceRecord[] = project
    ? [{ id: project.id, type: 'project', label: project.name, projectId: project.id }]
    : [];
  const taskReferences: ReferenceRecord[] = input.tasks
    .filter((item) => (activeProjectId ? item.projectId === activeProjectId : !item.projectId))
    .map((item) => ({
      id: item.id,
      type: 'task',
      label: item.title,
      projectId: item.projectId,
    }));
  const artifactReferences: ReferenceRecord[] = input.artifacts
    .filter((item) => activeProjectId !== null && item.projectId === activeProjectId)
    .map((item) => ({
      id: item.id,
      type: 'artifact',
      label: item.name,
      projectId: item.projectId,
      revisionId: item.revisionId,
    }));
  const memoryReferences: ReferenceRecord[] = input.memories
    .filter(
      (item) =>
        item.enabled &&
        (!item.projectId || item.projectId === activeProjectId) &&
        (!item.conversationId || item.conversationId === activeConversationId),
    )
    .map((item) => ({
      id: item.id,
      type: 'memory',
      label: item.title,
      projectId: item.projectId,
      conversationId: item.conversationId,
    }));
  return [...projectReferences, ...taskReferences, ...artifactReferences, ...memoryReferences];
}

function mapTask(run: RuntimeTask): Task {
  const steps = run.spec.steps ?? [];
  const status: Task['status'] =
    run.status === 'succeeded'
      ? 'complete'
      : run.status === 'failed' || run.status === 'cancelled'
        ? 'failed'
        : run.status.includes('waiting') || run.status === 'paused'
          ? 'waiting'
          : 'working';
  return {
    id: run.run_id,
    title: run.spec.title,
    detail: run.spec.prompt,
    status,
    progress: steps.length ? Math.min(100, Math.round((run.current_step / steps.length) * 100)) : 0,
    project: run.spec.project_id ?? 'No project',
    projectId: run.spec.project_id ?? null,
    elapsed: displayDate(run.updated_at ?? run.created_at),
    steps: steps.map((step, index) => ({
      label: step.key,
      state:
        index < run.current_step
          ? 'complete'
          : index === run.current_step && status === 'working'
            ? 'active'
            : status === 'failed' && index === run.current_step
              ? 'failed'
              : 'queued',
    })),
  };
}

function mapMemory(item: RuntimeMemory, projects: ProjectRecord[]): MemoryRecord {
  const project = projects.find((candidate) => candidate.id === item.scope.project_id);
  const type = item.kind === 'temporary_context' ? 'Temporary' : cap(item.kind);
  const allowed: MemoryRecord['type'][] = [
    'Preference',
    'Decision',
    'Instruction',
    'Fact',
    'Temporary',
  ];
  return {
    id: item.id,
    type: allowed.includes(type as MemoryRecord['type']) ? (type as MemoryRecord['type']) : 'Fact',
    title: item.key,
    body: item.content,
    scope: project?.name ?? (item.scope.conversation_id ? 'This conversation' : 'About me'),
    source: item.state === 'candidate' ? 'Suggested memory' : 'Saved memory',
    confidence: item.confidence,
    enabled: item.state === 'active',
    projectId: item.scope.project_id ?? null,
    conversationId: item.scope.conversation_id ?? null,
  };
}

function runtimeKind(item: RuntimeModel): string | undefined {
  return typeof item.metadata?.runtime_kind === 'string' ? item.metadata.runtime_kind : undefined;
}

export function normalizeHardware(value: unknown): HardwareRecord | null {
  const record = recordValue(value);
  if (!record) return null;
  const result: HardwareRecord = {};
  const ramBytes = Number(record.ramBytes);
  const systemRamGb = Number(record.system_ram_gb);
  if (Number.isFinite(ramBytes) && ramBytes > 0) result.ramBytes = ramBytes;
  else if (Number.isFinite(systemRamGb) && systemRamGb > 0)
    result.ramBytes = systemRamGb * 1024 ** 3;
  const vramBytes = Number(record.vramBytes);
  const vramGb = Number(record.vram_gb);
  if (Number.isFinite(vramBytes) && vramBytes > 0) result.vramBytes = vramBytes;
  else if (Number.isFinite(vramGb) && vramGb > 0) result.vramBytes = vramGb * 1024 ** 3;
  const gpu = record.gpu ?? record.gpu_name;
  if (typeof gpu === 'string' && gpu) result.gpu = gpu;
  const cpu = record.cpu ?? record.cpu_name;
  if (typeof cpu === 'string' && cpu) result.cpu = cpu;
  else if (Number.isFinite(Number(record.cpu_threads)) && Number(record.cpu_threads) > 0)
    result.cpu = `${Number(record.cpu_threads)} threads`;
  const cpuArchitecture = record.cpuArchitecture ?? record.cpu_architecture ?? record.architecture;
  if (typeof cpuArchitecture === 'string' && cpuArchitecture)
    result.cpuArchitecture = cpuArchitecture;
  const cpuFeatures = record.cpuFeatures ?? record.cpu_features;
  if (Array.isArray(cpuFeatures))
    result.cpuFeatures = cpuFeatures.filter((item): item is string => typeof item === 'string');
  const freeDiskGb = Number(record.free_disk_gb);
  const diskAvailableBytes = Number(record.diskAvailableBytes ?? record.disk_available_bytes);
  if (Number.isFinite(diskAvailableBytes) && diskAvailableBytes > 0)
    result.diskAvailableBytes = diskAvailableBytes;
  else if (Number.isFinite(freeDiskGb) && freeDiskGb > 0)
    result.diskAvailableBytes = freeDiskGb * 1024 ** 3;
  const windowsVersion = record.windowsVersion ?? record.windows_version;
  if (typeof windowsVersion === 'string' && windowsVersion) result.windowsVersion = windowsVersion;
  const os = record.os ?? record.os_name;
  if (typeof os === 'string' && os) result.os = os;
  if (Array.isArray(record.acceleration))
    result.acceleration = record.acceleration.filter(
      (item): item is string => typeof item === 'string',
    );
  return result;
}

export function mapDiscoveredRuntime(item: Record<string, unknown>): LocalRuntimeRecord {
  const kind = textValue(item.kind, 'local');
  const rawModels = Array.isArray(item.models) ? item.models : undefined;
  const models = rawModels?.filter(
    (model): model is string | Record<string, unknown> =>
      typeof model === 'string' || (typeof model === 'object' && model !== null),
  );
  return {
    id: textValue(item.id, kind),
    name: 'Cupcake Local',
    status: textValue(item.state ?? item.status, 'unknown'),
    models,
    detail: typeof item.detail === 'string' ? item.detail : undefined,
  };
}

function localDownloadState(value: string, errorCode = ''): ModelDescriptor['status'] {
  if (['queued', 'resolving', 'downloading'].includes(value)) return 'download';
  if (value === 'paused') return 'paused';
  if (value === 'verifying') return 'verifying';
  if (value === 'failed')
    return errorCode.toLowerCase().includes('checksum') ? 'checksum-failed' : 'error';
  return 'catalog';
}

function isActiveDownload(value: string): boolean {
  return ['queued', 'resolving', 'downloading', 'paused', 'verifying', 'failed'].includes(value);
}

export function mapCupcakeLocalModels(
  status: CupcakeLocalStatus,
  selectedId?: string,
): ModelDescriptor[] {
  const installed = new Map(
    (status.models ?? []).map((item) => [textValue(item.id), item] as const),
  );
  const downloads = new Map(
    (status.downloads ?? []).map((item) => [textValue(item.model_id), item] as const),
  );
  const recommendations = new Map(
    (status.recommendations ?? []).map((item) => [textValue(item.model_id), item] as const),
  );
  return (status.availableModels ?? []).map((artifact) => {
    const artifactId = textValue(artifact.id);
    const installedModel = installed.get(artifactId);
    const download = downloads.get(artifactId);
    const recommendation = recommendations.get(artifactId);
    const downloadState = textValue(download?.state);
    const classification = textValue(recommendation?.classification).replaceAll('_', '-');
    const fitMap: Record<string, ModelDescriptor['fit']> = {
      recommended: 'recommended',
      'fits-reduced-context': 'reduced-context',
      'cpu-only-slow': 'cpu-slow',
      hybrid: 'hybrid',
      incompatible: 'incompatible',
    };
    const lifecycleState: ModelDescriptor['status'] =
      status.activeModelId === artifactId
        ? 'ready'
        : installedModel
          ? 'installed'
          : download && isActiveDownload(downloadState)
            ? localDownloadState(downloadState, textValue(download.error_code))
            : 'catalog';
    const loadedRouteId = `openai-compatible:cupcake-local/${artifactId}`;
    const selectableId =
      status.activeModelId === artifactId || selectedId === loadedRouteId
        ? loadedRouteId
        : `cupcake-local:${artifactId}`;
    const reasons = stringValues(recommendation?.reasons);
    const mapped = mapModel(
      {
        id: selectableId,
        provider: 'cupcake_local',
        model: artifactId,
        display_name: textValue(artifact.display_name, artifactId),
        privacy_route: 'local',
        context_window: Number(artifact.context_window) || undefined,
        capabilities: [
          ...stringValues(artifact.capability_tags),
          ...stringValues(artifact.task_tags),
        ],
        metadata: {
          runtime_kind: 'cupcake_local',
          lifecycle_state: lifecycleState,
          fit: fitMap[classification] ?? 'pending',
          fit_reason: reasons.join(' · '),
          source: `${textValue(artifact.source, 'Signed Cupcake Local catalog')} @ ${textValue(artifact.source_revision, 'pinned revision')}`,
          license: textValue(artifact.license),
          parameters: `${Number(artifact.parameter_billions) || 0}B`,
          quantization: textValue(artifact.quantization),
          file_size_bytes: Number(artifact.size_bytes) || undefined,
          estimated_ram_bytes:
            (Number(recommendation?.estimated_ram_gb) || 0) * 1024 ** 3 || undefined,
          estimated_vram_bytes:
            (Number(recommendation?.estimated_vram_gb) || 0) * 1024 ** 3 || undefined,
          estimated_disk_bytes:
            (Number(recommendation?.estimated_disk_gb) || 0) * 1024 ** 3 || undefined,
          speed_class: textValue(recommendation?.likely_speed_class),
        },
      },
      selectedId,
    );
    if (!download || !isActiveDownload(downloadState)) return mapped;
    return {
      ...mapped,
      download: {
        bytesReceived: Number(download.bytes_downloaded) || 0,
        totalBytes: Number(download.bytes_total) || Number(artifact.size_bytes) || 0,
        checksumState: downloadState === 'verifying' ? 'verifying' : undefined,
        state: downloadState,
      },
    };
  });
}

export function mapCupcakeRuntimePacks(status: CupcakeLocalStatus): LocalRuntimeRecord[] {
  const installed = new Map(
    (status.runtimes ?? []).map((item) => [textValue(item.id), item] as const),
  );
  const recommendations = new Map(
    (status.runtimeRecommendations ?? []).map(
      (item) => [textValue(item.runtime_id), item] as const,
    ),
  );
  const downloads = new Map(
    (status.downloads ?? []).map((item) => [textValue(item.model_id), item] as const),
  );
  return (status.availableRuntimes ?? []).map((artifact) => {
    const id = textValue(artifact.id);
    const installedRuntime = installed.get(id);
    const recommendation = recommendations.get(id);
    const download = downloads.get(id);
    const companions = recordValues(artifact.companions);
    const companionBytes = companions.reduce(
      (total, item) => total + Number(item.size_bytes ?? 0),
      0,
    );
    const licenseUrls = companions
      .filter((item) => item.license_requires_acceptance === true)
      .map((item) => textValue(item.license_url))
      .filter(Boolean);
    const active = installedRuntime?.active === true;
    const compatible = recommendation?.compatible !== false;
    const reasons = stringValues(recommendation?.reasons);
    return {
      id,
      name: `${textValue(artifact.backend, 'CPU').toUpperCase()} acceleration`,
      version: textValue(artifact.version),
      backend: textValue(artifact.backend),
      status: active
        ? 'active'
        : installedRuntime
          ? 'installed'
          : download && isActiveDownload(textValue(download.state))
            ? localDownloadState(textValue(download.state), textValue(download.error_code))
            : compatible
              ? 'catalog'
              : 'incompatible',
      detail: reasons.join(' · '),
      sizeBytes: Number(artifact.size_bytes) || undefined,
      totalDownloadBytes: (Number(artifact.size_bytes) || 0) + companionBytes,
      license: textValue(artifact.license),
      licenseUrls,
      prerequisites: stringValues(artifact.prerequisites),
      compatible,
      recommended: recommendation?.recommended === true,
      active,
    };
  });
}

export function mapModel(item: RuntimeModel, selectedId?: string): ModelDescriptor {
  const provider = textValue(item.provider ?? item.metadata?.provider, 'unknown');
  const id =
    textValue(item.id ?? item.model_id) || `${provider}:${textValue(item.model, 'model')}`;
  const kind = runtimeKind(item);
  const local =
    item.privacy_route === 'local' ||
    ['local', 'cupcake_local', 'cupcake_llama_cpp'].includes(kind ?? provider);
  const providerNames: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    xai: 'xAI',
    mistral: 'Mistral',
    cohere: 'Cohere',
    'nvidia-nim': 'NVIDIA NIM',
    cupcake_local: 'Cupcake Local',
    cupcake_llama_cpp: 'Cupcake Local',
  };
  const capabilityTags = Array.isArray(item.capabilities)
    ? item.capabilities
    : item.capabilities && typeof item.capabilities === 'object'
      ? Object.entries(item.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
      : [];
  const metadata = item.metadata ?? {};
  const metadataChatCompatibility = metadata.chat_compatibility;
  const chatCompatibility =
    item.chat_compatibility ??
    (metadataChatCompatibility === 'chat' ||
    metadataChatCompatibility === 'unknown' ||
    metadataChatCompatibility === 'non_chat'
      ? metadataChatCompatibility
      : undefined);
  const contextWindowKnown = metadata.context_window_known !== false;
  const runtimeLoaded = metadata.runtime_loaded;
  const rawState = textValue(item.metadata?.lifecycle_state ?? item.metadata?.state).replaceAll(
    '_',
    '-',
  );
  const lifecycleStates = new Set<ModelDescriptor['status']>([
    'catalog',
    'incompatible',
    'setup',
    'download',
    'paused',
    'verifying',
    'checksum-failed',
    'installed',
    'loading',
    'ready',
    'benchmarked',
    'unloading',
    'removing',
    'offline',
    'error',
  ]);
  const fitValue = textValue(metadata.fit ?? metadata.compatibility_rating).replaceAll('_', '-');
  const fit = ['recommended', 'reduced-context', 'cpu-slow', 'hybrid', 'incompatible'].includes(
    fitValue,
  )
    ? (fitValue as ModelDescriptor['fit'])
    : undefined;
  const numberMetadata = (key: string): number | undefined =>
    typeof metadata[key] === 'number' ? metadata[key] : undefined;
  return {
    id,
    runtimeModelId: kind && item.model ? item.model : id,
    provider: providerNames[kind ?? provider] ?? cap(provider),
    name: item.display_name ?? item.model ?? id.split(':').at(-1) ?? id,
    route: local || item.privacy_route === 'local' ? 'Local' : 'Cloud',
    tags: capabilityTags.slice(0, 4),
    context: item.context_window
      ? contextWindowKnown
        ? item.context_window.toLocaleString()
        : `Unknown · safe ${item.context_window.toLocaleString()} cap`
      : 'Unknown',
    cost: local ? 'Local' : item.pricing?.input ? `From ${item.pricing.input}` : 'Provider pricing',
    status: lifecycleStates.has(rawState as ModelDescriptor['status'])
      ? (rawState as ModelDescriptor['status'])
      : local
        ? runtimeLoaded === true
          ? 'ready'
          : 'catalog'
        : 'setup',
    description: item.reasoning_presets?.length
      ? `Reasoning: ${item.reasoning_presets.join(', ')}`
      : 'Explicitly selected model',
    selected: id === selectedId,
    reasoningPresets: item.reasoning_presets?.filter((preset): preset is ReasoningEffort =>
      ['none', 'low', 'medium', 'high'].includes(preset),
    ),
    chatCompatibility,
    privacyLabel:
      item.privacy_route_label ??
      (typeof metadata.privacy_route_label === 'string' ? metadata.privacy_route_label : undefined),
    pricingProvenance:
      item.pricing_provenance ??
      item.pricing?.provenance ??
      (typeof metadata.pricing_provenance === 'string' ? metadata.pricing_provenance : undefined),
    fit,
    fitReason: textValue(metadata.fit_reason) || undefined,
    source: textValue(metadata.source) || undefined,
    license: textValue(metadata.license) || undefined,
    parameters: textValue(metadata.parameters) || undefined,
    quantization: textValue(metadata.quantization) || undefined,
    fileSizeBytes: numberMetadata('file_size_bytes'),
    estimatedRamBytes: numberMetadata('estimated_ram_bytes'),
    estimatedVramBytes: numberMetadata('estimated_vram_bytes'),
    estimatedDiskBytes: numberMetadata('estimated_disk_bytes'),
    speedClass: textValue(metadata.speed_class) || undefined,
  };
}

function mapCommunityModel(item: Record<string, unknown>): ModelDescriptor | null {
  const id = typeof item.id === 'string' ? item.id : '';
  const name = typeof item.name === 'string' ? item.name : '';
  const sourceUrl = typeof item.sourceUrl === 'string' ? item.sourceUrl : undefined;
  if (!id.startsWith('hf:') || !name || !sourceUrl?.startsWith('https://huggingface.co/'))
    return null;
  return {
    id,
    provider: 'Hugging Face',
    name,
    route: 'Local',
    tags: Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 5)
      : ['GGUF'],
    context: typeof item.context === 'string' ? item.context : 'See model card',
    cost: 'Local',
    status: 'community',
    description:
      typeof item.description === 'string'
        ? item.description
        : 'Community GGUF listing from Hugging Face.',
    fit: 'pending',
    fitReason:
      typeof item.fitReason === 'string'
        ? item.fitReason
        : 'Choose a quantization to estimate device fit.',
    source: 'Hugging Face Hub',
    sourceUrl,
    license: typeof item.license === 'string' ? item.license : undefined,
    parameters: typeof item.parameters === 'string' ? item.parameters : undefined,
    downloads: typeof item.downloads === 'number' ? item.downloads : undefined,
    likes: typeof item.likes === 'number' ? item.likes : undefined,
    lastModified: typeof item.lastModified === 'string' ? item.lastModified : undefined,
    gated: Boolean(item.gated),
  };
}

const fixtureCommunityRepositories = [
  'Qwen/Qwen3-4B-GGUF',
  'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
  'unsloth/gemma-3-4b-it-GGUF',
  'microsoft/Phi-4-mini-instruct-GGUF',
  'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
  'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF',
  'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
  'bartowski/SmolLM3-3B-GGUF',
  'bartowski/granite-3.3-8b-instruct-GGUF',
  'bartowski/Aya-Expanse-8B-GGUF',
  'bartowski/LFM2-1.2B-GGUF',
  'bartowski/Ministral-3-3B-Instruct-GGUF',
  'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
  'unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF',
  'bartowski/Qwen3-14B-GGUF',
  'bartowski/Qwen3-8B-GGUF',
  'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF',
  'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
  'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',
  'google/gemma-3-27b-it-qat-q4_0-gguf',
  'google/gemma-3-12b-it-qat-q4_0-gguf',
  'google/gemma-3-4b-it-qat-q4_0-gguf',
  'bartowski/Llama-3.2-3B-Instruct-GGUF',
  'bartowski/Llama-3.2-1B-Instruct-GGUF',
  'bartowski/Mistral-Small-3.1-24B-Instruct-2503-GGUF',
  'bartowski/Ministral-8B-Instruct-2410-GGUF',
  'unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF',
  'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
  'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF',
  'ggml-org/gpt-oss-20b-GGUF',
  'ggml-org/gpt-oss-120b-GGUF',
  'bartowski/granite-3.3-2b-instruct-GGUF',
  'bartowski/granite-3.2-8b-instruct-GGUF',
  'bartowski/Aya-Expanse-32B-GGUF',
  'bartowski/Command-R7B-12-2024-GGUF',
  'bartowski/Command-R-35B-v0.1-GGUF',
  'bartowski/SmolLM2-1.7B-Instruct-GGUF',
  'bartowski/Phi-4-reasoning-plus-GGUF',
  'bartowski/Phi-4-mini-reasoning-GGUF',
  'bartowski/OLMo-2-1124-13B-Instruct-GGUF',
  'bartowski/EXAONE-3.5-7.8B-Instruct-GGUF',
  'bartowski/Yi-1.5-9B-Chat-GGUF',
  'bartowski/StarCoder2-7B-GGUF',
  'bartowski/CodeGemma-7B-it-GGUF',
  'bartowski/InternLM2.5-7B-Chat-GGUF',
  'bartowski/Nemotron-Mini-4B-Instruct-GGUF',
  'bartowski/Falcon3-7B-Instruct-GGUF',
  'bartowski/StableLM-2-1_6B-Chat-GGUF',
];

const fixtureCommunityModels = fixtureCommunityRepositories.map(
  (repository, index): ModelDescriptor => ({
    id: `hf:${repository}`,
    provider: 'Hugging Face',
    name: repository.split('/')[1]!.replace('-GGUF', '').replaceAll('-', ' '),
    route: 'Local',
    tags: index % 3 === 1 ? ['GGUF', 'coding'] : ['GGUF', 'text-generation'],
    context: 'See model card',
    cost: 'Local',
    status: 'community',
    description: `Community GGUF listing by ${repository.split('/')[0]}. Review upstream files and terms before importing.`,
    fit: 'pending',
    fitReason: 'Choose a quantization on the model card to estimate device fit.',
    source: 'Hugging Face Hub',
    sourceUrl: `https://huggingface.co/${repository}`,
    downloads: Math.max(1_200, 2_800_000 - index * 51_000),
  }),
);

export function localModelActionRequest(
  action: ModelAction,
  model: ModelDescriptor,
  policy?: {
    allowRamFallback: boolean;
    maxRamGb: number;
    reserveSystemRamGb?: number;
    reserveVramGb?: number;
  },
): { method: string; params: Record<string, unknown> } {
  const nativeModel = model.runtimeModelId ?? model.id;
  if (model.provider !== 'Cupcake Local')
    throw new Error('Only app-managed Cupcake Local models support local lifecycle actions.');
  if (action === 'download')
    return {
      method: 'local_models.cupcake.download',
      params: { artifactId: nativeModel, artifactKind: 'model' },
    };
  if (action === 'benchmark')
    return { method: 'local_models.cupcake.benchmark', params: { maxTokens: 64 } };
  if (action === 'status')
    return {
      method: 'local_models.cupcake.download.status',
      params: { artifactId: nativeModel },
    };
  if (action === 'resume')
    return {
      method: 'local_models.cupcake.download',
      params: { artifactId: nativeModel, artifactKind: 'model' },
    };
  if (['pause', 'cancel', 'reset'].includes(action))
    return {
      method: `local_models.cupcake.download.${action}`,
      params: { artifactId: nativeModel },
    };
  if (action === 'unload') return { method: 'local_models.cupcake.unload', params: {} };
  if (action === 'load' && policy)
    return {
      method: 'local_models.cupcake.load',
      params: {
        modelId: nativeModel,
        allowRamFallback: policy.allowRamFallback,
        maxRamGb: policy.maxRamGb,
        reserveSystemRamGb: policy.reserveSystemRamGb,
        reserveVramGb: policy.reserveVramGb,
        ...(policy.allowRamFallback ? {} : { gpuLayers: 'all' }),
      },
    };
  return {
    method: `local_models.cupcake.${action === 'remove' ? 'remove_model' : action}`,
    params: { modelId: nativeModel },
  };
}

function mapTool(item: RuntimeTool): ToolDescriptor {
  const id = item.id ?? item.name;
  const kind =
    item.kind === 'mcp' || item.provider === 'mcp'
      ? 'mcp'
      : item.kind === 'custom'
        ? 'custom'
        : 'native';
  const effects = item.effects ?? [];
  return {
    id,
    name: item.display_name ?? cap(item.name),
    description: item.description,
    provider: item.provider ?? 'Cupcake native',
    route: effects.some((effect) => effect.includes('network') || effect.includes('external'))
      ? 'Cloud'
      : 'Local',
    enabled: item.enabled ?? true,
    permissions: [...(item.required_grants ?? []), ...effects]
      .slice(0, 4)
      .map((value) => cap(value)),
    lastUsed: 'not yet',
    kind,
  };
}

function fixtureProjects(): ProjectRecord[] {
  return [
    {
      id: 'fixture-cupcake',
      name: 'Cupcake 2.0',
      description: 'Deterministic preview project',
      archived: false,
    },
    {
      id: 'fixture-atlas',
      name: 'Atlas research',
      description: 'Deterministic preview project',
      archived: false,
    },
  ];
}

const fallbackSettings: WorkspaceSettings = {
  theme: 'light',
  wallpaper: 'none',
  offline: false,
  proactiveEnabled: false,
  developerMode: false,
  reducedMotion: false,
  scrollbarMode: 'slim',
  onboardingCompleted: false,
  profile: {
    displayName: 'Akshit',
    role: '',
    bio: '',
    avatar: 'atlas:16',
  },
  assistantAvatar: 'atlas:0',
  reasoningEffort: 'high',
  enabledToolIds: fixtureTools.filter((tool) => tool.enabled).map((tool) => tool.id),
  personalityPreset: 'balanced',
  personality: { warmth: 0.55, brevity: 0.45, initiative: 0.3 },
  personalityInstructions: '',
  semanticEnrichment: { enabled: false, provider: null, modelId: null },
  permissionMode: 'guarded',
  allowRamFallback: true,
  maxRamGb: 24,
  autoEvictLocalModels: true,
  localModelIdleMinutes: 30,
  reserveSystemRamGb: 4,
  reserveVramGb: 1.5,
};

function normalizeSettings(value: Partial<WorkspaceSettings>): WorkspaceSettings {
  return {
    ...fallbackSettings,
    ...value,
    personality: { ...fallbackSettings.personality, ...value.personality },
    semanticEnrichment: {
      ...fallbackSettings.semanticEnrichment,
      ...value.semanticEnrichment,
    },
    profile: { ...fallbackSettings.profile, ...value.profile },
  };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const fixtureMode = !window.cupcake;
  const [ready, setReady] = useState(fixtureMode);
  const [configurationReady, setConfigurationReady] = useState(fixtureMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>(fixtureMode ? fixtureProjects() : []);
  const [conversations, setConversations] = useState<Conversation[]>(
    fixtureMode ? fixtureConversations : [],
  );
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>(fixtureMode ? fixtureTasks : []);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>(
    fixtureMode
      ? fixtureArtifacts.map((item) => ({
          id: item.id,
          projectId: 'fixture-cupcake',
          name: item.name,
          kind: item.type,
          revisionNumber: Number(item.revisions) || 1,
          updatedAt: item.updated,
        }))
      : [],
  );
  const [memories, setMemories] = useState<MemoryRecord[]>(fixtureMode ? fixtureMemories : []);
  const [models, setModels] = useState<ModelDescriptor[]>(fixtureMode ? fixtureModels : []);
  const [tools, setTools] = useState<ToolDescriptor[]>(fixtureMode ? fixtureTools : []);
  const [searchResults, setSearchResults] = useState<SearchRecord[]>([]);
  const [hardware, setHardware] = useState<HardwareRecord | null>(null);
  const [localRuntimes, setLocalRuntimes] = useState<LocalRuntimeRecord[]>([]);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [legacyMigration, setLegacyMigration] = useState<LegacyMigrationState | null>(null);
  const [settings, setSettings] = useState<WorkspaceSettings>(() => {
    const stored = localStorage.getItem('cupcake-workspace-settings');
    const fixtureOnboardingComplete =
      fixtureMode && new URLSearchParams(window.location.search).get('onboarding') !== '1';
    if (!stored)
      return fixtureOnboardingComplete
        ? { ...fallbackSettings, onboardingCompleted: true }
        : fallbackSettings;
    try {
      const normalized = normalizeSettings(JSON.parse(stored) as Partial<WorkspaceSettings>);
      return fixtureOnboardingComplete ? { ...normalized, onboardingCompleted: true } : normalized;
    } catch {
      return fallbackSettings;
    }
  });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bootstrapped = useRef(false);
  const nvidiaCatalogRefresh = useRef<Promise<void> | null>(null);
  const selectedModelIdRef = useRef<string | null>(
    fixtureModels.find((model) => model.selected)?.id ?? null,
  );
  const coalesceModelSelection = useRef(createKeyedRequestCoalescer());
  const activeProjectIdRef = useRef(activeProjectId);
  const activeRunIdRef = useRef(activeRunId);
  const projectsRef = useRef(projects);
  activeProjectIdRef.current = activeProjectId;
  activeRunIdRef.current = activeRunId;
  projectsRef.current = projects;

  const updateActiveRunId = useCallback((runId: string | null) => {
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
  }, []);

  const request = useCallback(
    async <T,>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
      if (!window.cupcake)
        throw new Error('Desktop bridge unavailable in deterministic fixture mode');
      const response: RuntimeResponse<T> = await window.cupcake.runtime.request({
        method,
        params,
        timeoutMs,
      });
      if (!response.ok) {
        throw new RuntimeRequestFailure(
          response.error?.code ?? 'RUNTIME_REQUEST_FAILED',
          response.error?.message ?? `${method} failed`,
        );
      }
      return response.result as T;
    },
    [],
  );

  const guard = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (reason instanceof RuntimeRequestFailure && reason.code === 'CANCELLED') return;
      setError(reason instanceof Error ? reason.message : 'The runtime request failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadArtifacts = useCallback(
    async (projectId: string | null) => {
      if (!projectId || fixtureMode) {
        if (!fixtureMode) setArtifacts([]);
        return;
      }
      const result = await request<RuntimeArtifact[]>('artifacts.list', { projectId });
      setArtifacts(
        result.map((item) => ({
          id: item.id ?? item.artifact_id ?? '',
          projectId: item.project_id,
          name: item.name,
          kind: item.kind ?? item.artifact_type ?? 'Document',
          content: item.content,
          revisionId: item.revision_id,
          revisionNumber: item.revision_number,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          size: item.size,
        })),
      );
    },
    [fixtureMode, request],
  );

  const refresh = useCallback(async () => {
    if (fixtureMode) return;
    await guard(async () => {
      // The broker handshake completes before its one-file Python runtime has
      // necessarily been extracted and opened its encrypted stores. Warm that
      // sidecar with an idempotent health check before the first product query.
      // Retrying this read-only operation is safe and prevents a cold launch
      // race from stranding the renderer on its opening screen.
      let healthFailure: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await request('runtime.health', {}, 120_000);
          healthFailure = null;
          break;
        } catch (reason) {
          healthFailure =
            reason instanceof Error ? reason : new Error('The local runtime health check failed.');
          if (attempt < 2)
            await new Promise<void>((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
      if (healthFailure) throw healthFailure;
      type RuntimeBootstrap = {
        selectedModelId?: string;
        projects?: RuntimeProject[];
        conversations?: RuntimeConversation[];
        models?: RuntimeModel[];
        tools?: RuntimeTool[];
        hardware?: HardwareRecord;
        localRuntimes?: Array<string | LocalRuntimeRecord>;
        suggestionsEnabled?: boolean;
      };
      let bootstrap: RuntimeBootstrap | null = null;
      let bootstrapFailure: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          bootstrap = await request<RuntimeBootstrap>('app.bootstrap', {}, 300_000);
          bootstrapFailure = null;
          break;
        } catch (reason) {
          bootstrapFailure =
            reason instanceof Error ? reason : new Error('The local workspace could not open.');
          if (attempt < 2)
            await new Promise<void>((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
      if (!bootstrap) throw bootstrapFailure ?? new Error('The local workspace could not open.');
      selectedModelIdRef.current = bootstrap.selectedModelId ?? selectedModelIdRef.current;
      const projectRecords = (bootstrap.projects ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        archived: item.status === 'archived',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      }));
      setProjects(projectRecords);
      setConversations(
        (bootstrap.conversations ?? []).map((item) => mapConversation(item, projectRecords)),
      );
      setTools((bootstrap.tools ?? []).map(mapTool));
      const selectedProject =
        activeProjectId && projectRecords.some((item) => item.id === activeProjectId)
          ? activeProjectId
          : (projectRecords[0]?.id ?? null);
      setActiveProjectId(selectedProject);
      // The encrypted navigation shell and conversation list are now useful.
      // Optional models, hardware, tasks, memory, providers, migration and
      // developer diagnostics hydrate below without holding the first
      // interactive frame hostage.
      setReady(true);
      const auxiliaryFailures: string[] = [];
      const recover = async <T,>(label: string, operation: Promise<T>, fallback: T): Promise<T> => {
        const result = await recoverWorkspaceSupportRequest(label, operation, fallback);
        if (result.failure) auxiliaryFailures.push(result.failure);
        return result.value;
      };
      const memoryRequest = request<RuntimeMemory[]>('memory.list', {
        states: ['active', 'candidate', 'superseded', 'expired'],
      }).catch(() => request<RuntimeMemory[]>('memory.list'));
      const [
        taskResult,
        memoryResult,
        providerResult,
        runtimeSettings,
        permissionPolicy,
        migration,
        cupcakeStatus,
      ] = await Promise.all([
        recover('Tasks', request<RuntimeTask[]>('tasks.list'), []),
        recover('Memory', memoryRequest, []),
        recover(
          'Providers',
          request<{
            providers: Array<{
              provider: string;
              configured: boolean;
              catalog?: { models?: Array<Record<string, unknown>> };
            }>;
          }>('providers.status'),
          { providers: [] },
        ),
        recover('Settings', request<Record<string, unknown>>('settings.list'), {}),
        recover('Permission policy', request<{ mode?: string }>('broker.permission_mode.get'), {
          mode: 'guarded',
        }),
        recover('Migration', request<LegacyMigrationState>('migration.detect'), {
          available: false,
          state: 'unavailable',
        }),
        recover<CupcakeLocalStatus>(
          'Cupcake Local status',
          request<CupcakeLocalStatus>('local_models.cupcake.status', {}, 120_000),
          {},
        ),
      ]);
      const localStatus = cupcakeStatus ?? {};
      setTasks(taskResult.map(mapTask));
      setMemories(memoryResult.map((item) => mapMemory(item, projectRecords)));
      setProviders(
        Object.fromEntries(
          providerResult.providers.map((item) => [item.provider, item.configured]),
        ),
      );
      const configuredProviders = Object.fromEntries(
        providerResult.providers.map((item) => [item.provider, item.configured]),
      );
      const discoveredModels = providerResult.providers.flatMap(
        (item) => item.catalog?.models ?? [],
      );
      const allRuntimeModels: RuntimeModel[] = [...(bootstrap.models ?? []), ...discoveredModels]
        .map((item) => item as unknown as RuntimeModel)
        .filter((item) => item.provider !== 'mock' && item.privacy_route !== 'local');
      const uniqueRuntimeModels = [
        ...new Map(
          allRuntimeModels.map((item) => [
            item.id ?? item.model_id ?? `${item.provider}:${item.model ?? 'model'}`,
            item,
          ]),
        ).values(),
      ];
      setModels((current) => {
        const mappedRuntimeModels = uniqueRuntimeModels.map((item) => {
          const mapped = mapModel(item, bootstrap.selectedModelId);
          const provider = textValue(item.provider ?? item.metadata?.provider);
          return {
            ...mapped,
            status:
              mapped.route === 'Local'
                ? mapped.status
                : provider && configuredProviders[provider]
                  ? ('ready' as const)
                  : ('setup' as const),
          };
        });
        const cupcakeCatalog = mapCupcakeLocalModels(
          localStatus,
          selectedModelIdRef.current ?? undefined,
        );
        return mergeModelDescriptors(
          current.filter(
            (item) => item.provider !== 'Cupcake Local' && item.provider !== 'Mock Cupcake',
          ),
          [...mappedRuntimeModels, ...cupcakeCatalog],
          selectedModelIdRef.current,
        );
      });
      setHardware(normalizeHardware(localStatus.hardware ?? bootstrap.hardware));
      setLocalRuntimes(mapCupcakeRuntimePacks(localStatus));
      if (configuredProviders['nvidia-nim']) {
        if (!nvidiaCatalogRefresh.current) {
          const refreshCatalog = request<Record<string, unknown>>(
            'providers.catalog.refresh',
            { provider: 'nvidia-nim' },
            120_000,
          )
            .then((result) => {
              const catalog = recordValue(result.catalog);
              const catalogModels = Array.isArray(result.models)
                ? (result.models as Array<Record<string, unknown>>)
                : Array.isArray(catalog?.models)
                  ? (catalog.models as Array<Record<string, unknown>>)
                  : [];
              if (!catalogModels.length) return;
              setModels((current) => {
                const incoming = catalogModels.map((item) => ({
                  ...mapModel(
                    {
                      ...item,
                      provider: textValue(item.provider, 'nvidia-nim'),
                    },
                    selectedModelIdRef.current ?? undefined,
                  ),
                  status: 'ready' as const,
                }));
                return mergeModelDescriptors(current, incoming, selectedModelIdRef.current);
              });
            })
            .catch((reason) => {
              setError(
                reason instanceof Error
                  ? `NVIDIA NIM catalog is unavailable: ${reason.message}`
                  : 'NVIDIA NIM catalog is unavailable. Reopen Models to retry.',
              );
            })
            .finally(() => {
              nvidiaCatalogRefresh.current = null;
            });
          nvidiaCatalogRefresh.current = refreshCatalog;
          void refreshCatalog;
        }
      }
      if (auxiliaryFailures.length) {
        setError(
          `The workspace opened, but some supporting data could not refresh. ${auxiliaryFailures.join(
            ' · ',
          )}. Use Retry on the Models page after the runtime is ready.`,
        );
      }
      setLegacyMigration(
        migration.available && !['declined', 'completed'].includes(migration.state)
          ? migration
          : null,
      );
      setSettings((current) => ({
        ...current,
        theme:
          runtimeSettings['appearance.theme'] === 'cupcake-dark'
            ? 'dark'
            : runtimeSettings['appearance.theme'] === 'minimal'
              ? 'minimal'
              : runtimeSettings['appearance.theme'] === 'classic'
                ? 'classic'
                : 'light',
        wallpaper:
          runtimeSettings['appearance.wallpaper'] === 'moonlit-archive' ||
          runtimeSettings['appearance.wallpaper'] === 'pistachio-atelier' ||
          runtimeSettings['appearance.wallpaper'] === 'blueberry-observatory' ||
          runtimeSettings['appearance.wallpaper'] === 'copper-workshop'
            ? runtimeSettings['appearance.wallpaper']
            : 'none',
        offline: runtimeSettings['privacy.default_mode'] === 'offline',
        proactiveEnabled:
          typeof runtimeSettings['proactive.enabled'] === 'boolean'
            ? runtimeSettings['proactive.enabled']
            : (bootstrap.suggestionsEnabled ?? false),
        developerMode: runtimeSettings['developer.enabled'] === true,
        reducedMotion: runtimeSettings['accessibility.reduced_motion'] === true,
        scrollbarMode:
          runtimeSettings['appearance.scrollbars'] === 'minimal' ||
          runtimeSettings['appearance.scrollbars'] === 'hidden'
            ? runtimeSettings['appearance.scrollbars']
            : 'slim',
        onboardingCompleted: runtimeSettings['onboarding.completed_v1'] === true,
        profile: {
          displayName: textValue(
            runtimeSettings['profile.display_name'],
            current.profile.displayName,
          ),
          role: textValue(runtimeSettings['profile.role'], current.profile.role),
          bio: textValue(runtimeSettings['profile.bio'], current.profile.bio),
          avatar: textValue(runtimeSettings['profile.avatar'], current.profile.avatar),
        },
        assistantAvatar: textValue(runtimeSettings['assistant.avatar'], current.assistantAvatar),
        personalityPreset:
          (runtimeSettings['personality.preset'] as WorkspaceSettings['personalityPreset']) ??
          current.personalityPreset,
        personality: {
          warmth: Number(runtimeSettings['personality.warmth'] ?? current.personality.warmth),
          brevity: Number(runtimeSettings['personality.brevity'] ?? current.personality.brevity),
          initiative: Number(
            runtimeSettings['personality.initiative'] ?? current.personality.initiative,
          ),
        },
        personalityInstructions: textValue(
          runtimeSettings['personality.custom_instructions'],
          current.personalityInstructions,
        ),
        semanticEnrichment: {
          enabled: runtimeSettings['retrieval.semantic.enabled'] === true,
          provider:
            typeof runtimeSettings['retrieval.semantic.provider'] === 'string'
              ? runtimeSettings['retrieval.semantic.provider']
              : null,
          modelId:
            typeof runtimeSettings['retrieval.semantic.model_id'] === 'string'
              ? runtimeSettings['retrieval.semantic.model_id']
              : null,
        },
        enabledToolIds: Array.isArray(runtimeSettings['tools.enabled'])
          ? (runtimeSettings['tools.enabled'] as string[])
          : current.enabledToolIds,
        permissionMode: permissionPolicy?.mode === 'full-freedom' ? 'full-freedom' : 'guarded',
        allowRamFallback: runtimeSettings['models.local.allow_ram_fallback'] !== false,
        maxRamGb: Math.max(
          4,
          Math.min(256, Number(runtimeSettings['models.local.max_ram_gb'] ?? current.maxRamGb)),
        ),
        autoEvictLocalModels: runtimeSettings['models.local.auto_evict'] !== false,
        localModelIdleMinutes: Math.max(
          1,
          Math.min(
            240,
            Number(runtimeSettings['models.local.idle_minutes'] ?? current.localModelIdleMinutes),
          ),
        ),
        reserveSystemRamGb: Math.max(
          2,
          Math.min(
            64,
            Number(
              runtimeSettings['models.local.reserve_system_ram_gb'] ?? current.reserveSystemRamGb,
            ),
          ),
        ),
        reserveVramGb: Math.max(
          0.5,
          Math.min(
            16,
            Number(runtimeSettings['models.local.reserve_vram_gb'] ?? current.reserveVramGb),
          ),
        ),
      }));
      setConfigurationReady(true);
      void request<Array<Record<string, unknown>>>('developer.events', { limit: 500 })
        .then((items) =>
          setRuntimeEvents(
            items.map((item, index) => ({
              sequence: Number(item.sequence ?? index + 1),
              type: textValue(item.type ?? item.event_type, 'runtime.event'),
              payload: item.payload ?? item.detail ?? {},
              timestamp: textValue(item.timestamp ?? item.created_at, new Date().toISOString()),
            })),
          ),
        )
        .catch(() => undefined);
      await loadArtifacts(selectedProject);
    });
  }, [activeProjectId, fixtureMode, guard, loadArtifacts, request]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.cupcake) return undefined;
    const stopEvents = window.cupcake.runtime.onEvent((event) => {
      setRuntimeEvents((items) => [event, ...items].slice(0, 500));
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
      setMessages((items) => applyRuntimeMessageEvent(items, event, activeRunIdRef.current));
      if (event.type === 'message.started' && runId) {
        updateActiveRunId(runId);
      } else if (
        event.type === 'message.completed' ||
        event.type === 'message.cancelled' ||
        runtimeFailureEvent(event.type)
      ) {
        if (!runId || activeRunIdRef.current === runId) updateActiveRunId(null);
        if (runtimeFailureEvent(event.type)) setError(runtimeFailureMessage(payload));
      }
      if (event.type.startsWith('artifact.')) {
        void loadArtifacts(activeProjectIdRef.current).catch(() => undefined);
      } else if (event.type.startsWith('memory.')) {
        void request<RuntimeMemory[]>('memory.list', {
          states: ['active', 'candidate', 'superseded', 'expired'],
        })
          .then((items) => setMemories(items.map((item) => mapMemory(item, projectsRef.current))))
          .catch(() => undefined);
      } else if (
        event.type.startsWith('local_model.download') ||
        event.type.startsWith('model.download')
      ) {
        const downloadPayload = recordValue(payload.download) ?? payload;
        const modelId = textValue(
          downloadPayload.modelId ??
            downloadPayload.model_id ??
            payload.modelId ??
            payload.model_id,
        );
        const state = textValue(downloadPayload.state, 'downloading');
        setModels((items) =>
          items.map((item) =>
            item.id === modelId || item.runtimeModelId === modelId
              ? {
                  ...item,
                  status: localDownloadState(state, textValue(downloadPayload.error_code)),
                  download: {
                    bytesReceived: Number(
                      downloadPayload.bytesReceived ?? downloadPayload.bytes_downloaded ?? 0,
                    ),
                    totalBytes: Number(
                      downloadPayload.totalBytes ??
                        downloadPayload.bytes_total ??
                        item.fileSizeBytes ??
                        0,
                    ),
                    bytesPerSecond: Number(
                      downloadPayload.bytesPerSecond ?? downloadPayload.bytes_per_second ?? 0,
                    ),
                    checksumState:
                      state === 'verifying'
                        ? 'verifying'
                        : typeof downloadPayload.checksumState === 'string'
                          ? downloadPayload.checksumState
                          : undefined,
                    diskState:
                      typeof downloadPayload.diskState === 'string'
                        ? downloadPayload.diskState
                        : undefined,
                    state,
                  },
                  progress:
                    Number(downloadPayload.totalBytes ?? downloadPayload.bytes_total ?? 0) > 0
                      ? Math.round(
                          (Number(
                            downloadPayload.bytesReceived ?? downloadPayload.bytes_downloaded ?? 0,
                          ) /
                            Number(downloadPayload.totalBytes ?? downloadPayload.bytes_total)) *
                            100,
                        )
                      : undefined,
                }
              : item,
          ),
        );
      } else if (event.type.startsWith('task.')) {
        void request<RuntimeTask[]>('tasks.list')
          .then((items) => setTasks(items.map(mapTask)))
          .catch(() => undefined);
      } else if (event.type.startsWith('tool.') || event.type.startsWith('approval.')) {
        const activity: ToolActivity = {
          id: `${event.sequence}`,
          type: event.type.includes('approval')
            ? 'approval'
            : event.type.includes('preflight')
              ? 'preflight'
              : 'result',
          status: textValue(payload.status ?? payload.decision, 'received'),
          toolName: textValue(payload.toolName ?? payload.tool, 'Tool'),
          summary: textValue(payload.summary, event.type),
          payload,
          createdAt: event.timestamp,
        };
        setToolActivity((items) => [activity, ...items].slice(0, 100));
      }
    });
    return stopEvents;
  }, [loadArtifacts, request, updateActiveRunId]);

  useEffect(() => {
    localStorage.setItem('cupcake-workspace-settings', JSON.stringify(settings));
  }, [settings]);

  const setActiveProject = useCallback(
    async (projectId: string | null) => {
      setActiveProjectId(projectId);
      setActiveConversationId(null);
      setActiveBranchId(null);
      setMessages([]);
      if (!fixtureMode)
        await guard(async () => {
          const [conversationItems, memoryItems] = await Promise.all([
            request<RuntimeConversation[]>('conversations.list', {
              projectId,
              includeArchived: true,
            }),
            request<RuntimeMemory[]>('memory.list', {
              projectId,
              includeGlobal: true,
              states: ['active', 'candidate', 'superseded', 'expired'],
            }),
          ]);
          setConversations(conversationItems.map((item) => mapConversation(item, projects)));
          setMemories(memoryItems.map((item) => mapMemory(item, projects)));
          await loadArtifacts(projectId);
        });
    },
    [fixtureMode, guard, loadArtifacts, projects, request],
  );

  const createProject = useCallback(
    async (name: string, description = '') => {
      if (fixtureMode) {
        setProjects((items) => [
          ...items,
          { id: `fixture-${Date.now()}`, name, description, archived: false },
        ]);
        return;
      }
      await guard(async () => {
        const item = await request<RuntimeProject>('projects.create', { name, description });
        const record = {
          id: item.id,
          name: item.name,
          description: item.description ?? '',
          archived: false,
        };
        setProjects((items) => [...items, record]);
        await setActiveProject(record.id);
      });
    },
    [fixtureMode, guard, request, setActiveProject],
  );

  const createConversation = useCallback(
    async (title = 'New conversation') => {
      if (fixtureMode) {
        const id = `fixture-conversation-${Date.now()}`;
        const branchId = `fixture-branch-${Date.now()}`;
        setConversations((items) => [
          { id, title, preview: 'Deterministic fixture', updated: 'now' },
          ...items,
        ]);
        setActiveConversationId(id);
        setActiveBranchId(branchId);
        setMessages([]);
        return { conversationId: id, branchId, projectId: activeProjectId };
      }
      let created: { conversationId: string; branchId: string; projectId: string | null } | null =
        null;
      await guard(async () => {
        const result = await request<{ conversation: RuntimeConversation; branch: RuntimeBranch }>(
          'conversations.create',
          {
            title,
            projectId: activeProjectId,
          },
        );
        setConversations((items) => [mapConversation(result.conversation, projects), ...items]);
        setBranches([
          {
            id: result.branch.id,
            conversationId: result.branch.conversation_id,
            name: result.branch.name ?? 'Main',
            headMessageId: result.branch.head_message_id,
            parentMessageId: result.branch.parent_message_id,
          },
        ]);
        setActiveConversationId(result.conversation.id);
        setActiveBranchId(result.branch.id);
        setMessages([]);
        created = {
          conversationId: result.conversation.id,
          branchId: result.branch.id,
          projectId: activeProjectId,
        };
      });
      return created;
    },
    [activeProjectId, fixtureMode, guard, projects, request],
  );

  const selectConversation = useCallback(
    async (conversationId: string) => {
      setActiveConversationId(conversationId);
      if (fixtureMode) return;
      await guard(async () => {
        const result = await request<{ branches: RuntimeBranch[]; activeBranchId?: string }>(
          'conversations.get',
          { conversationId },
        );
        const branchRecords = (result.branches ?? []).map((item) => ({
          id: item.id,
          conversationId: item.conversation_id,
          name: item.name ?? 'Branch',
          headMessageId: item.head_message_id,
          parentMessageId: item.parent_message_id,
        }));
        const branchId = result.activeBranchId ?? branchRecords[0]?.id ?? null;
        setBranches(branchRecords);
        setActiveBranchId(branchId);
        if (branchId) {
          const history = await request<RuntimeMessage[]>('chat.history', { branchId });
          setMessages(history.map(mapRuntimeMessage));
        } else setMessages([]);
      });
    },
    [fixtureMode, guard, request],
  );

  const selectBranch = useCallback(
    async (branchId: string) => {
      const branch = branches.find((item) => item.id === branchId);
      if (!branch) return;
      setActiveConversationId(branch.conversationId);
      setActiveBranchId(branchId);
      if (fixtureMode) return;
      await guard(async () => {
        const history = await request<RuntimeMessage[]>('chat.history', { branchId });
        setMessages(history.map(mapRuntimeMessage));
      });
    },
    [branches, fixtureMode, guard, request],
  );

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      if (!fixtureMode) await request('conversations.rename', { conversationId, title });
      setConversations((items) =>
        items.map((item) => (item.id === conversationId ? { ...item, title } : item)),
      );
    },
    [fixtureMode, request],
  );

  const archiveConversation = useCallback(
    async (conversationId: string, archived: boolean) => {
      if (!fixtureMode) await request('conversations.archive', { conversationId, archived });
      setConversations((items) =>
        items.map((item) => (item.id === conversationId ? { ...item, archived } : item)),
      );
    },
    [fixtureMode, request],
  );

  const branchConversation = useCallback(
    async (fromMessageId?: string, name = 'Branch') => {
      if (!activeConversationId) return;
      if (fixtureMode) return;
      await guard(async () => {
        const item = await request<RuntimeBranch>('conversations.branch', {
          conversationId: activeConversationId,
          fromMessageId,
          name,
        });
        const record = {
          id: item.id,
          conversationId: item.conversation_id,
          name: item.name ?? name,
          headMessageId: item.head_message_id,
          parentMessageId: item.parent_message_id,
        };
        setBranches((items) => [...items, record]);
        setActiveBranchId(item.id);
        const history = await request<RuntimeMessage[]>('chat.history', { branchId: item.id });
        setMessages(history.map(mapRuntimeMessage));
      });
    },
    [activeConversationId, fixtureMode, guard, request],
  );

  const sendMessage = useCallback(
    async (input: Parameters<WorkspaceContextValue['sendMessage']>[0]) => {
      if (
        settings.offline &&
        !models
          .find((item) => item.id === input.modelId || item.runtimeModelId === input.modelId)
          ?.route.startsWith('Local')
      ) {
        setError('Offline mode blocked this cloud model. Choose a local model before sending.');
        return false;
      }
      const optimisticId = `user-${Date.now()}`;
      if (shouldOptimisticallyAppendUser(input.mode)) {
        setMessages((items) => [
          ...items,
          {
            id: optimisticId,
            role: 'user',
            content: input.content,
            attachments: input.attachments,
            references: input.references,
          },
        ]);
      }
      if (fixtureMode) {
        setMessages((items) => [
          ...items,
          {
            id: `fixture-reply-${Date.now()}`,
            role: 'assistant',
            content:
              'Deterministic fixture response. The desktop bridge is absent, so no provider or tool was contacted.',
          },
        ]);
        return true;
      }
      setBusy(true);
      setError(null);
      try {
        const method =
          input.mode === 'edit'
            ? 'chat.edit'
            : input.mode === 'regenerate' || input.mode === 'retry'
              ? 'chat.regenerate'
              : input.mode === 'continue'
                ? 'chat.continue'
                : 'chat.send';
        const stableIntent = input.outboundIntent;
        const attachmentItems = structuredAttachments(input.attachments);
        const referenceItems = structuredReferences(input.references ?? []);
        const memoryIds =
          stableIntent?.memoryIds ?? memories.filter((item) => item.enabled).map((item) => item.id);
        const toolIds = stableIntent?.toolIds ?? input.enabledToolIds;
        const result = await request<{
          conversationId: string;
          branchId: string;
          runId?: string;
          content?: string;
          message?: RuntimeMessage;
        }>(
          method,
          {
            content: input.content,
            messageId: input.messageId,
            conversationId: stableIntent
              ? stableIntent.conversationId
              : (input.conversationId ?? activeConversationId),
            branchId: stableIntent ? stableIntent.branchId : (input.branchId ?? activeBranchId),
            projectId: stableIntent
              ? stableIntent.projectId
              : input.projectId !== undefined
                ? input.projectId
                : activeProjectId,
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
            enabledToolIds: input.enabledToolIds,
            personalityPreset: settings.personalityPreset,
            personality: settings.personality,
            personalityInstructions: settings.personalityInstructions,
            offline: settings.offline,
            outboundConfirmationToken: input.outboundConfirmationToken,
            outboundIntent: stableIntent,
            attachments: attachmentItems,
            attachmentHandles: attachmentItems.map((item) => item.handleId),
            references: referenceItems,
            referenceIds: referenceItems.map((item) => item.id),
            memoryIds,
            toolIds,
          },
          120_000,
        );
        setActiveConversationId(result.conversationId);
        setActiveBranchId(result.branchId);
        if (result.content) {
          const messageId = result.runId ?? result.message?.run_id ?? result.message?.id;
          setMessages((items) => {
            if (messageId && items.some((item) => item.id === messageId)) return items;
            return [
              ...items,
              {
                id: messageId ?? `assistant-${Date.now()}`,
                role: 'assistant',
                content: result.content ?? '',
                branchId: result.message?.branch_id,
                createdAt: result.message?.created_at,
                modelId: result.message?.model_id,
                providerId: result.message?.provider_id,
              },
            ];
          });
        }
        const refreshErrors: string[] = [];
        try {
          const history = await request<RuntimeMessage[]>('chat.history', {
            branchId: result.branchId,
          });
          setMessages(history.map(mapRuntimeMessage));
        } catch (reason) {
          refreshErrors.push(reason instanceof Error ? reason.message : 'history refresh failed');
        }
        const [conversationList, conversationState] = await Promise.all([
          recoverWorkspaceSupportRequest(
            'Conversation list refresh',
            request<RuntimeConversation[]>('conversations.list', {
              projectId: stableIntent ? stableIntent.projectId : activeProjectId,
              includeArchived: true,
            }),
            [] as RuntimeConversation[],
          ),
          recoverWorkspaceSupportRequest(
            'Branch refresh',
            request<{ branches: RuntimeBranch[] }>('conversations.get', {
              conversationId: result.conversationId,
            }),
            { branches: [] as RuntimeBranch[] },
          ),
        ]);
        if (!conversationList.failure) {
          setConversations(conversationList.value.map((item) => mapConversation(item, projects)));
        } else refreshErrors.push(conversationList.failure);
        if (!conversationState.failure) {
          setBranches(
            (conversationState.value.branches ?? []).map((item) => ({
              id: item.id,
              conversationId: item.conversation_id,
              name: item.name ?? 'Branch',
              headMessageId: item.head_message_id,
              parentMessageId: item.parent_message_id,
            })),
          );
        } else refreshErrors.push(conversationState.failure);
        if (refreshErrors.length) {
          setError(
            `Message sent, but the conversation refresh failed: ${refreshErrors.join('; ')}`,
          );
        }
        return true;
      } catch (reason) {
        if (!(reason instanceof RuntimeRequestFailure && reason.code === 'CANCELLED')) {
          setError(reason instanceof Error ? reason.message : 'The runtime request failed');
        }
        if (shouldOptimisticallyAppendUser(input.mode)) {
          setMessages((items) => items.filter((item) => item.id !== optimisticId));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [
      activeBranchId,
      activeConversationId,
      activeProjectId,
      fixtureMode,
      memories,
      models,
      projects,
      request,
      settings,
    ],
  );

  const stopRun = useCallback(async () => {
    if (!activeRunId) return;
    if (window.cupcake) await window.cupcake.runtime.cancel(activeRunId);
    updateActiveRunId(null);
    setMessages((items) =>
      items.map((item) => (item.streaming ? { ...item, streaming: false } : item)),
    );
  }, [activeRunId, updateActiveRunId]);
  const preflightCloudDisclosure = useCallback(
    async (input: {
      content: string;
      modelId: string;
      attachments: StagedAttachmentRecord[];
      references: ReferenceRecord[];
      enabledToolIds?: string[];
      messageId?: string;
      conversationId?: string;
      branchId?: string;
      projectId?: string | null;
    }) =>
      request<{
        confirmationToken: string | null;
        disclosure: { privacyRoute?: string; costClass?: string };
        outboundIntent: OutboundIntent;
      }>('chat.preflight', {
        content: input.content,
        modelId: input.modelId,
        projectId: input.projectId !== undefined ? input.projectId : activeProjectId,
        conversationId: input.conversationId ?? activeConversationId,
        branchId: input.branchId ?? activeBranchId,
        messageId: input.messageId,
        attachments: structuredAttachments(input.attachments),
        attachmentHandles: input.attachments.map((item) => item.handleId),
        references: structuredReferences(input.references),
        referenceIds: input.references.map((item) => item.id),
        memoryIds: memories.filter((item) => item.enabled).map((item) => item.id),
        toolIds: input.enabledToolIds ?? settings.enabledToolIds,
      }),
    [
      activeBranchId,
      activeConversationId,
      activeProjectId,
      memories,
      request,
      settings.enabledToolIds,
    ],
  );

  const copyMessage = useCallback(
    async (messageId: string) => {
      const item = messages.find((candidate) => candidate.id === messageId);
      if (!item) return false;
      await navigator.clipboard.writeText(item.content);
      return true;
    },
    [messages],
  );

  const taskAction = useCallback(
    async (method: string, runId: string, params: Record<string, unknown> = {}) => {
      if (!fixtureMode) await request(method, { runId, ...params });
      if (!fixtureMode) {
        const items = await request<RuntimeTask[]>('tasks.list');
        setTasks(items.map(mapTask));
      }
    },
    [fixtureMode, request],
  );
  const cancelTask = useCallback(
    (runId: string) => taskAction('tasks.cancel', runId),
    [taskAction],
  );
  const resumeTask = useCallback(
    (runId: string) => taskAction('tasks.resume', runId),
    [taskAction],
  );
  const steerTask = useCallback(
    (runId: string, instruction: string) => taskAction('tasks.steer', runId, { instruction }),
    [taskAction],
  );
  const followupTask = useCallback(
    (runId: string, prompt: string) => taskAction('tasks.followup', runId, { prompt }),
    [taskAction],
  );

  const remember = useCallback(
    async (input: { key: string; content: string; kind?: string; sensitive?: boolean }) => {
      if (fixtureMode) return;
      const item = await request<RuntimeMemory>('memory.remember', {
        ...input,
        projectId: activeProjectId,
        scope: activeProjectId ? 'project' : 'global',
        explicit: true,
      });
      setMemories((items) => [mapMemory(item, projects), ...items]);
    },
    [activeProjectId, fixtureMode, projects, request],
  );

  const updateMemory = useCallback(
    async (record: MemoryRecord) => {
      if (!fixtureMode)
        await request('memory.remember', {
          memoryId: record.id,
          key: record.title,
          content: record.body,
          pinned: record.pinned ?? false,
          explicit: true,
          projectId: activeProjectId,
          scope: activeProjectId ? 'project' : 'global',
        });
      setMemories((items) => items.map((item) => (item.id === record.id ? record : item)));
    },
    [activeProjectId, fixtureMode, request],
  );
  const setMemoryEnabled = useCallback(
    async (record: MemoryRecord, enabled: boolean) => {
      if (!fixtureMode)
        await request(
          enabled ? 'memory.activate' : 'memory.forget',
          enabled
            ? { memoryId: record.id }
            : {
                memoryId: record.id,
                key: record.title,
                projectId: activeProjectId,
                scope: activeProjectId ? 'project' : 'global',
                reason: 'disabled by user',
              },
        );
      setMemories((items) =>
        items.map((item) => (item.id === record.id ? { ...item, enabled } : item)),
      );
    },
    [activeProjectId, fixtureMode, request],
  );
  const forgetMemory = useCallback(
    async (record: MemoryRecord) => {
      if (!fixtureMode)
        await request('memory.forget', {
          memoryId: record.id,
          key: record.title,
          projectId: activeProjectId,
          scope: activeProjectId ? 'project' : 'global',
        });
      setMemories((items) => items.filter((item) => item.id !== record.id));
    },
    [activeProjectId, fixtureMode, request],
  );

  const createArtifact = useCallback(
    async (name: string, kind: string, content: string) => {
      if (!activeProjectId || fixtureMode) return;
      await request('artifacts.create', { projectId: activeProjectId, name, kind, content });
      await loadArtifacts(activeProjectId);
    },
    [activeProjectId, fixtureMode, loadArtifacts, request],
  );
  const reviseArtifact = useCallback(
    async (artifact: ArtifactRecord, content: string) => {
      if (!fixtureMode)
        await request('artifacts.revise', {
          artifactId: artifact.id,
          projectId: artifact.projectId,
          content,
          expectedRevisionId: artifact.revisionId,
        });
      setArtifacts((items) =>
        items.map((item) =>
          item.id === artifact.id
            ? { ...item, content, revisionNumber: (item.revisionNumber ?? 0) + 1 }
            : item,
        ),
      );
    },
    [fixtureMode, request],
  );
  const exportArtifact = useCallback(
    async (artifact: ArtifactRecord) => {
      const target = await window.cupcake?.dialog.chooseSaveTarget(artifact.name);
      if (!target) return;
      try {
        await request('artifacts.export.intent', {
          artifactId: artifact.id,
          targetHandleId: target.id,
        });
      } finally {
        await window.cupcake?.dialog.releaseHandle(target.id);
      }
    },
    [request],
  );

  const querySearch = useCallback(
    async (query: string, globalScope = false) => {
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }
      if (fixtureMode) {
        setSearchResults(
          fixtureConversations
            .filter((item) =>
              `${item.title} ${item.preview}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((item) => ({
              id: item.id,
              entityType: 'conversation',
              title: item.title,
              snippet: item.preview,
            })),
        );
        return;
      }
      const items = await request<Array<Record<string, unknown>>>('search.query', {
        query,
        projectId: globalScope ? undefined : activeProjectId,
        global: globalScope,
      });
      setSearchResults(
        items.map((item) => ({
          id: textValue(item.id ?? item.entity_id),
          entityType: textValue(item.entity_type ?? item.kind, 'result'),
          title: textValue(item.title ?? item.name, 'Result'),
          snippet: textValue(item.snippet ?? item.text),
          projectId: typeof item.project_id === 'string' ? item.project_id : null,
          score: typeof item.score === 'number' ? item.score : undefined,
        })),
      );
    },
    [activeProjectId, fixtureMode, request],
  );

  const selectModel = useCallback(
    async (id: string, options?: { compatibilityConfirmed?: boolean }) => {
      const compatibilityConfirmed = options?.compatibilityConfirmed === true;
      await coalesceModelSelection.current(
        `${id}:${compatibilityConfirmed ? 'confirmed' : 'standard'}`,
        async () => {
          if (!fixtureMode)
            await request('models.select', {
              modelId: id,
              compatibilityConfirmed,
            });
          selectedModelIdRef.current = id;
          setModels((items) => items.map((item) => ({ ...item, selected: item.id === id })));
        },
      );
    },
    [fixtureMode, request],
  );
  const runModelAction = useCallback(
    async (action: ModelAction, modelId: string) => {
      if (fixtureMode) return;
      const target = models.find(
        (model) => model.id === modelId || model.runtimeModelId === modelId,
      );
      if (!target) throw new Error('The selected local model is no longer available.');
      const operation = localModelActionRequest(action, target, {
        allowRamFallback: settings.allowRamFallback,
        maxRamGb: settings.maxRamGb,
        reserveSystemRamGb: settings.reserveSystemRamGb,
        reserveVramGb: settings.reserveVramGb,
      });
      if (action === 'download' || action === 'resume') {
        setError(null);
        setModels((items) =>
          items.map((item) => (item.id === target.id ? { ...item, status: 'download' } : item)),
        );
        void request<Record<string, unknown>>(operation.method, operation.params, 3_600_000)
          .then(() => refresh())
          .catch((reason) => {
            setError(reason instanceof Error ? reason.message : 'The verified download failed.');
            void refresh();
          });
        return;
      }
      await guard(async () => {
        const result = await request<Record<string, unknown>>(
          operation.method,
          operation.params,
          300_000,
        );
        await refresh();
        if (action === 'benchmark') {
          setModels((items) =>
            items.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: 'benchmarked',
                    benchmark: {
                      tokensPerSecond: Number(result.generated_tokens_per_second) || 0,
                      contextTokens: Number(result.context_size) || 0,
                      measuredAt: textValue(result.measured_at, new Date().toISOString()),
                    },
                  }
                : item,
            ),
          );
        }
      });
    },
    [
      fixtureMode,
      guard,
      models,
      refresh,
      request,
      settings.allowRamFallback,
      settings.maxRamGb,
      settings.reserveSystemRamGb,
      settings.reserveVramGb,
    ],
  );
  const installRuntimePack = useCallback(
    async (runtimeId: string, acceptedLicenseUrls: string[]) => {
      if (fixtureMode) return;
      await guard(async () => {
        await request(
          'local_models.cupcake.download',
          {
            artifactId: runtimeId,
            artifactKind: 'runtime',
            activate: true,
            acceptedLicenseUrls,
          },
          1_800_000,
        );
        await refresh();
      });
    },
    [fixtureMode, guard, refresh, request],
  );
  const activateRuntimePack = useCallback(
    async (runtime: LocalRuntimeRecord) => {
      if (fixtureMode) return;
      if (!runtime.version || !runtime.backend) {
        throw new Error('The installed runtime is missing its version or backend identity.');
      }
      await guard(async () => {
        await request('local_models.cupcake.runtime.activate', {
          version: runtime.version,
          backend: runtime.backend,
        });
        await refresh();
      });
    },
    [fixtureMode, guard, refresh, request],
  );

  const setToolEnabled = useCallback(
    async (toolId: string, enabled: boolean) => {
      if (!fixtureMode)
        await request('settings.set', {
          key: 'tools.enabled',
          value: enabled
            ? [...new Set([...settings.enabledToolIds, toolId])]
            : settings.enabledToolIds.filter((id) => id !== toolId),
        });
      setTools((items) => items.map((item) => (item.id === toolId ? { ...item, enabled } : item)));
      setSettings((current) => ({
        ...current,
        enabledToolIds: enabled
          ? [...new Set([...current.enabledToolIds, toolId])]
          : current.enabledToolIds.filter((id) => id !== toolId),
      }));
    },
    [fixtureMode, request, settings.enabledToolIds],
  );
  const connectMcp = useCallback(
    async (input: { name: string; transport: 'stdio' | 'streamable-http'; endpoint: string }) => {
      await request('mcp.connect', input);
      await refresh();
    },
    [refresh, request],
  );
  const disconnectMcp = useCallback(
    async (connectionId: string) => {
      await request('mcp.disconnect', { connectionId });
      await refresh();
    },
    [refresh, request],
  );
  const preflightTool = useCallback(
    async (tool: ToolDescriptor) => {
      const result = await request<Record<string, unknown>>('tools.preflight', {
        toolId: tool.id,
        projectId: activeProjectId,
      });
      setToolActivity((items) => [
        {
          id: `preflight-${Date.now()}`,
          type: 'preflight',
          status: textValue(result.decision, 'prepared'),
          toolName: tool.name,
          summary: 'Broker resolved effects, grants, and destinations.',
          payload: result,
          createdAt: new Date().toISOString(),
        },
        ...items,
      ]);
    },
    [activeProjectId, request],
  );
  const resolveApproval = useCallback(
    async (activity: ToolActivity, approved: boolean) => {
      const approvalId = textValue(
        activity.payload?.approvalId ?? activity.payload?.approval_id,
        activity.id,
      );
      const result = await request<Record<string, unknown>>('tasks.approval.resolve', {
        approvalId,
        approved,
      });
      setToolActivity((items) =>
        items.map((item) =>
          item.id === activity.id
            ? { ...item, status: approved ? 'approved' : 'denied', payload: result }
            : item,
        ),
      );
    },
    [request],
  );

  const updateSettings = useCallback(
    async (patch: Partial<WorkspaceSettings>) => {
      const next = { ...settings, ...patch };
      if (!fixtureMode) {
        const entries: Array<[string, unknown]> = [];
        if (patch.theme !== undefined)
          entries.push([
            'appearance.theme',
            patch.theme === 'light'
              ? 'cupcake-light'
              : patch.theme === 'dark'
                ? 'cupcake-dark'
                : patch.theme,
          ]);
        if (patch.wallpaper !== undefined) entries.push(['appearance.wallpaper', patch.wallpaper]);
        if (patch.offline !== undefined)
          entries.push(['privacy.default_mode', patch.offline ? 'offline' : 'connected']);
        if (patch.proactiveEnabled !== undefined)
          entries.push(['proactive.enabled', patch.proactiveEnabled]);
        if (patch.developerMode !== undefined)
          entries.push(['developer.enabled', patch.developerMode]);
        if (patch.reducedMotion !== undefined)
          entries.push(['accessibility.reduced_motion', patch.reducedMotion]);
        if (patch.scrollbarMode !== undefined)
          entries.push(['appearance.scrollbars', patch.scrollbarMode]);
        if (patch.onboardingCompleted !== undefined)
          entries.push(['onboarding.completed_v1', patch.onboardingCompleted]);
        if (patch.profile !== undefined)
          entries.push(
            ['profile.display_name', patch.profile.displayName],
            ['profile.role', patch.profile.role],
            ['profile.bio', patch.profile.bio],
            ['profile.avatar', patch.profile.avatar],
          );
        if (patch.assistantAvatar !== undefined)
          entries.push(['assistant.avatar', patch.assistantAvatar]);
        if (patch.reasoningEffort !== undefined)
          entries.push(['models.reasoning_effort', patch.reasoningEffort]);
        if (patch.enabledToolIds !== undefined)
          entries.push(['tools.enabled', patch.enabledToolIds]);
        if (patch.personalityPreset !== undefined)
          entries.push(['personality.preset', patch.personalityPreset]);
        if (patch.personality !== undefined) {
          entries.push(
            ['personality.warmth', patch.personality.warmth],
            ['personality.brevity', patch.personality.brevity],
            ['personality.initiative', patch.personality.initiative],
          );
        }
        if (patch.personalityInstructions !== undefined)
          entries.push(['personality.custom_instructions', patch.personalityInstructions]);
        if (patch.semanticEnrichment !== undefined)
          entries.push(
            ['retrieval.semantic.enabled', patch.semanticEnrichment.enabled],
            ['retrieval.semantic.provider', patch.semanticEnrichment.provider],
            ['retrieval.semantic.model_id', patch.semanticEnrichment.modelId],
          );
        if (patch.permissionMode !== undefined)
          await request('broker.permission_mode.set', { mode: patch.permissionMode });
        if (patch.allowRamFallback !== undefined)
          entries.push(['models.local.allow_ram_fallback', patch.allowRamFallback]);
        if (patch.maxRamGb !== undefined) entries.push(['models.local.max_ram_gb', patch.maxRamGb]);
        if (patch.autoEvictLocalModels !== undefined)
          entries.push(['models.local.auto_evict', patch.autoEvictLocalModels]);
        if (patch.localModelIdleMinutes !== undefined)
          entries.push(['models.local.idle_minutes', patch.localModelIdleMinutes]);
        if (patch.reserveSystemRamGb !== undefined)
          entries.push(['models.local.reserve_system_ram_gb', patch.reserveSystemRamGb]);
        if (patch.reserveVramGb !== undefined)
          entries.push(['models.local.reserve_vram_gb', patch.reserveVramGb]);
        await Promise.all(entries.map(([key, value]) => request('settings.set', { key, value })));
        if (patch.proactiveEnabled !== undefined)
          await request('memory.suggestions.enable', { enabled: patch.proactiveEnabled });
      }
      setSettings(next);
    },
    [fixtureMode, request, settings],
  );

  const chooseLegacySource = useCallback(async () => {
    const source = await window.cupcake?.dialog.openDirectory({
      title: 'Choose the original Cupcake 1.0 data folder',
    });
    if (!source) return;
    try {
      const state = await request<LegacyMigrationState>('migration.preview', {
        sourceHandleId: source.id,
      });
      setLegacyMigration(state);
    } finally {
      await window.cupcake?.dialog.releaseHandle(source.id);
    }
  }, [request]);
  const executeLegacyMigration = useCallback(async () => {
    const state = await request<LegacyMigrationState>('migration.execute');
    setLegacyMigration(state.state === 'completed' ? null : state);
    await refresh();
  }, [refresh, request]);
  const declineLegacyMigration = useCallback(async () => {
    await request('migration.decline');
    setLegacyMigration(null);
  }, [request]);
  const preflightClearData = useCallback(
    (scopes: string[]) => request<Record<string, unknown>>('data.clear.preflight', { scopes }),
    [request],
  );
  const executeClearData = useCallback(
    async (preflight: Record<string, unknown>) => {
      await request('data.clear.execute', {
        preflight,
        approval: preflight.approvalChallenge ?? preflight.approval_challenge,
      });
      await refresh();
    },
    [refresh, request],
  );
  const undoClearData = useCallback(async () => {
    await request('data.clear.undo');
    await refresh();
  }, [refresh, request]);
  const createBackup = useCallback(async () => {
    const target = await window.cupcake?.dialog.chooseSaveTarget('cupcake-backup.cupcakebak');
    if (!target) return;
    try {
      await request('backup.create.intent', { destinationHandle: target.id });
    } finally {
      await window.cupcake?.dialog.releaseHandle(target.id);
    }
  }, [request]);
  const discoverCommunityModels = useCallback(
    async (query = '', limit = 120): Promise<ModelDescriptor[]> => {
      const cleanQuery = query.trim().toLowerCase();
      if (fixtureMode)
        return fixtureCommunityModels.filter((model) =>
          `${model.name} ${model.tags.join(' ')}`.toLowerCase().includes(cleanQuery),
        );
      const result = await request<{ models?: Array<Record<string, unknown>> }>(
        'local_models.discovery.search',
        { query: query.trim(), limit },
        20_000,
      );
      return (result.models ?? [])
        .map(mapCommunityModel)
        .filter((model): model is ModelDescriptor => Boolean(model));
    },
    [fixtureMode, request],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      fixtureMode,
      ready,
      configurationReady,
      busy,
      error,
      runtimeEvents,
      projects,
      conversations,
      branches,
      messages,
      tasks,
      artifacts,
      memories,
      models,
      tools,
      searchResults,
      hardware,
      localRuntimes,
      toolActivity,
      providers,
      settings,
      legacyMigration,
      activeProjectId,
      activeConversationId,
      activeBranchId,
      activeRunId,
      setActiveProject,
      createProject,
      createConversation,
      selectConversation,
      selectBranch,
      renameConversation,
      archiveConversation,
      branchConversation,
      sendMessage,
      preflightCloudDisclosure,
      stopRun,
      copyMessage,
      cancelTask,
      resumeTask,
      steerTask,
      followupTask,
      remember,
      updateMemory,
      setMemoryEnabled,
      forgetMemory,
      createArtifact,
      reviseArtifact,
      exportArtifact,
      querySearch,
      selectModel,
      runModelAction,
      installRuntimePack,
      activateRuntimePack,
      discoverCommunityModels,
      setToolEnabled,
      connectMcp,
      disconnectMcp,
      preflightTool,
      resolveApproval,
      updateSettings,
      chooseLegacySource,
      executeLegacyMigration,
      declineLegacyMigration,
      preflightClearData,
      executeClearData,
      undoClearData,
      createBackup,
      refresh,
    }),
    [
      fixtureMode,
      ready,
      configurationReady,
      busy,
      error,
      runtimeEvents,
      projects,
      conversations,
      branches,
      messages,
      tasks,
      artifacts,
      memories,
      models,
      tools,
      searchResults,
      hardware,
      localRuntimes,
      toolActivity,
      providers,
      settings,
      legacyMigration,
      activeProjectId,
      activeConversationId,
      activeBranchId,
      activeRunId,
      setActiveProject,
      createProject,
      createConversation,
      selectConversation,
      selectBranch,
      renameConversation,
      archiveConversation,
      branchConversation,
      sendMessage,
      preflightCloudDisclosure,
      stopRun,
      copyMessage,
      cancelTask,
      resumeTask,
      steerTask,
      followupTask,
      remember,
      updateMemory,
      setMemoryEnabled,
      forgetMemory,
      createArtifact,
      reviseArtifact,
      exportArtifact,
      querySearch,
      selectModel,
      runModelAction,
      installRuntimePack,
      activateRuntimePack,
      discoverCommunityModels,
      setToolEnabled,
      connectMcp,
      disconnectMcp,
      preflightTool,
      resolveApproval,
      updateSettings,
      chooseLegacySource,
      executeLegacyMigration,
      declineLegacyMigration,
      preflightClearData,
      executeClearData,
      undoClearData,
      createBackup,
      refresh,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return value;
}
