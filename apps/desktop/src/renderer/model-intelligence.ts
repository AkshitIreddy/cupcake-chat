import type { ModelDescriptor } from './types';

export type ModelTask = 'chat' | 'coding' | 'reasoning' | 'documents' | 'vision' | 'tools';
export type ModelSize = 'compact' | 'balanced' | 'frontier';

export interface CuratedModelProfile {
  publisher: string;
  tasks: ModelTask[];
  size: ModelSize;
  summary: string;
  parameters?: string;
  context?: string;
  priority: number;
}

export const MODEL_TASK_OPTIONS: Array<{
  id: ModelTask;
  label: string;
  detail: string;
}> = [
  { id: 'chat', label: 'Everyday chat', detail: 'Writing, planning, and general questions' },
  { id: 'coding', label: 'Coding', detail: 'Software work, terminals, and debugging' },
  { id: 'reasoning', label: 'Deep reasoning', detail: 'Math, analysis, and hard decisions' },
  { id: 'documents', label: 'Documents', detail: 'Long files, research, and synthesis' },
  { id: 'vision', label: 'Images & vision', detail: 'Screenshots, diagrams, and visual input' },
  { id: 'tools', label: 'Tools & agents', detail: 'Multi-step work and function calling' },
];

export const MODEL_SIZE_OPTIONS: Array<{
  id: ModelSize;
  label: string;
  detail: string;
}> = [
  { id: 'compact', label: 'Compact', detail: 'Fast and lighter on memory or cost' },
  { id: 'balanced', label: 'Balanced', detail: 'The practical quality and speed middle' },
  { id: 'frontier', label: 'Frontier', detail: 'Highest capability; usually heavier or pricier' },
];

const PUBLISHERS: Record<string, string> = {
  '01-ai': '01.AI',
  ai21labs: 'AI21 Labs',
  aisingapore: 'AI Singapore',
  anthropic: 'Anthropic',
  bigcode: 'BigCode',
  cohere: 'Cohere',
  databricks: 'Databricks',
  'deepseek-ai': 'DeepSeek',
  google: 'Google',
  ibm: 'IBM',
  'ibm-granite': 'IBM Granite',
  meta: 'Meta',
  microsoft: 'Microsoft',
  minimaxai: 'MiniMax',
  'minimax-ai': 'MiniMax',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  'nv-mistralai': 'Mistral AI + NVIDIA',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  poolside: 'Poolside',
  qwen: 'Qwen',
  snowflake: 'Snowflake',
  writer: 'Writer',
  xai: 'xAI',
  'z-ai': 'Z.ai',
  'zai-org': 'Z.ai',
  zyphra: 'Zyphra',
};

