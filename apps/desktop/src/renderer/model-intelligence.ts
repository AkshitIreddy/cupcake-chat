import type { ModelDescriptor } from './types';

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
  meta: 'Meta',
  microsoft: 'Microsoft',
  minimaxai: 'MiniMax',
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
  zyphra: 'Zyphra',
};

const EVIDENCE: Record<string, ModelDescriptor['capabilityRatings']> = {
  'deepseek-ai/deepseek-v4-pro-0813': [
    rating('reasoning', 4.5, ['HLE 42.7 no tools / 60.0 with tools']),
    rating('coding', 5, ['Terminal-Bench 2.1 87.9', 'DeepSWE 62.7']),
    rating('tool use', 4.5, ['Toolathlon-Verified 74.1']),
  ],
  'deepseek-ai/deepseek-v4-flash-0731': [
    rating('reasoning', 4, ['HLE 37.8 no tools / 51.5 with tools']),
    rating('coding', 4.5, ['Terminal-Bench 2.1 82.7', 'DeepSWE 54.4']),
    rating('tool use', 4.5, ['Toolathlon-Verified 70.3']),
  ],
  'google/gemma-4-31b-it': [
    rating('reasoning', 4.5, ['MMLU-Pro 85.2', 'GPQA Diamond 84.3']),
    rating('coding', 4.5, ['LiveCodeBench v6 80.0', 'Codeforces ELO 2150']),
    rating('tool use', 4.5, ['Tau2 three-domain average 76.9']),
    rating('vision', 4.5, ['MMMU-Pro 76.9', 'MathVision 85.6']),
  ],
  'mistralai/mistral-nemotron': [
    rating('chat', 4.5, ['IFEval 87.33', 'MMLU 84.84 English']),
    rating('reasoning', 4, ['MMLU-Pro 73.81', 'MATH 91.14']),
    rating('coding', 3.5, ['HumanEval 92.68', 'LiveCodeBench v6 27.42']),
  ],
  'moonshotai/kimi-k3': [
    rating('reasoning', 5, ['GPQA Diamond 93.5', 'AA-LCR 74.7']),
    rating('coding', 5, ['Terminal-Bench 2.1 88.3', 'DeepSWE 67.5']),
    rating('vision', 5, ['MMMU-Pro 81.6 / 83.4 with tools', 'MMVU 82.1']),
    rating('math', 5, ['MathVision 94.3 / 97.8 with tools']),
  ],
  'moonshotai/kimi-k2.6': [
    rating('reasoning', 5, ['GPQA Diamond 90.5', 'AIME 2026 96.4']),
    rating('coding', 5, ['SWE-Bench Verified 80.2', 'LiveCodeBench v6 89.6']),
    rating('agentic', 5, ['BrowseComp Agent Swarm 86.3', 'OSWorld-Verified 73.1']),
    rating('vision', 4.5, ['MMMU-Pro 79.4', 'MathVision 87.4']),
  ],
  'nvidia/nemotron-3-ultra-550b-a55b': [
    rating('chat', 4.5, ['IFBench prompt 82.3 NVFP4']),
    rating('reasoning', 5, ['GPQA 87.9 NVFP4', 'RULER 1M 94.0']),
    rating('coding', 4.5, ['SWE-Bench Verified 69.7', 'Terminal-Bench 2.1 53.9']),
    rating('tool use', 4.5, ['TauBench v3 average 70.3']),
  ],
  'nvidia/nemotron-3-super-120b-a12b': [
    rating('reasoning', 4.5, ['GPQA 82.7 with tools', 'MMLU-Pro 83.73']),
    rating('math', 5, ['AIME 2025 90.21', 'HMMT Feb 2025 93.67']),
    rating('coding', 4.5, ['LiveCodeBench v5 81.19', 'SWE-Bench OpenHands 60.47']),
  ],
  'nvidia/nemotron-3.5-lightning-30b-a3b': [
    rating('chat', 4, ['IFBench loose 72.88', 'MMLU-Pro 81.62']),
    rating('reasoning', 4, ['GPQA Diamond 75.57', 'HLE 10.47']),
    rating('coding', 3.5, ['SWE-Bench Verified 52.80', 'Terminal-Bench 2.1 23.46']),
    rating('long context', 4, ['AA-LCR 49.19', '1M context model card']),
  ],
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': [
    rating('vision', 4.5, ['CVBench2D 83.95', 'MathVista Mini 82.8']),
    rating('documents', 4, ['OCRBenchV2 67.04', 'MMlongBench Doc 57.5']),
    rating('computer use', 3.5, ['OSWorld 47.4', 'CharXiv Reasoning 63.6']),
    rating('speech', 4.5, ['Voice interaction 89.39', 'Daily Omni 74.52']),
  ],
  'openai/gpt-oss-120b': [
    rating('reasoning', 4.5, ['GPQA Diamond 80.1', 'MMLU 90.0']),
    rating('math', 5, ['AIME 2024 95.8', 'AIME 2025 92.5']),
    rating('coding', 4, ['SWE-Bench Verified 62.4', 'Aider Polyglot 44.4']),
    rating('tool use', 4, ['Tau-Bench Retail 67.8', 'Tau-Bench Airline 49.2']),
  ],
  'openai/gpt-oss-20b': [
    rating('reasoning', 4, ['GPQA Diamond 71.5', 'MMLU 85.3']),
    rating('math', 5, ['AIME 2024 92.1', 'AIME 2025 91.7']),
    rating('coding', 4, ['SWE-Bench Verified 60.7', 'Aider Polyglot 34.2']),
    rating('tool use', 3.5, ['Tau-Bench Retail 54.4', 'Tau-Bench Airline 38.0']),
  ],
  'poolside/laguna-xs-2.1': [
    rating('coding', 4.5, ['SWE-Bench Verified 70.9', 'SWE-Bench Multilingual 63.1']),
    rating('agentic', 3.5, ['Terminal-Bench 2.0 37.5', 'SWE-Bench Pro 47.6']),
  ],
};

