#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const skipLocalModelTest = args.includes('--skip-local-model-test');
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} is required`);
  return resolve(args[index + 1]);
};
const dataDirectory = option('--data-dir');
const keysFile = option('--keys-file');
const evidenceFile = option('--evidence');
const stage = resolve('apps', 'desktop', 'src-tauri', 'target', 'release', 'sidecars');
const secret = randomBytes(32);
const sessionId = uuidV7();
const keyBytes = await readFile(keysFile);
const providerKeys = parseKeys(keyBytes.toString('utf8'));
keyBytes.fill(0);
const requiredProviders = ['cohere', 'nvidia_nim'];
for (const provider of requiredProviders) {
  if (!providerKeys.has(provider)) throw new Error(`Authorized key file is missing ${provider}`);
}

const processHandle = spawn(join(stage, 'cupcake-tool-broker.exe'), ['--stdio'], {
  env: {
    ...process.env,
    CUPCAKE_BROKER_AUTH: secret.toString('base64url'),
    CUPCAKE_RUNTIME_PATH: join(stage, 'cupcake-runtime.exe'),
    CUPCAKE_DATA_DIR: dataDirectory,
    CUPCAKE_LOCAL_BASELINE_DIR: join(stage, 'cupcake-local'),
    CUPCAKE_PROTOCOL_VERSION: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const processTermination = new Promise((resolveTermination) => {
  processHandle.once('error', (error) =>
    resolveTermination({ kind: 'spawn-error', detail: error.code ?? error.name }),
  );
  processHandle.once('exit', (code, signal) =>
    resolveTermination({ kind: 'exit', detail: code ?? signal ?? 'unknown' }),
  );
});
const frames = frameReader(processHandle.stdout);
let stderr = '';
processHandle.stderr.setEncoding('utf8');
processHandle.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4096);
});

const evidence = {
  profile: dataDirectory,
  startedAt: new Date().toISOString(),
  providers: [],
  installedRuntimes: [],
  activeRuntime: null,
  installedModels: [],
  hostedChat: false,
  localChat: false,
  localDefault: false,
};

try {
  const handshakeId = uuidV7();
  send('handshake', handshakeId, { product: 'CUPCAKEAGI', protocolVersion: 1 });
  const handshake = await nextFrame(180_000);
  assert(handshake.type === 'handshake' && verify(handshake), 'broker handshake failed');
  await expectOk('runtime.health', {}, 120_000);

  for (const [label, provider] of [
    ['cohere', 'cohere'],
    ['nvidia_nim', 'nvidia-nim'],
  ]) {
    const response = await expectOk(
      'providers.connect',
      { provider, secret: providerKeys.get(label) },
      180_000,
    );
    evidence.providers.push({
      provider,
      state: response.result?.state ?? 'unknown',
      persistent: response.result?.persistent !== false,
      modelsDiscovered: Array.isArray(response.result?.models) ? response.result.models.length : 0,
    });
  }
  providerKeys.clear();
  const providerStatus = await expectOk('providers.status', {}, 60_000);
  for (const provider of ['cohere', 'nvidia-nim']) {
    assert(
      providerStatus.result?.providers?.some(
        (item) => item.provider === provider && item.configured === true,
      ),
      `${provider} was not persisted`,
    );
  }

  await expectOk('models.select', { modelId: 'cohere:command-a-03-2025' }, 60_000);
  const hostedParams = {
    content: 'Reply with exactly: CUPCAKE HOSTED READY',
    modelId: 'cohere:command-a-03-2025',
  };
  const hostedPreflight = await expectOk('chat.preflight', hostedParams, 60_000);
  const hosted = await requestRuntimeStream(
    'chat.send',
    {
      ...hostedParams,
      outboundIntent: hostedPreflight.result?.outboundIntent,
      outboundConfirmationToken: hostedPreflight.result?.confirmationToken,
    },
    180_000,
  );
  assert(
    hosted.response.payload?.ok === true,
    `hosted Cohere chat failed (${sanitizeDiagnostic(
      JSON.stringify({ error: hosted.response.payload?.error, events: hosted.events }),
    )})`,
  );
  evidence.hostedChat = hosted.events.some((event) => event.payload?.type === 'message.completed');

  let localStatus = (await expectOk('local_models.cupcake.status', { verifyIntegrity: true }, 180_000))
    .result;
  const installedBackends = () => new Set((localStatus.runtimes ?? []).map((item) => item.backend));
  const runtimeInstalls = [
    ['llama.cpp:b10679:windows-x64-vulkan', []],
    [
      'llama.cpp:b10679:windows-x64-cuda-12.4',
      ['https://docs.nvidia.com/cuda/eula/index.html'],
    ],
    [
      'llama.cpp:b10679:windows-x64-cuda-13.3',
      ['https://docs.nvidia.com/cuda/eula/index.html'],
    ],
  ];
  for (const [artifactId, acceptedLicenseUrls] of runtimeInstalls) {
    const backend = artifactId.endsWith('vulkan')
      ? 'vulkan'
      : artifactId.includes('12.4')
        ? 'cuda-12'
        : 'cuda-13';
    if (installedBackends().has(backend)) continue;
    await expectOk(
      'local_models.cupcake.download',
      { artifactId, artifactKind: 'runtime', activate: false, acceptedLicenseUrls },
      3_600_000,
    );
    localStatus = (await expectOk('local_models.cupcake.status', { verifyIntegrity: true }, 180_000))
      .result;
  }
  await expectOk(
    'local_models.cupcake.runtime.activate',
    { version: 'b10679', backend: 'cuda-13' },
    180_000,
  );
  localStatus = (await expectOk('local_models.cupcake.status', { verifyIntegrity: true }, 180_000))
    .result;
  evidence.installedRuntimes = (localStatus.runtimes ?? []).map((item) => ({
    version: item.version,
    backend: item.backend,
    integrityVerified: item.integrity_verified,
  }));
  evidence.activeRuntime = localStatus.activeRuntime?.backend ?? null;
  evidence.installedModels = (localStatus.models ?? []).map((item) => ({
    id: item.id,
    integrityVerified: item.integrity_verified,
    sizeBytes: item.size_bytes,
  }));
  assert(
    ['cpu', 'vulkan', 'cuda-12', 'cuda-13'].every((backend) =>
      evidence.installedRuntimes.some(
        (runtime) => runtime.backend === backend && runtime.integrityVerified,
      ),
    ),
    'the complete runtime ladder is not installed',
  );
  assert(evidence.activeRuntime === 'cuda-13', 'CUDA 13 is not active');
  assert(
    evidence.installedModels.some(
      (model) => model.id === 'qwen3-8b-q4-k-m' && model.integrityVerified,
    ),
    'Qwen3 8B is not installed with verified integrity',
  );

  if (!skipLocalModelTest) {
    const loaded = await expectOk(
      'local_models.cupcake.load',
      {
        modelId: 'qwen3-8b-q4-k-m',
        contextSize: 4096,
        gpuLayers: 'auto',
        timeoutSeconds: 240,
      },
      600_000,
    );
    const localModelId = loaded.result?.model?.id;
    assert(
      localModelId === 'openai-compatible:cupcake-local/qwen3-8b-q4-k-m',
      'local model route was not registered',
    );
    await expectOk('models.select', { modelId: localModelId }, 60_000);
    evidence.localDefault = true;
    const local = await requestRuntimeStream(
      'chat.send',
      { content: 'Reply with exactly: CUPCAKE LOCAL READY', modelId: localModelId },
      600_000,
    );
    assert(local.response.payload?.ok === true, 'local CUDA chat failed');
    evidence.localChat = local.events.some((event) => event.payload?.type === 'message.completed');
  }

  const shutdownId = uuidV7();
  send('shutdown', shutdownId, {});
  const shutdown = await nextFrame(60_000);
  assert(shutdown.type === 'response' && shutdown.payload?.ok === true, 'broker shutdown failed');
} catch (error) {
  const diagnostics = sanitizeDiagnostic(stderr);
  throw new Error(`${error.message}; broker diagnostics: ${diagnostics || 'empty'}`);
} finally {
  providerKeys.clear();
  secret.fill(0);
  processHandle.stdin.end();
  const exit = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 15_000)),
  ]);
  if (exit === 'timeout') processHandle.kill();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

assert(
  evidence.hostedChat &&
    (skipLocalModelTest || (evidence.localChat && evidence.localDefault)),
  'chat acceptance incomplete',
);
process.stdout.write(
  `Ready profile provisioned: providers=${evidence.providers.map((item) => item.provider).join(',')} runtimes=${evidence.installedRuntimes.map((item) => item.backend).join(',')} model=qwen3-8b-q4-k-m\n`,
);

function parseKeys(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*[=:]\s*(\S.*?)\s*$/u);
    if (match) values.set(match[1].toLowerCase(), match[2]);
  }
  return values;
}

function send(type, correlationId, payload, timeoutMs = 180_000) {
  const unsigned = {
    version: 1,
    messageId: uuidV7(),
    correlationId,
    sessionId,
    sequence: 1,
    deadline: new Date(Date.now() + timeoutMs).toISOString(),
    lineage: {},
    type,
    payload,
  };
  const envelope = { ...unsigned, authTag: authenticate(unsigned) };
  const body = Buffer.from(canonicalJson(envelope));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  processHandle.stdin.write(Buffer.concat([header, body]));
}

async function expectOk(method, params, timeoutMs) {
  const frame = await requestRuntime(method, params, timeoutMs);
  assert(frame.payload?.ok === true, `${method} failed (${frame.payload?.error?.code ?? 'unknown'})`);
  return frame.payload;
}

async function requestRuntime(method, params, timeoutMs) {
  const correlationId = uuidV7();
  send('request', correlationId, { method, params }, timeoutMs);
  while (true) {
    const frame = await nextFrame(timeoutMs);
    assert(verify(frame), `${method} response authentication failed`);
    if (frame.correlationId === correlationId && frame.type === 'response') return frame;
  }
}

async function requestRuntimeStream(method, params, timeoutMs) {
  const correlationId = uuidV7();
  const events = [];
  send('request', correlationId, { method, params }, timeoutMs);
  while (true) {
    const frame = await nextFrame(timeoutMs);
    assert(verify(frame), `${method} response authentication failed`);
    if (frame.correlationId !== correlationId) continue;
    if (frame.type === 'event') events.push(frame);
    if (frame.type === 'response') return { events, response: frame };
  }
}

function authenticate(value) {
  return createHmac('sha256', secret).update(canonicalJson(value)).digest('base64url');
}

function verify(envelope) {
  const { authTag, ...unsigned } = envelope;
  return authTag === authenticate(unsigned);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function uuidV7() {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function frameReader(stream) {
  const queue = [];
  const waiting = [];
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      const value = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      const resolveFrame = waiting.shift();
      if (resolveFrame) resolveFrame(value);
      else queue.push(value);
    }
  });
  return { queue, waiting };
}

async function nextFrame(timeoutMs) {
  if (frames.queue.length) return frames.queue.shift();
  return new Promise((resolveFrame, rejectFrame) => {
    let settled = false;
    const removeWaiter = () => {
      const index = frames.waiting.indexOf(deliver);
      if (index >= 0) frames.waiting.splice(index, 1);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeWaiter();
      callback(value);
    };
    const deliver = (value) => finish(resolveFrame, value);
    const timer = setTimeout(
      () => finish(rejectFrame, new Error('protocol timeout')),
      timeoutMs,
    );
    frames.waiting.push(deliver);
    void processTermination.then(({ kind, detail }) =>
      finish(
        rejectFrame,
        new Error(`broker ${kind} before protocol response (${detail})`),
      ),
    );
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeDiagnostic(value) {
  return value
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-1000);
}
