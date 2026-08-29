import { FormatRegistry, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { contractSchemas, type ContractSchemaName } from './registry.js';
import { MAX_PROTOCOL_FRAME_BYTES, type JsonValue } from './primitives.js';
import type { ProtocolEnvelope } from './protocol.js';

if (!FormatRegistry.Has('uri')) {
  FormatRegistry.Set('uri', (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol.length > 1;
    } catch {
      return false;
    }
  });
}

export interface ContractIssue {
  readonly path: string;
  readonly message: string;
  readonly value?: JsonValue;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

export class ContractValidationError extends Error {
  public readonly issues: readonly ContractIssue[];

  public constructor(contractName: string, issues: readonly ContractIssue[]) {
    super(
      `Invalid ${contractName}: ${issues.map((issue) => `${issue.path || '/'} ${issue.message}`).join('; ')}`,
    );
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

export function validateSchema<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  input: unknown,
): ValidationResult<Static<TSchemaValue>> {
  if (Value.Check(schema, input)) {
    return { ok: true, value: input };
  }

  const issues = [...Value.Errors(schema, input)].map<ContractIssue>((error) => ({
    path: error.path,
    message: error.message,
    ...(isJsonValue(error.value) ? { value: error.value } : {}),
  }));
  return { ok: false, issues };
}

export function validateContract<Name extends ContractSchemaName>(
  name: Name,
  input: unknown,
): ValidationResult<Static<(typeof contractSchemas)[Name]>> {
  return validateSchema(contractSchemas[name], input);
}

export function parseContract<Name extends ContractSchemaName>(
  name: Name,
  input: unknown,
): Static<(typeof contractSchemas)[Name]> {
  const result = validateContract(name, input);
  if (!result.ok) {
    throw new ContractValidationError(name, result.issues);
  }
  return result.value;
}

export function validateProtocolFrame(
  input: unknown,
  options: {
    readonly now?: Date;
    readonly encodedBytes?: number;
    readonly expectedSessionId?: string;
    readonly lastSequence?: number;
    readonly seenMessageIds?: ReadonlySet<string>;
  } = {},
): ValidationResult<ProtocolEnvelope> {
  const encodedBytes = options.encodedBytes ?? Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (encodedBytes > MAX_PROTOCOL_FRAME_BYTES) {
    return {
      ok: false,
      issues: [{ path: '/', message: `Frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes.` }],
    };
  }

  const structural = validateContract('protocol', input);
  if (!structural.ok) return structural;

  const deadline = Date.parse(structural.value.deadline);
  if (!Number.isFinite(deadline)) {
    return { ok: false, issues: [{ path: '/deadline', message: 'Deadline is not a real date.' }] };
  }
  if (deadline < (options.now ?? new Date()).getTime()) {
    return { ok: false, issues: [{ path: '/deadline', message: 'Deadline has elapsed.' }] };
  }
  if (
    options.expectedSessionId !== undefined &&
    structural.value.sessionId !== options.expectedSessionId
  ) {
    return {
      ok: false,
      issues: [{ path: '/sessionId', message: 'Frame belongs to another session.' }],
    };
  }
  if (
    options.lastSequence !== undefined &&
    structural.value.sequence !== options.lastSequence + 1
  ) {
    return {
      ok: false,
      issues: [{ path: '/sequence', message: `Expected sequence ${options.lastSequence + 1}.` }],
    };
  }
  if (options.seenMessageIds?.has(structural.value.messageId) === true) {
    return {
      ok: false,
      issues: [{ path: '/messageId', message: 'Message ID has already been processed.' }],
    };
  }
  return structural;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}
