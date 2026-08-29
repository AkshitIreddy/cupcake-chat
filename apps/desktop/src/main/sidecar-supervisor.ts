import { accessSync, constants, createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeStatus,
} from '../shared/desktop-api';
import type { InternalFileGrant } from './file-handles';
import {
  encodeFrame,
  JsonFrameDecoder,
  ReplayGuard,
  signEnvelope,
  verifyEnvelope,
  type WireEnvelope,
} from './protocol';
import { MockRuntime } from './mock-runtime';
import { uuidV7 } from './ids';

interface SidecarOptions {
  executablePath?: string;
  runtimeExecutablePath?: string;
  localBaselinePath?: string;
  allowMockFallback: boolean;
  maxRestarts?: number;
  handshakeTimeoutMs?: number;
  manifestPath?: string;
  requireManifest?: boolean;
  userDataPath?: string;
}

interface ShutdownTimings {
  gracefulMs: number;
  stdinCloseMs: number;
  terminateMs: number;
  forceKillMs: number;
}

interface StoppableChildProcess {
  readonly exitCode: number | null;
  readonly stdin: {
    readonly writable: boolean;
    end(): unknown;
  };
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface PendingRequest {
  resolve: (response: RuntimeResponse) => void;
  timer: NodeJS.Timeout;
}

interface BrokerFileGrant {
  id: string;
  kind: InternalFileGrant['kind'];
  name: string;
  absolutePath: string;
  writable: boolean;
}

/**
 * Main-owned replay ledger for desktop file capabilities. Broker processes are
 * disposable, while renderer handles remain active until explicitly released.
 * The ledger stores immutable copies so a restarted broker receives the exact
 * same grants and never a later-mutated object.
 */
export class FileGrantReplayLedger {
  readonly #grants = new Map<string, Readonly<BrokerFileGrant>>();

  register(grant: InternalFileGrant): Readonly<BrokerFileGrant> {
    const snapshot = Object.freeze({
      id: grant.id,
      kind: grant.kind,
      name: grant.name,
      absolutePath: grant.absolutePath,
      writable: grant.writable,
    });
    const existing = this.#grants.get(snapshot.id);
    if (existing && !sameFileGrant(existing, snapshot)) {
      throw new Error('Conflicting file grant re-registration');
    }
    if (!existing) this.#grants.set(snapshot.id, snapshot);
    return existing ?? snapshot;
  }

  release(handleId: string): boolean {
    return this.#grants.delete(handleId);
  }

  replay(send: (grant: Readonly<BrokerFileGrant>) => void): void {
    for (const grant of this.#grants.values()) send(grant);
  }
}

const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/i;
const MAX_REQUEST_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMINGS: Readonly<ShutdownTimings> = {
  gracefulMs: 20_000,
  stdinCloseMs: 1_000,
  terminateMs: 2_000,
  forceKillMs: 2_000,
};

export class SidecarSupervisor extends EventEmitter {
  readonly #options: Required<
    Pick<SidecarOptions, 'allowMockFallback' | 'maxRestarts' | 'handshakeTimeoutMs'>
  > &
    Omit<SidecarOptions, 'allowMockFallback' | 'maxRestarts' | 'handshakeTimeoutMs'>;
  #child?: ChildProcessWithoutNullStreams;
  #mock?: MockRuntime;
  #secret = randomBytes(32);
  #sessionId = uuidV7();
  #outSequenceByCorrelation = new Map<string, number>();
  #replayGuard = new ReplayGuard(4096, this.#sessionId);
  #pending = new Map<string, PendingRequest>();
  readonly #fileGrants = new FileGrantReplayLedger();
  #restartCount = 0;
  #status: RuntimeStatus = { state: 'stopped', mode: 'disabled', restartCount: 0 };
  #stopping = false;
  #stopPromise?: Promise<void>;
  #handshakeTimer?: NodeJS.Timeout;
  #restartTimer?: NodeJS.Timeout;

  constructor(options: SidecarOptions) {
    super();
    this.#options = {
      ...options,
      maxRestarts: options.maxRestarts ?? 3,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 8_000,
    };
  }

