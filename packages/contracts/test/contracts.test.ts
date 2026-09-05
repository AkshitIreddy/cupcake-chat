import { describe, expect, it } from 'vitest';
import { contractSchemas, type ContractSchemaName } from '../src/registry.js';
import {
  ContractValidationError,
  parseContract,
  validateContract,
  validateProtocolFrame,
  validateSchema,
} from '../src/validation.js';
import { MAX_PROTOCOL_FRAME_BYTES } from '../src/primitives.js';
import { brokerEffectTranslation } from '../src/broker-wire.js';
import { authTag, ids, validFixtures } from './fixtures.js';

describe('contract registry', () => {
  it('contains stable, unique schema IDs for every published schema', () => {
    const ids = Object.values(contractSchemas).map((schema) => schema.$id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.includes('/v1/'))).toBe(true);
  });

  it.each(Object.entries(validFixtures))('accepts a valid %s fixture', (name, fixture) => {
    const result = validateContract(name as ContractSchemaName, fixture);
    expect(result).toEqual({ ok: true, value: fixture });
  });

  it.each(Object.entries(validFixtures))(
    'rejects unknown top-level fields in %s',
    (name, fixture) => {
      const result = validateContract(name as ContractSchemaName, { ...fixture, unexpected: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    },
  );

  it('rejects unknown nested fields', () => {
    const fixture = structuredClone(validFixtures.model);
    const result = validateContract('model', {
      ...fixture,
      capabilities: { ...fixture.capabilities, canReadMinds: true },
    });
    expect(result.ok).toBe(false);
  });

  it('throws a useful typed error from parseContract', () => {
    expect(() => parseContract('project', { id: 'not-a-uuid' })).toThrow(ContractValidationError);
    try {
      parseContract('project', { id: 'not-a-uuid' });
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('identity and discriminated state', () => {
  it('rejects UUIDv4 identities', () => {
    const result = validateContract('project', {
      ...validFixtures.project,
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a run event with fields from a different discriminant', () => {
    const result = validateContract('run-event', {
      ...validFixtures['run-event'],
      event: { kind: 'message-delta', messageId: ids.a, delta: 'ok', checkpointId: 'smuggled' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects impossible task states instead of accepting boolean piles', () => {
    const result = validateContract('task', { ...validFixtures.task, state: 'running-and-paused' });
    expect(result.ok).toBe(false);
  });

  it('requires unsandboxed execution to remain disabled in settings', () => {
    const result = validateContract('app-settings', {
      ...validFixtures['app-settings'],
      executionPolicy: {
        ...validFixtures['app-settings'].executionPolicy,
        unsandboxedCodeEnabled: true,
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('protocol semantic validation', () => {
  it('accepts a future, bounded frame', () => {
    expect(
      validateProtocolFrame(validFixtures.protocol, { now: new Date('2026-08-28T00:00:00Z') }),
    ).toEqual({
      ok: true,
      value: validFixtures.protocol,
    });
  });

  it('rejects expired frames', () => {
    const result = validateProtocolFrame(
      { ...validFixtures.protocol, deadline: '2026-08-27T00:00:00Z' },
      { now: new Date('2026-08-28T00:00:00Z') },
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues[0]?.path).toBe('/deadline');
  });

  it('rejects an invalid real-world date after structural validation', () => {
    const result = validateProtocolFrame(
      { ...validFixtures.protocol, deadline: '2026-99-99T12:00:00Z' },
      { now: new Date('2026-08-28T00:00:00Z') },
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects frames over 8 MiB before schema traversal', () => {
    const result = validateProtocolFrame(validFixtures.protocol, {
      encodedBytes: MAX_PROTOCOL_FRAME_BYTES + 1,
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '/', message: `Frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes.` }],
    });
  });

  it('rejects malformed auth tags and non-monotonic scalar values', () => {
    expect(
      validateContract('protocol', { ...validFixtures.protocol, authTag: `${authTag}=` }).ok,
    ).toBe(false);
    expect(validateContract('protocol', { ...validFixtures.protocol, sequence: -1 }).ok).toBe(
      false,
    );
  });

  it('rejects replay, cross-session frames, and sequence gaps with receiver state', () => {
    expect(
      validateProtocolFrame(validFixtures.protocol, {
        expectedSessionId: ids.d,
      }),
    ).toMatchObject({ ok: false, issues: [{ path: '/sessionId' }] });
    expect(
      validateProtocolFrame({ ...validFixtures.protocol, sequence: 4 }, { lastSequence: 1 }),
    ).toMatchObject({ ok: false, issues: [{ path: '/sequence' }] });
    expect(
      validateProtocolFrame(validFixtures.protocol, { seenMessageIds: new Set([ids.a]) }),
    ).toMatchObject({ ok: false, issues: [{ path: '/messageId' }] });
  });
});

describe('schema-specific constraints', () => {
  it('provides an exhaustive, explicit product-to-broker effect translation', () => {
    expect(Object.keys(brokerEffectTranslation)).toHaveLength(10);
    expect(brokerEffectTranslation['network-read']).toEqual({
      runtime: 'network',
      native: 'network_read',
    });
    expect(brokerEffectTranslation['financial-transaction']).toEqual({
      runtime: 'money',
      native: 'spend_money',
    });
  });

  it('does not accept product camelCase records as broker snake_case records', () => {
    expect(validateContract('broker-request', validFixtures['tool-intent']).ok).toBe(false);
  });

  it('validates URI fields', () => {
    expect(
      validateContract('provider', { ...validFixtures.provider, endpoint: 'not a uri' }).ok,
    ).toBe(false);
  });

  it('rejects duplicate effects and reasoning levels', () => {
    expect(
      validateContract('tool', {
        ...validFixtures.tool,
        declaredEffects: ['network-read', 'network-read'],
      }).ok,
    ).toBe(false);
    expect(
      validateContract('model', {
        ...validFixtures.model,
        reasoningLevels: ['medium', 'medium'],
      }).ok,
    ).toBe(false);
  });

  it('rejects out-of-range confidence, scores, and personality controls', () => {
    expect(validateContract('memory', { ...validFixtures.memory, confidence: 1.1 }).ok).toBe(false);
    expect(
      validateContract('search-result', { ...validFixtures['search-result'], semanticScore: -0.1 })
        .ok,
    ).toBe(false);
    expect(
      validateContract('app-settings', {
        ...validFixtures['app-settings'],
        personality: { ...validFixtures['app-settings'].personality, warmth: 2 },
      }).ok,
    ).toBe(false);
  });

  it('allows direct validation of exported schema values', () => {
    expect(validateSchema(contractSchemas.project, validFixtures.project).ok).toBe(true);
  });
});