const CURATED: Record<string, CuratedModelProfile> = {
  'openai:gpt-5.6-sol': profile(
    'OpenAI',
    ['chat', 'coding', 'reasoning', 'documents', 'vision', 'tools'],
    'frontier',
    'Top-tier general agent for difficult coding, research, and long-running work.',
    100,
    undefined,
    '1.05m',
  ),
  'anthropic:claude-sonnet-5': profile(
    'Anthropic',
    ['chat', 'coding', 'reasoning', 'documents', 'vision', 'tools'],
    'frontier',
    'Careful long-form reasoning and software work with a large working context.',
    96,
    undefined,
    '1m',
  ),
  'google:gemini-3.5-flash': profile(
    'Google',
    ['chat', 'documents', 'vision', 'tools'],
    'balanced',
    'Fast multimodal synthesis for large document and image collections.',
    92,
    undefined,
    '1m',
  ),
  'xai:grok-4.3': profile(
    'xAI',
    ['chat', 'reasoning', 'tools'],
    'frontier',
    'High-capacity reasoning and tool-driven current-information work.',
    84,
    undefined,
    '1m',
  ),
  'mistral:mistral-medium-3-5': profile(
    'Mistral AI',
    ['chat', 'coding', 'documents', 'tools'],
    'balanced',
    'Efficient multilingual chat, code, and tool use.',
    82,
    undefined,
    '128k',
  ),
  'cohere:command-a-03-2025': profile(
    'Cohere',
    ['chat', 'documents', 'tools'],
    'balanced',
    'Retrieval-focused enterprise work and grounded document answers.',
    80,
    undefined,
    '128k',
  ),
  'moonshotai/kimi-k3': profile(
    'Moonshot AI',
    ['coding', 'reasoning', 'vision', 'tools'],
    'frontier',
    'Flagship multimodal model for long-horizon coding, reasoning, and agentic tool use.',
    99,
    '~2.8T MoE',
  ),
  'deepseek-ai/deepseek-v4-pro-0813': profile(
    'DeepSeek',
    ['coding', 'reasoning', 'documents', 'tools'],
    'frontier',
    'Flagship long-context coding and agentic reasoning model.',
    98,
    'MoE',
    '1m',
  ),
  'deepseek-ai/deepseek-v4-flash-0731': profile(
    'DeepSeek',
    ['chat', 'coding', 'reasoning', 'documents', 'tools'],
    'balanced',
    'Fast long-context coding and reasoning with a smaller active footprint.',
    94,
    '284B MoE · 13B active',
    '1m',
  ),
  'moonshotai/kimi-k2.6': profile(
    'Moonshot AI',
    ['coding', 'reasoning', 'vision', 'tools'],
    'frontier',
    'Strong multimodal reasoning and autonomous software work.',
    93,
  ),
  'nvidia/nemotron-3-ultra-550b-a55b': profile(
    'NVIDIA',
    ['chat', 'coding', 'reasoning', 'documents', 'tools'],
    'frontier',
    'NVIDIA flagship for long-context reasoning, coding, and tool use.',
    92,
    '550B MoE · 55B active',
  ),
  'nvidia/nemotron-3-super-120b-a12b': profile(
    'NVIDIA',
    ['chat', 'coding', 'reasoning', 'tools'],
    'balanced',
    'Efficient reasoning and coding model with a 12B active footprint.',
    91,
    '120B MoE · 12B active',
  ),
  'nvidia/nemotron-3.5-lightning-30b-a3b': profile(
    'NVIDIA',
    ['chat', 'coding', 'reasoning', 'documents', 'tools'],
    'compact',
    'Low-active-parameter agent model tuned for speed and long-running work.',
    90,
    '30B MoE · 3B active',
  ),
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': profile(
    'NVIDIA',
    ['reasoning', 'documents', 'vision', 'tools'],
    'compact',
    'Compact multimodal reasoning for images, documents, and computer-use tasks.',
    89,
    '30B MoE · 3B active',
  ),
  'openai/gpt-oss-120b': profile(
    'OpenAI',
    ['chat', 'coding', 'reasoning', 'tools'],
    'frontier',
    'Large open-weight reasoning model with configurable reasoning effort.',
    90,
    '120B',
  ),
  'openai/gpt-oss-20b': profile(
    'OpenAI',
    ['chat', 'coding', 'reasoning', 'tools'],
    'compact',
    'Smaller open-weight reasoning model for responsive everyday work.',
    88,
    '20B',
  ),
  'poolside/laguna-xs-2.1': profile(
    'Poolside',
    ['coding', 'reasoning', 'tools'],
    'balanced',
    'Purpose-built for long-horizon coding, terminal work, and software agents.',
    90,
    '33B MoE',
  ),
  'google/gemma-4-31b-it': profile(
    'Google',
    ['chat', 'reasoning', 'documents', 'vision', 'tools'],
    'balanced',
    'Multimodal instruction model for visual reasoning and document understanding.',
    87,
    '31B',
  ),
  'meta/muse-glimmer-30b': profile(
    'Meta',
    ['chat', 'reasoning', 'vision', 'tools'],
    'balanced',
    'Multimodal reasoning model with native tool calling.',
    85,
    '30B',
  ),
  'mistralai/mistral-nemotron': profile(
    'Mistral AI + NVIDIA',
    ['chat', 'coding', 'reasoning', 'tools'],
    'balanced',
    'Instruction model tuned jointly for reasoning, code, and tool use.',
    83,
  ),
  'qwen3-1-7b-q8-0': profile(
    'Qwen',
    ['chat', 'reasoning', 'documents'],
    'compact',
    'Ultra-light multilingual model for writing, extraction, and short summaries.',
    64,
    '1.7B',
    '32k',
  ),
  'granite-3-3-2b-instruct-q4-k-m': profile(
    'IBM Granite',
    ['chat', 'coding', 'documents'],
    'compact',
    'Efficient long-context model for enterprise documents and structured work.',
    70,
    '2B',
    '131k',
  ),
  'qwen3-4b-q4-k-m': profile(
    'Qwen',
    ['chat', 'coding', 'reasoning', 'documents'],
    'compact',
    'Compact multilingual reasoning model with a practical memory footprint.',
    76,
    '4B',
    '131k',
  ),
  'ministral-3-3b-instruct-q4-k-m': profile(
    'Mistral AI',
    ['chat', 'coding', 'documents', 'tools'],
    'compact',
    'Compact long-context instruct model for responsive local agent work.',
    75,
    '3.4B',
    '131k',
  ),
  'qwen3-8b-q4-k-m': profile(
    'Qwen',
    ['chat', 'coding', 'reasoning', 'documents'],
    'balanced',
    'The practical local default for chat, code, writing, and reasoning.',
    82,
    '8B',
    '131k',
  ),
  'granite-3-3-8b-instruct-q4-k-m': profile(
    'IBM Granite',
    ['chat', 'coding', 'documents'],
    'balanced',
    'Higher-quality enterprise document, summarization, and structured-output model.',
    79,
    '8B',
    '131k',
  ),
  'ministral-3-8b-instruct-q4-k-m': profile(
    'Mistral AI',
    ['chat', 'coding', 'documents', 'tools'],
    'balanced',
    'Long-context local alternative for coding, chat, and agent workflows.',
    80,
    '8.4B',
    '131k',
  ),
  'phi-4-14b-q4-k-s': profile(
    'Microsoft Research',
    ['coding', 'reasoning'],
    'balanced',
    'Dense local model for mathematics, careful reasoning, and code.',
    81,
    '14B',
    '16k',
  ),
  'qwen3-14b-q4-k-m': profile(
    'Qwen',
    ['chat', 'coding', 'reasoning', 'documents'],
    'frontier',
    'Higher-capacity local reasoning model for systems with RAM headroom.',
    84,
    '14B',
    '131k',
  ),
  'qwen3-30b-a3b-q4-k-m': profile(
    'Qwen',
    ['chat', 'coding', 'reasoning', 'documents', 'tools'],
    'frontier',
    'Highest-capability signed local option; best with GPU plus system-RAM assistance.',
    88,
    '30.5B MoE · 3B active',
    '131k',
  ),
};

