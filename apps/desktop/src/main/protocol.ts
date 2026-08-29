import { createHmac, timingSafeEqual } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const WIRE_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type WireMessageType =
  'handshake' | 'request' | 'response' | 'event' | 'cancel' | 'ping' | 'pong' | 'shutdown';

export interface WireLineage {
  runId?: string;
  taskId?: string;
  parentRunId?: string;
}

export interface WireEnvelope {
  version: typeof WIRE_PROTOCOL_VERSION;
  messageId: string;
  correlationId: string;
  sessionId: string;
  sequence: number;
  deadline: string;
  lineage: WireLineage;
  type: WireMessageType;
  payload: Record<string, unknown>;
  authTag: string;
}

type UnsignedWireEnvelope = Omit<WireEnvelope, 'authTag'>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function signEnvelope(envelope: UnsignedWireEnvelope, secret: Buffer): WireEnvelope {
  const authTag = createHmac('sha256', secret).update(canonicalJson(envelope)).digest('base64url');
  return { ...envelope, authTag };
}

export function verifyEnvelope(envelope: WireEnvelope, secret: Buffer): boolean {
  if (envelope.version !== WIRE_PROTOCOL_VERSION || typeof envelope.authTag !== 'string')
    return false;
  const { authTag, ...unsigned } = envelope;
  const expected = signEnvelope(unsigned, secret).authTag;
  const receivedBytes = Buffer.from(authTag, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}

export function encodeFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength === 0 || body.byteLength > maxFrameBytes) {
    throw new RangeError(`Frame length ${body.byteLength} exceeds the allowed range`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export class JsonFrameDecoder extends Transform {
  readonly #maxFrameBytes: number;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    super({ readableObjectMode: true });
    this.#maxFrameBytes = maxFrameBytes;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, bytes]) : bytes;
    try {
      while (this.#buffer.length >= 4) {
        const length = this.#buffer.readUInt32BE(0);
        if (length === 0 || length > this.#maxFrameBytes) {
          throw new RangeError(`Invalid frame length ${length}`);
        }
        if (this.#buffer.length < length + 4) break;
        const body = this.#buffer.subarray(4, length + 4);
        this.#buffer = this.#buffer.subarray(length + 4);
        this.push(JSON.parse(body.toString('utf8')));
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Unable to decode sidecar frame'));
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.#buffer.length !== 0) {
      callback(new Error('Sidecar stream ended with a partial frame'));
      return;
    }
    callback();
  }
}

export class ReplayGuard {
  readonly #seen = new Set<string>();
  readonly #queue: string[] = [];
  readonly #capacity: number;
  readonly #lastSequenceByCorrelation = new Map<string, number>();
  #sessionId?: string;

  constructor(capacity = 4096, expectedSessionId?: string) {
    this.#capacity = capacity;
    this.#sessionId = expectedSessionId;
  }

  accept(envelope: WireEnvelope): boolean {
    if (!UUID_V7_PATTERN.test(envelope.messageId) || !UUID_V7_PATTERN.test(envelope.correlationId))
      return false;
    if (!UUID_V7_PATTERN.test(envelope.sessionId)) return false;
    if (this.#sessionId !== undefined && envelope.sessionId !== this.#sessionId) return false;
    const previous = this.#lastSequenceByCorrelation.get(envelope.correlationId) ?? 0;
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence !== previous + 1)
      return false;
    if (this.#seen.has(envelope.messageId)) return false;
    const deadline = Date.parse(envelope.deadline);
    if (!Number.isFinite(deadline) || deadline < Date.now()) return false;
    this.#sessionId ??= envelope.sessionId;
    this.#lastSequenceByCorrelation.set(envelope.correlationId, envelope.sequence);
    this.#seen.add(envelope.messageId);
    this.#queue.push(envelope.messageId);
    if (this.#queue.length > this.#capacity) {
      const oldest = this.#queue.shift();
      if (oldest) this.#seen.delete(oldest);
    }
    return true;
  }
}
