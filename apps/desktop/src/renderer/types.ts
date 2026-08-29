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
  pinned?: boolean;
  expires?: string;
}

export interface ModelDescriptor {
  id: string;
  runtimeModelId?: string;
  provider: string;
  name: string;
  route: 'Cloud' | 'Local';
  tags: string[];
  context: string;
  cost: string;
  status: 'ready' | 'setup' | 'download' | 'offline';
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
  privacyLabel?: string;
  pricingProvenance?: string;
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