// Bounded one-token chat probes against the owner test profile on 2026-09-03.
// Keep this separate from model-card documentation: only these NIM endpoints
// are allowed into the default picker until the next catalog qualification.
const OPERATIONALLY_TESTED_NIM = new Set([
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'openai/gpt-oss-20b',
  'poolside/laguna-xs-2.1',
  'meta/muse-glimmer-30b',
  'mistralai/mistral-nemotron',
]);

function profile(
  publisher: string,
  tasks: ModelTask[],
  size: ModelSize,
  summary: string,
  priority: number,
  parameters?: string,
  context?: string,
): CuratedModelProfile {
  return { publisher, tasks, size, summary, priority, parameters, context };
}

export function nativeModelName(model: ModelDescriptor): string {
  const candidate = model.runtimeModelId ?? model.id;
  return candidate
    .replace(/^nvidia-nim:/, '')
    .replace(/^hf:/, '')
    .replace(/^cupcake-local:/, 'cupcake-local/');
}

function publisherFromModelFamily(model: ModelDescriptor): string | undefined {
  const identity = `${nativeModelName(model)} ${model.name}`.toLowerCase();
  if (/\bqwen(?:\d|\b)/u.test(identity)) return 'Qwen';
  if (/\b(?:meta-llama|llama)\b/u.test(identity)) return 'Meta';
  if (/\b(?:mistral|mixtral|codestral)\b/u.test(identity)) return 'Mistral AI';
  if (/\b(?:gemma|gemini)\b/u.test(identity)) return 'Google';
  if (/\bdeepseek\b/u.test(identity)) return 'DeepSeek';
  if (/\bgranite\b/u.test(identity)) return 'IBM Granite';
  if (/\b(?:command-r|command-a)\b/u.test(identity)) return 'Cohere';
  if (/\bphi[- ]?\d/u.test(identity)) return 'Microsoft';
  if (/\b(?:gpt|openai)\b/u.test(identity)) return 'OpenAI';
  return undefined;
}

export function publisherForModel(model: ModelDescriptor): string {
  const curated = curatedProfileForModel(model);
  if (curated) return curated.publisher;
  const familyPublisher = publisherFromModelFamily(model);
  if (model.provider === 'Hugging Face' && familyPublisher) return familyPublisher;
  if (model.publisher) return PUBLISHERS[model.publisher.toLowerCase()] ?? model.publisher;
  if (familyPublisher) return familyPublisher;
  const native = nativeModelName(model);
  const owner = native.includes('/') ? native.split('/', 1)[0]!.toLowerCase() : '';
  return (
    PUBLISHERS[owner] ?? (model.provider === 'Hugging Face' ? owner || 'Community' : model.provider)
  );
}

