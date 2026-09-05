export type Theme = 'light' | 'dark' | 'minimal' | 'classic';
export type View =
  | 'home'
  | 'chats'
  | 'chat'
  | 'projects'
  | 'tasks'
  | 'task'
  | 'artifacts'
  | 'memory'
  | 'models'
  | 'tools'
  | 'search'
  | 'settings'
  | 'developer'
  | 'about';

export interface Conversation {
  id: string;
  title: string;
  preview: string;
  updated: string;
  project?: string;
  projectId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  status: 'working' | 'waiting' | 'complete' | 'failed';
  progress: number;
  project: string;
  projectId?: string | null;
  elapsed: string;
  steps: { label: string; state: 'complete' | 'active' | 'queued' | 'failed' }[];
}

export interface MemoryRecord {
  id: string;
  type: 'Preference' | 'Decision' | 'Instruction' | 'Fact' | 'Temporary';
  title: string;
  body: string;
  scope: string;
  source: string;
  confidence: number;
  enabled: boolean;
  projectId?: string | null;
  conversationId?: string | null;
  pinned?: boolean;
  expires?: string;
}

export interface ModelDescriptor {
  id: string;
  runtimeModelId?: string;
  provider: string;
  publisher?: string;
  name: string;
  route: 'Cloud' | 'Local';
  tags: string[];
  context: string;
  cost: string;
  status:
    | 'catalog'
    | 'incompatible'
    | 'setup'
    | 'download'
    | 'paused'
    | 'verifying'
    | 'checksum-failed'
    | 'installed'
    | 'loading'
    | 'ready'
    | 'benchmarked'
    | 'unloading'
    | 'removing'
    | 'offline'
    | 'community'
    | 'error';
  description: string;
  selected?: boolean;
  progress?: number;
  reasoningPresets?: Array<'none' | 'low' | 'medium' | 'high'>;
  download?: {
    bytesReceived: number;
    totalBytes: number;
    bytesPerSecond?: number;
    checksumState?: string;
    diskState?: string;
    state: string;
  };
  chatCompatibility?: 'chat' | 'unknown' | 'non_chat';
  verificationState?:
    | 'docs_verified_chat'
    | 'account_discoverable'
    | 'operationally_verified'
    | 'unverified'
    | 'stale';
  verificationSourceUrl?: string;
  verificationDate?: string;
  privacyLabel?: string;
  pricingProvenance?: string;
  fit?: 'pending' | 'recommended' | 'reduced-context' | 'cpu-slow' | 'hybrid' | 'incompatible';
  fitReason?: string;
  source?: string;
  sourceUrl?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  gated?: boolean;
  license?: string;
  parameters?: string;
  quantization?: string;
  fileSizeBytes?: number;
  estimatedRamBytes?: number;
  estimatedVramBytes?: number;
  estimatedDiskBytes?: number;
  speedClass?: string;
  benchmark?: { tokensPerSecond: number; contextTokens: number; measuredAt: string };
}

export interface LiveChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
  streaming?: boolean;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  provider: string;
  route: 'Local' | 'Cloud';
  enabled: boolean;
  permissions: string[];
  lastUsed: string;
  kind: 'native' | 'mcp' | 'custom';
}
