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
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCost?: string };
  citations?: Array<{ id: string; title: string; url?: string }>;
  reasoningSummary?: string;
}

export interface AttachmentRecord {
  handleId: string;
  name: string;
  size?: number;
  extension?: string;
  destination: 'local' | 'cloud';
}

export interface ReferenceRecord {
  id: string;
  type: 'project' | 'task' | 'artifact' | 'memory';
  label: string;
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
  ramBytes?: number;
  vramBytes?: number;
  gpu?: string;
  acceleration?: string[];
}

export interface LocalRuntimeRecord {
  id: string;
  name: string;
  status: string;
  models?: Array<Record<string, unknown>>;
  detail?: string;
}

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
  offline: boolean;
  proactiveEnabled: boolean;
  developerMode: boolean;
  reducedMotion: boolean;
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
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at?: string;
  model_id?: string | null;
  provider_id?: string | null;
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
  provider: string;
  model?: string;
  display_name?: string;
  privacy_route?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: string[];
  reasoning_presets?: string[];
  pricing?: { input?: string; output?: string; provenance?: string };
  chat_compatibility?: 'chat' | 'unknown';
  pricing_provenance?: string;
  privacy_route_label?: string;
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
  createConversation(title?: string): Promise<void>;
  selectConversation(conversationId: string): Promise<void>;
  selectBranch(branchId: string): Promise<void>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  archiveConversation(conversationId: string, archived: boolean): Promise<void>;
  branchConversation(fromMessageId?: string, name?: string): Promise<void>;
  sendMessage(input: {
    content: string;
    modelId: string;
    attachments: AttachmentRecord[];
    references?: ReferenceRecord[];
    reasoningEffort: ReasoningEffort;
    enabledToolIds: string[];
    mode?: 'send' | 'retry' | 'continue' | 'edit' | 'regenerate';
    messageId?: string;
    outboundConfirmationToken?: string;
  }): Promise<void>;
  preflightCloudDisclosure(input: {
    content: string;
    modelId: string;
    attachments: AttachmentRecord[];
    references: ReferenceRecord[];
  }): Promise<{
    confirmationToken: string;
    disclosure: { privacyRoute?: string; costClass?: string };
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
  selectModel(id: string): Promise<void>;
  runModelAction(
    action:
      | 'download'
      | 'load'
      | 'unload'
      | 'remove'
      | 'status'
      | 'benchmark'
      | 'pause'
      | 'resume'
      | 'cancel'
      | 'reset',
    modelId: string,
  ): Promise<void>;
  setToolEnabled(toolId: string, enabled: boolean): Promise<void>;
  connectMcp(input: {
    name: string;
    transport: 'stdio' | 'streamable-http';
    endpoint: string;
  }): Promise<void>;
  disconnectMcp(connectionId: string): Promise<void>;
  preflightTool(tool: ToolDescriptor): Promise<void>;
  resolveApproval(activity: ToolActivity, approved: boolean): Promise<void>;
  connectProvider(provider: string): Promise<boolean>;
  configureCompatibleProvider(input: {
    name: string;
    baseUrl: string;
    modelId: string;
  }): Promise<boolean>;
  disconnectProvider(provider: string): Promise<boolean>;
  updateSettings(patch: Partial<WorkspaceSettings>): Promise<void>;
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

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

function textValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
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

function mapMessage(item: RuntimeMessage): MessageRecord {
  const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'status';
  return {
    id: item.id,
    role,
    content: item.content,
    branchId: item.branch_id,
    createdAt: item.created_at,
    modelId: item.model_id,
    providerId: item.provider_id,
  };
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
  };
}

