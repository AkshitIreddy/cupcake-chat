#!/usr/bin/env node
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const suffix = process.platform === 'win32' ? '.exe' : '';
const stage = join(
  process.cwd(),
  'out',
  'sidecars',
  `${process.platform}-${process.arch}`,
  'sidecars',
);
const broker = join(stage, `cupcake-tool-broker${suffix}`);
const runtime = join(stage, `cupcake-runtime${suffix}`);
const dataDirectory = await mkdtemp(join(tmpdir(), 'cupcake-sidecar-smoke-'));
const secret = randomBytes(32);
const sessionId = uuidV7();
const inheritedEnvironment =
  process.env.CUPCAKE_FORCE_MINIMAL_WINDOWS_ENV === '1'
    ? {
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: `${process.env.SYSTEMROOT}\\System32`,
        PATHEXT: '.CPL',
      }
    : process.env;
const processHandle = spawn(broker, ['--stdio'], {
  env: {
    ...inheritedEnvironment,
    CUPCAKE_BROKER_AUTH: secret.toString('base64url'),
    CUPCAKE_RUNTIME_PATH: runtime,
    CUPCAKE_DATA_DIR: dataDirectory,
    CUPCAKE_LOCAL_BASELINE_DIR: join(stage, 'cupcake-local'),
    CUPCAKE_PROTOCOL_VERSION: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stderr = '';
processHandle.stderr.setEncoding('utf8');
processHandle.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const frames = frameReader(processHandle.stdout);
try {
  const handshakeId = uuidV7();
  send('handshake', handshakeId, { product: 'CUPCAKEAGI', protocolVersion: 1 });
  const handshake = await nextFrame(30_000);
  assert(handshake.type === 'handshake', 'broker handshake response missing');
  assert(verify(handshake), 'broker handshake response authentication failed');

  // The broker handshake is intentionally cheap; the frozen Python process is
  // extracted only on its first proxied request. Match the desktop's safe
  // startup path by warming that process with an idempotent health request
  // before asserting the richer bootstrap surface.
  const health = await requestRuntime('runtime.health', {
    protocolProbe: {
      probe: 1e-6,
      decimal: 2.5e-6,
      ordinary: 1e-4,
      tiny: 1e-7,
      negativeZero: -0,
      largeDecimal: 1e20,
      scientific: 1e21,
      hardware: 31.62752914428711,
      '\ue000': 1,
      '😀': 2,
    },
  });
  assert(health.payload?.ok === true, `runtime health failed: ${JSON.stringify(health.payload)}`);

  const project = await requestRuntime('projects.create', {
    name: 'Canonical seed 😀 \ue000',
    description: 'Numbers: 0.000001, 1e-7, 100000000000000000000',
  });
  assert(project.payload?.ok === true, `project seed failed: ${JSON.stringify(project.payload)}`);
  const projectId = project.payload.result?.id;
  assert(typeof projectId === 'string', 'project seed did not return an id');
  const conversation = await requestRuntime('conversations.create', {
    title: 'Protocol bootstrap seed',
    projectId,
  });
  assert(
    conversation.payload?.ok === true,
    `conversation seed failed: ${JSON.stringify(conversation.payload)}`,
  );

  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await requestRuntime('app.bootstrap', {});
    assert(
      response.payload?.ok === true,
      `runtime bootstrap ${attempt + 1} failed: ${JSON.stringify(response.payload)}`,
    );
    assert(response.payload.result?.mode === 'runtime', 'broker did not reach the Python runtime');
    assert(Array.isArray(response.payload.result?.models), 'runtime model catalog missing');
    assert(
      response.payload.result?.projects?.some((item) => item.id === projectId),
      'seeded project missing from bootstrap',
    );
  }
  assert(response, 'runtime bootstrap response missing');

  const chat = await requestRuntimeStream('chat.send', {
    content: 'Return the deterministic packaged-runtime acknowledgement.',
    modelId: 'mock:cupcake-deterministic',
  });
  assert(
    chat.response.payload?.ok === true,
    `runtime chat failed: ${JSON.stringify(chat.response.payload)}`,
  );
  assert(
    chat.events.some((event) => event.payload?.type === 'message.completed'),
    'runtime chat did not emit message.completed before its terminal response',
  );
  assert(
    chat.response.payload.result?.status === 'completed',
    `runtime chat did not return a completed terminal result: ${JSON.stringify(chat.response.payload)}`,
  );

  // This response contains runtime endpoint dataclasses in the production
  // service. Exercise it over the authenticated frozen pipe so JSON-safe
  // redaction and outbound sequencing regressions cannot hide behind the
  // desktop's noncritical refresh recovery.
  const discovery = await requestRuntime('local_models.cupcake.status', {});
  assert(
    discovery.payload?.ok === true,
    `local model discovery failed: ${JSON.stringify(discovery.payload)}`,
  );
  assert(
    Array.isArray(discovery.payload.result?.availableModels) &&
      discovery.payload.result.availableModels.length === 11,
    'signed Cupcake Local model catalog is missing',
  );
  assert(
    Array.isArray(discovery.payload.result?.availableRuntimes) &&
      discovery.payload.result.availableRuntimes.length === 4,
    'signed Cupcake Local CPU/CUDA 13/CUDA 12/Vulkan runtime ladder is missing',
  );
  if (process.env.CUPCAKE_EXPECT_NVIDIA === '1') {
    const hardware = discovery.payload.result?.hardware;
    assert(
      typeof hardware?.gpu_name === 'string' && hardware.gpu_name.startsWith('NVIDIA'),
      `packaged runtime did not detect the expected NVIDIA GPU: ${JSON.stringify(hardware)}`,
    );
    assert(
      typeof hardware?.gpu_driver_version === 'string' && hardware.gpu_driver_version.length > 0,
      `packaged runtime did not detect the NVIDIA driver: ${JSON.stringify(hardware)}`,
    );
    assert(
      Array.isArray(hardware?.acceleration) && hardware.acceleration.includes('cuda'),
      `packaged runtime did not expose CUDA acceleration: ${JSON.stringify(hardware)}`,
    );
  }

  const shutdownId = uuidV7();
  send('shutdown', shutdownId, {});
  const shutdown = await nextFrame(30_000);
  assert(shutdown.type === 'response' && shutdown.payload?.ok === true, 'shutdown failed');
  process.stdout.write(
    `Sidecar protocol passed: broker → encrypted Python runtime (${response.payload.result.models.length} models).\n`,
  );
} finally {
  processHandle.stdin.end();
  const exit = await Promise.race([
    new Promise((resolve) => processHandle.once('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
  ]);
  if (exit === 'timeout') processHandle.kill();
  await rm(dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

function send(type, correlationId, payload) {
  const unsigned = {
    version: 1,
    messageId: uuidV7(),
    correlationId,
    sessionId,
    sequence: 1,
    deadline: new Date(Date.now() + 180_000).toISOString(),
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

async function requestRuntime(method, params) {
  const correlationId = uuidV7();
  send('request', correlationId, { method, params });
  while (true) {
    const frame = await nextFrame(120_000);
    assert(verify(frame), `${method} response authentication failed`);
    if (frame.correlationId === correlationId && frame.type === 'response') return frame;
  }
}

async function requestRuntimeStream(method, params) {
  const correlationId = uuidV7();
  const events = [];
  send('request', correlationId, { method, params });
  while (true) {
    const frame = await nextFrame(120_000);
    assert(verify(frame), `${method} response authentication failed`);
    if (frame.correlationId !== correlationId) continue;
    if (frame.type === 'event') {
      events.push(frame);
      continue;
    }
    if (frame.type === 'response') return { events, response: frame };
    throw new Error(`${method} returned unexpected frame type ${frame.type}`);
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
      const text = buffer.subarray(4, length + 4).toString('utf8');
      const value = JSON.parse(text);
      assert(canonicalJson(value) === text, 'sidecar emitted a noncanonical protocol frame');
      buffer = buffer.subarray(length + 4);
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else queue.push(value);
    }
  });
  return { queue, waiting };
}

function nextFrame(timeout) {
  if (frames.queue.length) return Promise.resolve(frames.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = frames.waiting.indexOf(deliver);
      if (index >= 0) frames.waiting.splice(index, 1);
      reject(new Error(`Sidecar response timed out. ${stderr}`));
    }, timeout);
    const deliver = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    frames.waiting.push(deliver);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`${message}\n${stderr}`);
}
