import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uuidV7 } from './ids';
import {
  canonicalJson,
  encodeFrame,
  JsonFrameDecoder,
  ReplayGuard,
  signEnvelope,
  verifyEnvelope,
  type WireEnvelope,
} from './protocol';

const TEST_SESSION_ID = uuidV7();

function envelope(sequence = 1, correlationId = uuidV7()): WireEnvelope {
  return signEnvelope(
    {
      version: 1,
      messageId: uuidV7(),
      correlationId,
      sessionId: TEST_SESSION_ID,
      sequence,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      lineage: {},
      type: 'request',
      payload: { method: 'runtime.health' },
    },
    Buffer.alloc(32, 7),
  );
}

describe('framed protocol', () => {
  it('uses deterministic recursive key ordering for authentication', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('uses ECMAScript number thresholds and UTF-16 key ordering', () => {
    expect(canonicalJson({ value: 1e-6 })).toBe('{"value":0.000001}');
    expect(canonicalJson({ value: 1e-7 })).toBe('{"value":1e-7}');
    expect(canonicalJson({ '\ue000': 1, '😀': 2 })).toBe('{"😀":2,"\ue000":1}');
  });

  it('matches the shared Python-Rust authentication vectors', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../packages/contracts/test/protocol-auth-vectors.json'),
        'utf8',
      ),
    ) as {
      secretBase64Url: string;
      unsignedEnvelope: Parameters<typeof signEnvelope>[0];
      canonicalUnsigned: string;
      authTag: string;
    };
    expect(canonicalJson(fixture.unsignedEnvelope)).toBe(fixture.canonicalUnsigned);
    expect(
      signEnvelope(fixture.unsignedEnvelope, Buffer.from(fixture.secretBase64Url, 'base64url'))
        .authTag,
    ).toBe(fixture.authTag);
  });

  it('verifies the HMAC and rejects payload tampering', () => {
    const secret = randomBytes(32);
    const message = signEnvelope(
      {
        version: 1,
        messageId: uuidV7(),
        correlationId: uuidV7(),
        sessionId: uuidV7(),
        sequence: 1,
        deadline: new Date(Date.now() + 5_000).toISOString(),
        lineage: {},
        type: 'request',
        payload: { method: 'system.bootstrap' },
      },
      secret,
    );
    expect(verifyEnvelope(message, secret)).toBe(true);
    expect(verifyEnvelope({ ...message, payload: { method: 'tools.delete' } }, secret)).toBe(false);
  });

  it('decodes fragmented and adjacent frames without delimiter ambiguity', async () => {
    const decoder = new JsonFrameDecoder();
    const values: unknown[] = [];
    decoder.on('data', (value) => values.push(value));
    const bytes = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
    decoder.write(bytes.subarray(0, 3));
    decoder.write(bytes.subarray(3, 11));
    decoder.end(bytes.subarray(11));
    await once(decoder, 'end');
    expect(values).toEqual([{ one: 1 }, { two: 2 }]);
  });

  it('emits canonical wire JSON and rejects a noncanonical representation', async () => {
    const value = { z: 1, a: { probe: 1e-6 } };
    const frame = encodeFrame(value);
    expect(frame.subarray(4).toString('utf8')).toBe(canonicalJson(value));

    const body = Buffer.from(JSON.stringify(value), 'utf8');
    expect(body.toString('utf8')).not.toBe(canonicalJson(value));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const decoder = new JsonFrameDecoder();
    const errorPromise = once(decoder, 'error');
    decoder.end(Buffer.concat([header, body]));
    const [error] = await errorPromise;
    expect((error as Error).message).toContain('canonical');
  });

  it('rejects invalid UTF-8 before parsing or authentication', async () => {
    const body = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const decoder = new JsonFrameDecoder();
    const errorPromise = once(decoder, 'error');
    decoder.end(Buffer.concat([header, body]));
    const [error] = await errorPromise;
    expect((error as Error).message).toContain('UTF-8');
  });

  it('rejects declared frames above the configured limit', async () => {
    const decoder = new JsonFrameDecoder(32);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(33);
    const errorPromise = once(decoder, 'error');
    decoder.end(header);
    const [error] = await errorPromise;
    expect((error as Error).message).toContain('Invalid frame length');
  });

  it('rejects replay, gaps, and expired messages per correlation', () => {
    const guard = new ReplayGuard();
    const correlationId = uuidV7();
    const first = envelope(1, correlationId);
    expect(guard.accept(first)).toBe(true);
    expect(guard.accept(first)).toBe(false);
    expect(guard.accept(envelope(3, correlationId))).toBe(false);
    expect(guard.accept(envelope(2, correlationId))).toBe(true);
    expect(guard.accept({ ...envelope(1), deadline: new Date(Date.now() - 1).toISOString() })).toBe(
      false,
    );
  });
});