  status(): RuntimeStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (this.#child || this.#mock || this.#stopping) return;
    if (process.env.CUPCAKE_DISABLE_RUNTIME === '1') {
      this.#updateStatus({ state: 'disabled', mode: 'disabled', restartCount: this.#restartCount });
      return;
    }

    const executable = this.#options.executablePath;
    if (!executable || !isExecutable(executable)) {
      this.#activateFallback('Broker executable not found');
      return;
    }

    const verified = await verifySidecarSet({
      executablePath: executable,
      runtimeExecutablePath: this.#options.runtimeExecutablePath,
      localBaselinePath: this.#options.localBaselinePath,
      manifestPath: this.#options.manifestPath,
      requireManifest: this.#options.requireManifest === true,
    });
    if (!verified) {
      this.#activateFallback('Sidecar integrity verification failed');
      return;
    }

    this.#startChild(executable);
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    await this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#rejectPending('RUNTIME_STOPPED', 'The desktop runtime is shutting down');
    this.#mock?.close();
    this.#mock = undefined;

    const child = this.#child;
    if (child && child.exitCode === null) {
      const wasReady = this.#status.state === 'ready';
      // Ask the broker to checkpoint/cancel its Python runtime first. Closing
      // stdin alone makes the broker drop its child, bypassing DBOS recovery
      // and provider cleanup during an ordinary desktop quit.
      await stopChildProcess(
        child,
        wasReady ? () => this.#write('shutdown', {}) : undefined,
        wasReady ? DEFAULT_SHUTDOWN_TIMINGS : { ...DEFAULT_SHUTDOWN_TIMINGS, gracefulMs: 0 },
      );
    }
    this.#child = undefined;
    this.#secret.fill(0);
    this.#updateStatus({ state: 'stopped', mode: 'disabled', restartCount: this.#restartCount });
  }