function rating(
  capability: string,
  cupcakes: number,
  benchmarks: string[],
): NonNullable<ModelDescriptor['capabilityRatings']>[number] {
  return {
    capability,
    cupcakes,
    benchmarks,
    confidence: benchmarks.length >= 2 ? 'medium' : 'provisional',
  };
}

export function nativeModelName(model: ModelDescriptor): string {
  const candidate = model.runtimeModelId ?? model.id;
  return candidate.replace(/^nvidia-nim:/, '').replace(/^hf:/, '');
}

export function publisherForModel(model: ModelDescriptor): string {
  if (model.publisher) return PUBLISHERS[model.publisher.toLowerCase()] ?? model.publisher;
  const native = nativeModelName(model);
  const owner = native.includes('/') ? native.split('/', 1)[0]!.toLowerCase() : '';
  return (
    PUBLISHERS[owner] ?? (model.provider === 'Hugging Face' ? owner || 'Community' : model.provider)
  );
}

export function benchmarkRatingsForModel(
  model: ModelDescriptor,
): ModelDescriptor['capabilityRatings'] {
  return model.capabilityRatings ?? EVIDENCE[nativeModelName(model)] ?? [];
}

export function modelIsAvailableInChat(model: ModelDescriptor): boolean {
  if (model.provider === 'NVIDIA NIM' && model.chatCompatibility === 'non_chat') return false;
  return ['ready', 'benchmarked', 'installed', 'offline'].includes(model.status);
}

export function modelVerificationLabel(model: ModelDescriptor): string {
  if (model.verificationState === 'docs_verified_chat') return 'Chat documented';
  if (model.verificationState === 'operationally_verified') return 'Tested now';
  if (model.chatCompatibility === 'chat') return 'Chat compatible';
  if (model.chatCompatibility === 'non_chat') return 'Specialized endpoint';
  return 'Not yet verified';
}