export function curatedProfileForModel(model: ModelDescriptor): CuratedModelProfile | undefined {
  const native = nativeModelName(model);
  const exact = CURATED[native] ?? CURATED[model.id];
  if (exact) return exact;
  const localName = `${native} ${model.name}`.toLowerCase();
  const localSize = localName.match(/(?:qwen\D*)?(4|8|14)b\b/u)?.[1];
  if (model.route === 'Local' && localSize) {
    const size = localSize === '14' ? 'balanced' : 'compact';
    return profile(
      'Qwen',
      ['chat', 'coding', 'reasoning', 'documents'],
      size,
      `${localSize}B private local model selected for a practical Windows memory footprint.`,
      localSize === '14' ? 76 : localSize === '8' ? 78 : 72,
      `${localSize}B`,
      model.context === 'Unknown' ? '131k' : model.context,
    );
  }
  return undefined;
}

export function completeModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const curated = curatedProfileForModel(model);
  if (!curated) return model;
  return {
    ...model,
    publisher: curated.publisher,
    tags: curated.tasks.map(taskLabel),
    context:
      model.context && !model.context.startsWith('Unknown')
        ? model.context
        : (curated.context ?? 'Provider managed'),
    description: curated.summary,
    parameters: model.parameters ?? curated.parameters,
  };
}

export function modelIsCurated(model: ModelDescriptor): boolean {
  if (!curatedProfileForModel(model)) return false;
  return model.provider !== 'NVIDIA NIM' || OPERATIONALLY_TESTED_NIM.has(nativeModelName(model));
}

export function modelWasOperationallyTested(model: ModelDescriptor): boolean {
  return model.provider === 'NVIDIA NIM' && OPERATIONALLY_TESTED_NIM.has(nativeModelName(model));
}

export function modelTasks(model: ModelDescriptor): ModelTask[] {
  const curated = curatedProfileForModel(model);
  if (curated) return curated.tasks;
  const searchable = `${model.tags.join(' ')} ${model.description}`.toLowerCase();
  return MODEL_TASK_OPTIONS.filter((task) => searchable.includes(task.id)).map((task) => task.id);
}

export function modelSize(model: ModelDescriptor): ModelSize {
  const curated = curatedProfileForModel(model);
  if (curated) return curated.size;
  const billions = Number.parseFloat(model.parameters ?? '');
  if (Number.isFinite(billions))
    return billions <= 20 ? 'compact' : billions <= 80 ? 'balanced' : 'frontier';
  return model.route === 'Cloud' ? 'frontier' : 'balanced';
}

export function modelPriority(model: ModelDescriptor): number {
  return curatedProfileForModel(model)?.priority ?? 0;
}

export function modelIsAvailableInChat(model: ModelDescriptor): boolean {
  if (model.provider === 'NVIDIA NIM' && model.chatCompatibility === 'non_chat') return false;
  return ['ready', 'benchmarked', 'installed', 'offline'].includes(model.status);
}

export function publisherLogoAsset(publisher: string): string | undefined {
  const assets: Record<string, string> = {
    Anthropic: '/providers/anthropic.svg',
    Cohere: '/providers/cohere.svg',
    DeepSeek: '/providers/deepseek.svg',
    Google: '/providers/google.svg',
    'Hugging Face': '/providers/hugging-face.svg',
    Meta: '/providers/meta.svg',
    Microsoft: '/providers/microsoft.svg',
    'Microsoft Research': '/providers/microsoft.svg',
    'Mistral AI': '/providers/mistral.svg',
    'Mistral AI + NVIDIA': '/providers/mistral.svg',
    NVIDIA: '/providers/nvidia-nim.svg',
    OpenAI: '/providers/openai.svg',
    Qwen: '/providers/qwen.svg',
    xAI: '/providers/xai.webp',
  };
  return assets[publisher];
}

export function publisherMonogram(publisher: string): string {
  const words = publisher.split(/[ .+-]+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  );
}

function taskLabel(task: ModelTask): string {
  return MODEL_TASK_OPTIONS.find((option) => option.id === task)?.label ?? task;
}