  async request<T = unknown>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
    const validationError = validateRequest(request);
    if (validationError) return failure(validationError.code, validationError.message, false);
    if (this.#mock) return this.#mock.request<T>(request);
    if (!this.#child || this.#status.state !== 'ready') {
      return failure('RUNTIME_NOT_READY', 'The local runtime is not ready', true);
    }

    const messageId = uuidV7();
    const timeoutMs = clampTimeout(request.timeoutMs);
    const envelope = signEnvelope(
      {
        version: 1,
        messageId,
        correlationId: messageId,
        sessionId: this.#sessionId,
        sequence: this.#nextSequence(messageId),
        deadline: new Date(Date.now() + timeoutMs).toISOString(),
        lineage: {},
        type: 'request',
        payload: { method: request.method, params: request.params ?? null },
      },
      this.#secret,
    );

    return new Promise<RuntimeResponse<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(messageId);
        resolve(failure('RUNTIME_TIMEOUT', `${request.method} exceeded its deadline`, true));
        this.#write('cancel', { requestId: messageId }, messageId);
      }, timeoutMs);
      this.#pending.set(messageId, {
        resolve: resolve as (response: RuntimeResponse) => void,
        timer,
      });
      try {
        this.#child?.stdin.write(encodeFrame(envelope));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(messageId);
        resolve(
          failure('RUNTIME_WRITE_FAILED', 'Unable to send the request to the local runtime', true),
        );
      }
    });
  }

  cancel(targetId: string): boolean {
    if (!targetId || targetId.length > 128) return false;
    if (this.#mock) return this.#mock.cancel(targetId);
    if (!this.#child || this.#status.state !== 'ready') return false;
    this.#write('cancel', { targetId });
    return true;
  }

  registerFileGrant(grant: InternalFileGrant): void {
    const snapshot = this.#fileGrants.register(grant);
    if (!this.#child || this.#status.state !== 'ready') return;
    this.#writeFileGrant(snapshot);
  }

  #writeFileGrant(grant: Readonly<BrokerFileGrant>): void {
    this.#write('event', {
      type: 'files.granted',
      handle: {
        id: grant.id,
        kind: grant.kind,
        name: grant.name,
        absolutePath: grant.absolutePath,
        writable: grant.writable,
      },
    });
  }

  releaseFileGrant(handleId: string): void {
    const wasActive = this.#fileGrants.release(handleId);
    if (!wasActive) return;
    if (!this.#child || this.#status.state !== 'ready') return;
    this.#write('event', { type: 'files.released', handleId });
  }

  #startChild(executable: string): void {
    this.#secret.fill(0);
    this.#secret = randomBytes(32);
    this.#sessionId = uuidV7();
    this.#outSequenceByCorrelation.clear();
    this.#replayGuard = new ReplayGuard(4096, this.#sessionId);
    this.#updateStatus({ state: 'starting', mode: 'broker', restartCount: this.#restartCount });

    const child = spawn(executable, ['--stdio'], {
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        USERPROFILE: process.env.USERPROFILE,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        CUPCAKE_BROKER_AUTH: this.#secret.toString('base64url'),
        CUPCAKE_RUNTIME_PATH: this.#options.runtimeExecutablePath,
        CUPCAKE_LOCAL_BASELINE_DIR: this.#options.localBaselinePath,
        CUPCAKE_DATA_DIR: this.#options.userDataPath,
        CUPCAKE_WEB_SEARCH_ENDPOINT: process.env.CUPCAKE_WEB_SEARCH_ENDPOINT,
        CUPCAKE_PROTOCOL_VERSION: '1',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;

    const decoder = new JsonFrameDecoder();
    child.stdout.pipe(decoder);
    decoder.on('data', (message: unknown) => this.#receive(message));
    decoder.on('error', (error) => {
      console.error(`[desktop] broker protocol error: ${safeLog(error.message)}`);
      child.kill('SIGTERM');
    });

    let stderrBuffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) if (line) console.error(`[broker] ${safeLog(line)}`);
    });

    let exitHandled = false;
    const handleExitOnce = (detail: string): void => {
      if (exitHandled) return;
      exitHandled = true;
      if (this.#child === child) this.#child = undefined;
      this.#handleExit(detail);
    };
    child.once('error', () => handleExitOnce('Unable to launch the local broker'));
    child.once('exit', (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      handleExitOnce(`Broker exited (${code ?? signal ?? 'unknown'})`);
    });

    this.#write('handshake', {
      product: 'CUPCAKEAGI',
      protocolVersion: 1,
      pid: process.pid,
    });
    this.#handshakeTimer = setTimeout(() => {
      if (this.#status.state === 'starting') child.kill('SIGTERM');
    }, this.#options.handshakeTimeoutMs);
  }

  #receive(message: unknown): void {
    if (
      !isWireEnvelope(message) ||
      !verifyEnvelope(message, this.#secret) ||
      !this.#replayGuard.accept(message)
    ) {
      console.error('[desktop] rejected unauthenticated, replayed, or malformed broker frame');
      return;
    }

    if (this.#status.state === 'starting') {
      if (message.type !== 'handshake' || !isHandshakePayload(message.payload)) {
        console.error('[desktop] broker sent data before completing protocol handshake');
        this.#child?.kill('SIGTERM');
        return;
      }
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      // A broker restart loses its in-memory capability store. Replay every
      // still-active grant before advertising readiness so a renderer request
      // cannot race ahead of capability restoration.
      this.#fileGrants.replay((grant) => this.#writeFileGrant(grant));
      this.#updateStatus({
        state: 'ready',
        mode: 'broker',
        pid: this.#child?.pid,
        restartCount: this.#restartCount,
      });
      return;
    }

    if (message.type === 'response') {
      const pending = this.#pending.get(message.correlationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.correlationId);
      pending.resolve(normalizeResponse(message.payload));
      return;
    }

    if (message.type === 'event') {
      const payload = message.payload as { type?: unknown; payload?: unknown; timestamp?: unknown };
      if (typeof payload?.type !== 'string') return;
      const event: RuntimeEvent = {
        sequence: message.sequence,
        type: payload.type,
        payload: payload.payload,
        timestamp:
          typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
      };
      this.emit('event', event);
    }
  }

  #write(type: WireEnvelope['type'], payload: unknown, correlationId?: string): void {
    if (!this.#child?.stdin.writable) return;
    const resolvedCorrelationId = correlationId ?? uuidV7();
    const envelope = signEnvelope(
      {
        version: 1,
        messageId: uuidV7(),
        correlationId: resolvedCorrelationId,
        sessionId: this.#sessionId,
        sequence: this.#nextSequence(resolvedCorrelationId),
        deadline: new Date(Date.now() + 30_000).toISOString(),
        lineage: {},
        type,
        payload: normalizePayload(payload),
      },
      this.#secret,
    );
    this.#child.stdin.write(encodeFrame(envelope));
  }

  #nextSequence(correlationId: string): number {
    const sequence = (this.#outSequenceByCorrelation.get(correlationId) ?? 0) + 1;
    this.#outSequenceByCorrelation.set(correlationId, sequence);
    return sequence;
  }

  #handleExit(detail: string): void {
    if (this.#stopping) return;
    this.#rejectPending('RUNTIME_CRASHED', detail);
    if (this.#restartCount < this.#options.maxRestarts && this.#options.executablePath) {
      this.#restartCount += 1;
      this.#updateStatus({
        state: 'crashed',
        mode: 'broker',
        restartCount: this.#restartCount,
        detail,
      });
      const delay = Math.min(8_000, 500 * 2 ** (this.#restartCount - 1));
      this.#restartTimer = setTimeout(() => void this.start(), delay);
      this.#restartTimer.unref();
      return;
    }
    this.#activateFallback(detail);
  }

  #activateFallback(detail: string): void {
    if (!this.#options.allowMockFallback) {
      this.#updateStatus({
        state: 'crashed',
        mode: 'disabled',
        restartCount: this.#restartCount,
        detail,
      });
      return;
    }
    this.#mock = new MockRuntime();
    this.#mock.on('event', (event: RuntimeEvent) => this.emit('event', event));
    this.#updateStatus({ ...this.#mock.status(), detail });
  }

  #rejectPending(code: string, message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failure(code, message, true));
    }
    this.#pending.clear();
  }

  #updateStatus(status: RuntimeStatus): void {
    this.#status = status;
    this.emit('status', { ...status });
  }
}