function mapModel(item: RuntimeModel, selectedId?: string): ModelDescriptor {
  const id = item.id ?? item.model_id ?? `${item.provider}:${item.model ?? 'model'}`;
  const local = ['local', 'ollama', 'lm-studio', 'vllm', 'cupcake-local'].includes(item.provider);
  const providerNames: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    xai: 'xAI',
    mistral: 'Mistral',
    cohere: 'Cohere',
    'nvidia-nim': 'NVIDIA NIM',
  };
  return {
    id,
    runtimeModelId: id,
    provider: providerNames[item.provider] ?? cap(item.provider),
    name: item.display_name ?? item.model ?? id.split(':').at(-1) ?? id,
    route: local || item.privacy_route === 'local' ? 'Local' : 'Cloud',
    tags: item.capabilities?.slice(0, 4) ?? [],
    context: item.context_window ? item.context_window.toLocaleString() : 'Unknown',
    cost: local ? 'Local' : item.pricing?.input ? `From ${item.pricing.input}` : 'Provider pricing',
    status: local ? 'offline' : 'setup',
    description: item.reasoning_presets?.length
      ? `Reasoning: ${item.reasoning_presets.join(', ')}`
      : 'Explicitly selected model',
    selected: id === selectedId,
    reasoningPresets: item.reasoning_presets?.filter((preset): preset is ReasoningEffort =>
      ['none', 'low', 'medium', 'high'].includes(preset),
    ),
    chatCompatibility: item.chat_compatibility,
    privacyLabel: item.privacy_route_label,
    pricingProvenance: item.pricing_provenance ?? item.pricing?.provenance,
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
    permissions: [...(item.required_grants ?? []), ...effects].slice(0, 4).map(cap),
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
  offline: false,
  proactiveEnabled: false,
  developerMode: false,
  reducedMotion: false,
  reasoningEffort: 'high',
  enabledToolIds: fixtureTools.filter((tool) => tool.enabled).map((tool) => tool.id),
  personalityPreset: 'balanced',
  personality: { warmth: 0.55, brevity: 0.45, initiative: 0.3 },
  personalityInstructions: '',
  semanticEnrichment: { enabled: false, provider: null, modelId: null },
};

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const fixtureMode = !window.cupcake;
  const [ready, setReady] = useState(fixtureMode);
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
    if (!stored) return fallbackSettings;
    try {
      return { ...fallbackSettings, ...(JSON.parse(stored) as Partial<WorkspaceSettings>) };
    } catch {
      return fallbackSettings;
    }
  });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  const request = useCallback(
    async <T,>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
      if (!window.cupcake)
        throw new Error('Desktop bridge unavailable in deterministic fixture mode');
      const response: RuntimeResponse<T> = await window.cupcake.runtime.request({
        method,
        params,
        timeoutMs,
      });
      if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
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
      const bootstrap = await request<{
        selectedModelId?: string;
        projects?: RuntimeProject[];
        conversations?: RuntimeConversation[];
        models?: RuntimeModel[];
        tools?: RuntimeTool[];
        hardware?: HardwareRecord;
        localRuntimes?: Array<string | LocalRuntimeRecord>;
        suggestionsEnabled?: boolean;
      }>('app.bootstrap');
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
      setModels((bootstrap.models ?? []).map((item) => mapModel(item, bootstrap.selectedModelId)));
      setTools((bootstrap.tools ?? []).map(mapTool));
      setHardware(bootstrap.hardware ?? null);
      setLocalRuntimes(
        (bootstrap.localRuntimes ?? []).map((item) =>
          typeof item === 'string' ? { id: item, name: cap(item), status: 'available' } : item,
        ),
      );
      const selectedProject =
        activeProjectId && projectRecords.some((item) => item.id === activeProjectId)
          ? activeProjectId
          : (projectRecords[0]?.id ?? null);
      setActiveProjectId(selectedProject);
      const [taskResult, memoryResult, providerResult, runtimeSettings, migration] =
        await Promise.all([
          request<RuntimeTask[]>('tasks.list'),
          request<RuntimeMemory[]>('memory.list', { states: ['active', 'candidate', 'disabled'] }),
          request<{ providers: Array<{ provider: string; configured: boolean }> }>(
            'providers.status',
          ),
          request<Record<string, unknown>>('settings.list'),
          request<LegacyMigrationState>('migration.detect'),
        ]);
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
      setModels(
        (bootstrap.models ?? []).map((item) => ({
          ...mapModel(item, bootstrap.selectedModelId),
          status: ['local', 'ollama', 'lm-studio', 'vllm', 'cupcake-local', 'mock'].includes(
            item.provider,
          )
            ? item.provider === 'mock'
              ? 'ready'
              : 'offline'
            : configuredProviders[item.provider]
              ? 'ready'
              : 'setup',
        })),
      );
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
        offline: runtimeSettings['privacy.default_mode'] === 'offline',
        proactiveEnabled:
          typeof runtimeSettings['proactive.enabled'] === 'boolean'
            ? runtimeSettings['proactive.enabled']
            : (bootstrap.suggestionsEnabled ?? false),
        developerMode: runtimeSettings['developer.enabled'] === true,
        reducedMotion: runtimeSettings['accessibility.reduced_motion'] === true,
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
      }));
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
      setReady(true);
    });
  }, [activeProjectId, fixtureMode, guard, loadArtifacts, request]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void refresh();
    if (!window.cupcake) return;
    const stopEvents = window.cupcake.runtime.onEvent((event) => {
      setRuntimeEvents((items) => [event, ...items].slice(0, 500));
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
      if (event.type === 'message.started' && runId) {
        setActiveRunId(runId);
        setMessages((items) =>
          items.some((item) => item.id === runId)
            ? items
            : [...items, { id: runId, role: 'assistant', content: '', streaming: true }],
        );
      } else if (event.type === 'message.delta' && runId && typeof payload.delta === 'string') {
        setMessages((items) =>
          items.map((item) =>
            item.id === runId
              ? { ...item, content: item.content + (payload.delta as string) }
              : item,
          ),
        );
      } else if (event.type === 'message.completed' && runId) {
        setActiveRunId(null);
        setMessages((items) =>
          items.map((item) =>
            item.id === runId
              ? {
                  ...item,
                  content: typeof payload.content === 'string' ? payload.content : item.content,
                  streaming: false,
                }
              : item,
          ),
        );
      } else if (event.type === 'usage.updated') {
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        const targetId = runId ?? activeRunId;
        if (targetId)
          setMessages((items) =>
            items.map((item) =>
              item.id === targetId
                ? {
                    ...item,
                    usage: {
                      inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
                      outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
                      estimatedCost: payload.cost
                        ? textValue((payload.cost as Record<string, unknown>).amount, 'estimated')
                        : undefined,
                    },
                  }
                : item,
            ),
          );
      } else if (event.type === 'citation.created') {
        const targetId = runId ?? activeRunId;
        if (targetId)
          setMessages((items) =>
            items.map((item) =>
              item.id === targetId
                ? {
                    ...item,
                    citations: [
                      ...(item.citations ?? []),
                      {
                        id: textValue(payload.id, String(event.sequence)),
                        title: textValue(payload.title ?? payload.source, 'Source'),
                        url: typeof payload.url === 'string' ? payload.url : undefined,
                      },
                    ],
                  }
                : item,
            ),
          );
      } else if (event.type === 'reasoning.summary' && typeof payload.summary === 'string') {
        const targetId = runId ?? activeRunId;
        if (targetId)
          setMessages((items) =>
            items.map((item) =>
              item.id === targetId
                ? { ...item, reasoningSummary: payload.summary as string }
                : item,
            ),
          );
      } else if (event.type.startsWith('artifact.')) {
        void loadArtifacts(activeProjectId).catch(() => undefined);
      } else if (event.type.startsWith('memory.')) {
        void request<RuntimeMemory[]>('memory.list', {
          states: ['active', 'candidate', 'disabled'],
        })
          .then((items) => setMemories(items.map((item) => mapMemory(item, projects))))
          .catch(() => undefined);
      } else if (
        event.type.startsWith('local_model.download') ||
        event.type.startsWith('model.download')
      ) {
        const modelId = textValue(payload.modelId ?? payload.model_id);
        setModels((items) =>
          items.map((item) =>
            item.id === modelId
              ? {
                  ...item,
                  download: {
                    bytesReceived: Number(payload.bytesReceived ?? payload.bytes_received ?? 0),
                    totalBytes: Number(payload.totalBytes ?? payload.total_bytes ?? 0),
                    bytesPerSecond: Number(payload.bytesPerSecond ?? payload.bytes_per_second ?? 0),
                    checksumState:
                      typeof payload.checksumState === 'string' ? payload.checksumState : undefined,
                    diskState:
                      typeof payload.diskState === 'string' ? payload.diskState : undefined,
                    state: textValue(payload.state, 'downloading'),
                  },
                  progress:
                    Number(payload.totalBytes ?? payload.total_bytes ?? 0) > 0
                      ? Math.round(
                          (Number(payload.bytesReceived ?? payload.bytes_received ?? 0) /
                            Number(payload.totalBytes ?? payload.total_bytes)) *
                            100,
                        )
                      : undefined,
                }
              : item,
          ),
        );
      } else if (event.type.includes('error') || event.type === 'run.failed') {
        setMessages((items) => [
          ...items,
          {
            id: `error-${event.sequence}`,
            role: 'status',
            content: textValue(payload.message ?? payload.error, 'The runtime reported an error.'),
          },
        ]);
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
  }, [activeProjectId, activeRunId, loadArtifacts, projects, refresh, request]);

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
              states: ['active', 'candidate', 'disabled'],
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
        setConversations((items) => [
          { id, title, preview: 'Deterministic fixture', updated: 'now' },
          ...items,
        ]);
        setActiveConversationId(id);
        setMessages([]);
        return;
      }
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
      });
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
          setMessages(history.map(mapMessage));
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
        setMessages(history.map(mapMessage));
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
        setMessages(history.map(mapMessage));
      });
    },
    [activeConversationId, fixtureMode, guard, request],
  );

  const sendMessage = useCallback(
    async (input: Parameters<WorkspaceContextValue['sendMessage']>[0]) => {
      if (
        settings.offline &&
        !models.find((item) => item.id === input.modelId)?.route.startsWith('Local')
      ) {
        setError('Offline mode blocked this cloud model. Choose a local model before sending.');
        return;
      }
      const optimisticId = `user-${Date.now()}`;
      setMessages((items) => [
        ...items,
        { id: optimisticId, role: 'user', content: input.content, attachments: input.attachments },
      ]);
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
        return;
      }
      await guard(async () => {
        const method =
          input.mode === 'edit'
            ? 'chat.edit'
            : input.mode === 'regenerate' || input.mode === 'retry'
              ? 'chat.regenerate'
              : input.mode === 'continue'
                ? 'chat.continue'
                : 'chat.send';
        const result = await request<{
          conversationId: string;
          branchId: string;
          runId?: string;
          content?: string;
        }>(
          method,
          {
            content: input.content,
            messageId: input.messageId,
            conversationId: activeConversationId,
            branchId: activeBranchId,
            projectId: activeProjectId,
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
            enabledToolIds: input.enabledToolIds,
            personalityPreset: settings.personalityPreset,
            personality: settings.personality,
            personalityInstructions: settings.personalityInstructions,
            offline: settings.offline,
            outboundConfirmationToken: input.outboundConfirmationToken,
            attachmentHandles: input.attachments.map((item) => item.handleId),
            referenceIds: (input.references ?? []).map((item) => item.id),
            memoryIds: memories.filter((item) => item.enabled).map((item) => item.id),
            toolIds: input.enabledToolIds,
          },
          120_000,
        );
        setActiveConversationId(result.conversationId);
        setActiveBranchId(result.branchId);
        if (result.runId) setActiveRunId(result.runId);
        if (result.content && !messages.some((item) => item.id === result.runId)) {
          setMessages((items) => [
            ...items,
            {
              id: result.runId ?? `assistant-${Date.now()}`,
              role: 'assistant',
              content: result.content ?? '',
            },
          ]);
        }
        const list = await request<RuntimeConversation[]>('conversations.list', {
          projectId: activeProjectId,
          includeArchived: true,
        });
        setConversations(list.map((item) => mapConversation(item, projects)));
      });
    },
    [
      activeBranchId,
      activeConversationId,
      activeProjectId,
      fixtureMode,
      guard,
      messages,
      models,
      projects,
      request,
      settings,
    ],
  );

  const stopRun = useCallback(async () => {
    if (!activeRunId) return;
    if (window.cupcake) await window.cupcake.runtime.cancel(activeRunId);
    setActiveRunId(null);
    setMessages((items) =>
      items.map((item) => (item.streaming ? { ...item, streaming: false } : item)),
    );
  }, [activeRunId]);
  const preflightCloudDisclosure = useCallback(
    async (input: {
      content: string;
      modelId: string;
      attachments: AttachmentRecord[];
      references: ReferenceRecord[];
    }) =>
      request<{
        confirmationToken: string;
        disclosure: { privacyRoute?: string; costClass?: string };
      }>('chat.preflight', {
        content: input.content,
        modelId: input.modelId,
        projectId: activeProjectId,
        conversationId: activeConversationId,
        branchId: activeBranchId,
        attachmentHandles: input.attachments.map((item) => item.handleId),
        referenceIds: input.references.map((item) => item.id),
        memoryIds: memories.filter((item) => item.enabled).map((item) => item.id),
        toolIds: settings.enabledToolIds,
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
    async (id: string) => {
      if (!fixtureMode) await request('models.select', { modelId: id });
      setModels((items) => items.map((item) => ({ ...item, selected: item.id === id })));
    },
    [fixtureMode, request],
  );
  const runModelAction = useCallback(
    async (
      action:
        | 'download'
        | 'load'
        | 'unload'
        | 'remove'
        | 'status'
        | 'benchmark'
        | 'pause'
        | 'resume'
        | 'cancel'
        | 'reset',
      modelId: string,
    ) => {
      if (fixtureMode) return;
      const method =
        action === 'download'
          ? 'local_models.cupcake.download'
          : action === 'benchmark'
            ? 'local_models.performance.get'
            : action === 'status'
              ? 'local_models.cupcake.download.status'
              : ['pause', 'resume', 'cancel', 'reset'].includes(action)
                ? `local_models.cupcake.download.${action}`
                : `local_models.cupcake.${action === 'remove' ? 'remove_model' : action}`;
      await guard(async () => {
        await request(method, { modelId });
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

  const connectProvider = useCallback(
    async (provider: string) => {
      try {
        await request('providers.connectInteractive', { provider }, 120_000);
        setProviders((items) => ({ ...items, [provider]: true }));
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Provider connection failed');
        return false;
      }
    },
    [request],
  );
  const disconnectProvider = useCallback(
    async (provider: string) => {
      try {
        await request('providers.disconnect', { provider });
        setProviders((items) => ({ ...items, [provider]: false }));
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Provider disconnection failed');
        return false;
      }
    },
    [request],
  );
  const configureCompatibleProvider = useCallback(
    async (input: { name: string; baseUrl: string; modelId: string }) => {
      if (
        !input.baseUrl.startsWith('https://') &&
        !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(input.baseUrl)
      ) {
        setError('Compatible endpoints must use HTTPS, except loopback local endpoints.');
        return false;
      }
      try {
        await request('providers.compatible.configure', input);
        await request(
          'providers.connectInteractive',
          { provider: 'openai-compatible', metadata: input },
          120_000,
        );
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Compatible endpoint setup failed');
        return false;
      }
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
        if (patch.offline !== undefined)
          entries.push(['privacy.default_mode', patch.offline ? 'offline' : 'connected']);
        if (patch.proactiveEnabled !== undefined)
          entries.push(['proactive.enabled', patch.proactiveEnabled]);
        if (patch.developerMode !== undefined)
          entries.push(['developer.enabled', patch.developerMode]);
        if (patch.reducedMotion !== undefined)
          entries.push(['accessibility.reduced_motion', patch.reducedMotion]);
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
      title: 'Choose the original CUPCAKEAGI data folder',
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

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      fixtureMode,
      ready,
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
      setToolEnabled,
      connectMcp,
      disconnectMcp,
      preflightTool,
      resolveApproval,
      connectProvider,
      configureCompatibleProvider,
      disconnectProvider,
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
      setToolEnabled,
      connectMcp,
      disconnectMcp,
      preflightTool,
      resolveApproval,
      connectProvider,
      configureCompatibleProvider,
      disconnectProvider,
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
