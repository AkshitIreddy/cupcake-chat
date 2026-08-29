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
const processHandle = spawn(broker, ['--stdio'], {
  env: {
    ...process.env,
    CUPCAKE_BROKER_AUTH: secret.toString('base64url'),
    CUPCAKE_RUNTIME_PATH: runtime,
    CUPCAKE_DATA_DIR: dataDirectory,
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
  const healthId = uuidV7();
  send('request', healthId, { method: 'runtime.health', params: {} });
  let health;
  while (!health) {
    const frame = await nextFrame(120_000);
    assert(verify(frame), 'runtime health response authentication failed');
    if (frame.correlationId === healthId && frame.type === 'response') health = frame;
  }
  assert(health.payload?.ok === true, `runtime health failed: ${JSON.stringify(health.payload)}`);

  const bootstrapId = uuidV7();
  send('request', bootstrapId, { method: 'app.bootstrap', params: {} });
  let response;
  while (!response) {
    const frame = await nextFrame(120_000);
    assert(verify(frame), 'runtime response authentication failed');
    if (frame.correlationId === bootstrapId && frame.type === 'response') response = frame;
  }
  assert(
    response.payload?.ok === true,
    `runtime bootstrap failed: ${JSON.stringify(response.payload)}`,
  );
  assert(response.payload.result?.mode === 'runtime', 'broker did not reach the Python runtime');
  assert(Array.isArray(response.payload.result?.models), 'runtime model catalog missing');

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
  const body = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  processHandle.stdin.write(Buffer.concat([header, body]));
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