function sameFileGrant(left: Readonly<BrokerFileGrant>, right: Readonly<BrokerFileGrant>): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.absolutePath === right.absolutePath &&
    left.writable === right.writable
  );
}

function validateRequest(request: RuntimeRequest): { code: string; message: string } | null {
  if (!request || typeof request !== 'object' || !METHOD_PATTERN.test(request.method ?? '')) {
    return { code: 'INVALID_REQUEST', message: 'Runtime method is invalid' };
  }
  try {
    if (
      Buffer.byteLength(JSON.stringify(request.params ?? null), 'utf8') > MAX_REQUEST_JSON_BYTES
    ) {
      return { code: 'REQUEST_TOO_LARGE', message: 'Runtime request exceeds the size limit' };
    }
  } catch {
    return { code: 'INVALID_REQUEST', message: 'Runtime request must be JSON serializable' };
  }
  return null;
}

function clampTimeout(timeoutMs?: number): number {
  // One-file runtime extraction plus SQLCipher/DBOS startup can legitimately
  // exceed thirty seconds on a cold Windows profile. Keep requests bounded,
  // but give the first real runtime call a startup-sized default window.
  if (!Number.isFinite(timeoutMs)) return 120_000;
  return Math.max(1_000, Math.min(5 * 60_000, Math.trunc(timeoutMs!)));
}

function isExecutable(executable: string): boolean {
  try {
    accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWireEnvelope(value: unknown): value is WireEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<WireEnvelope>;
  return (
    envelope.version === 1 &&
    typeof envelope.messageId === 'string' &&
    envelope.messageId.length <= 128 &&
    Number.isSafeInteger(envelope.sequence) &&
    typeof envelope.type === 'string' &&
    ['handshake', 'request', 'response', 'event', 'cancel', 'ping', 'pong', 'shutdown'].includes(
      envelope.type,
    ) &&
    typeof envelope.correlationId === 'string' &&
    typeof envelope.sessionId === 'string' &&
    typeof envelope.deadline === 'string' &&
    Boolean(envelope.lineage && typeof envelope.lineage === 'object') &&
    Boolean(
      envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload),
    ) &&
    typeof envelope.authTag === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(envelope.authTag)
  );
}

function isHandshakePayload(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { protocolVersion?: unknown }).protocolVersion === 1,
  );
}

function normalizeResponse(payload: unknown): RuntimeResponse {
  if (!payload || typeof payload !== 'object')
    return failure('MALFORMED_RESPONSE', 'Runtime response was malformed', true);
  const response = payload as RuntimeResponse;
  if (response.ok === true) return { ok: true, result: response.result };
  if (response.ok === false && response.error && typeof response.error.message === 'string') {
    return {
      ok: false,
      error: {
        code: typeof response.error.code === 'string' ? response.error.code : 'RUNTIME_ERROR',
        message: response.error.message,
        retryable: response.error.retryable === true,
      },
    };
  }
  return failure('MALFORMED_RESPONSE', 'Runtime response was malformed', true);
}

function failure<T>(code: string, message: string, retryable: boolean): RuntimeResponse<T> {
  return { ok: false, error: { code, message, retryable } };
}

export async function stopChildProcess(
  child: StoppableChildProcess,
  sendShutdown: (() => void) | undefined,
  timings: Readonly<ShutdownTimings> = DEFAULT_SHUTDOWN_TIMINGS,
): Promise<void> {
  if (child.exitCode !== null) return;

  if (sendShutdown) {
    try {
      sendShutdown();
    } catch {
      // Continue through the bounded escalation path when the pipe closed
      // between the liveness check and the shutdown write.
    }
  }
  if (await waitForChildExit(child, timings.gracefulMs)) return;

  try {
    if (child.stdin.writable) child.stdin.end();
  } catch {
    // A concurrently closing pipe is equivalent to this escalation stage.
  }
  if (await waitForChildExit(child, timings.stdinCloseMs)) return;

  child.kill('SIGTERM');
  if (await waitForChildExit(child, timings.terminateMs)) return;

  child.kill('SIGKILL');
  await waitForChildExit(child, timings.forceKillMs);
}

export async function waitForChildExit(
  child: Pick<StoppableChildProcess, 'exitCode' | 'once' | 'removeListener'>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  if (timeoutMs <= 0) return child.exitCode !== null;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);

    child.once('exit', onExit);
    // The process may exit between the initial check and listener install.
    if (child.exitCode !== null) finish(true);
  });
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload))
    return payload as Record<string, unknown>;
  return { value: payload };
}

export function safeLog(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\bnvapi-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .slice(0, 4_096);
}

interface SidecarManifest {
  schemaVersion: number;
  protocolVersion: number;
  platform: string;
  architecture: string;
  binaries: Array<{
    id: string;
    file: string;
    bytes: number;
    sha256: string;
    transport: string;
  }>;
  resources?: Array<{
    id: string;
    directory: string;
    manifest: string;
    sha256: string;
  }>;
}

async function verifySidecarSet(options: {
  executablePath: string;
  runtimeExecutablePath?: string;
  localBaselinePath?: string;
  manifestPath?: string;
  requireManifest: boolean;
}): Promise<boolean> {
  if (!options.manifestPath) return !options.requireManifest;
  try {
    const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as SidecarManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.protocolVersion !== 1 ||
      manifest.platform !== process.platform ||
      manifest.architecture !== process.arch ||
      !Array.isArray(manifest.binaries)
    ) {
      return false;
    }
    const brokerValid = await verifyManifestBinary(manifest, 'tool-broker', options.executablePath);
    if (!brokerValid) return false;
    if (options.runtimeExecutablePath) {
      const runtimeValid = await verifyManifestBinary(
        manifest,
        'runtime',
        options.runtimeExecutablePath,
      );
      if (!runtimeValid) return false;
    }
    if (options.localBaselinePath) {
      return verifyManifestResource(manifest, options.localBaselinePath);
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyManifestResource(
  manifest: SidecarManifest,
  baselinePath: string,
): Promise<boolean> {
  const entry = manifest.resources?.find(
    (candidate) => candidate.id === 'cupcake-local-cpu-baseline',
  );
  if (
    !entry ||
    entry.directory !== basename(baselinePath) ||
    entry.manifest !== 'cupcake-local/cupcake-local.manifest.json' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    return false;
  }
  const manifestPath = join(baselinePath, 'cupcake-local.manifest.json');
  try {
    const hash = createHash('sha256');
    hash.update(await readFile(manifestPath));
    if (hash.digest('hex') !== entry.sha256) return false;
    const local = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    return (
      local.environment === 'local-release-candidate' &&
      local.productionSigning === false &&
      local.modelWeightsBundled === false &&
      local.runtimeFileCount === 51
    );
  } catch {
    return false;
  }
}

async function verifyManifestBinary(
  manifest: SidecarManifest,
  id: 'runtime' | 'tool-broker',
  absolutePath: string,
): Promise<boolean> {
  const entry = manifest.binaries.find((candidate) => candidate.id === id);
  if (
    !entry ||
    entry.file !== basename(absolutePath) ||
    entry.transport !== 'authenticated-length-prefixed-json' ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    return false;
  }
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size !== entry.bytes) return false;
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex') === entry.sha256;
}
