import { Type, type Static } from '@sinclair/typebox';
import {
  ApprovalId,
  ByteCount,
  DurationMs,
  JsonObject,
  JsonValue,
  Nullable,
  ProjectId,
  Sha256,
  StrictObject,
  ToolId,
  UtcTimestamp,
} from './primitives.js';

export const ToolEffect = Type.Union([
  Type.Literal('read-local'),
  Type.Literal('write-local'),
  Type.Literal('delete-local'),
  Type.Literal('network-read'),
  Type.Literal('external-communication'),
  Type.Literal('financial-transaction'),
  Type.Literal('install-software'),
  Type.Literal('system-change'),
  Type.Literal('execute-sandboxed'),
  Type.Literal('execute-unsandboxed'),
]);

export const ToolRisk = Type.Union([
  Type.Literal('low'),
  Type.Literal('moderate'),
  Type.Literal('high'),
  Type.Literal('critical'),
]);

export const PermissionScope = Type.Union([
  Type.Literal('once'),
  Type.Literal('session'),
  Type.Literal('project'),
]);

export const ResourceHandle = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 512 }),
  kind: Type.Union([
    Type.Literal('file'),
    Type.Literal('directory'),
    Type.Literal('repository'),
    Type.Literal('artifact'),
    Type.Literal('credential'),
    Type.Literal('remote-origin'),
    Type.Literal('process-sandbox'),
  ]),
  displayName: Type.String({ minLength: 1, maxLength: 512 }),
  revision: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

export const DataDestination = StrictObject({
  route: Type.Union([
    Type.Literal('local'),
    Type.Literal('provider'),
    Type.Literal('mcp-server'),
    Type.Literal('web-origin'),
  ]),
  displayName: Type.String({ minLength: 1, maxLength: 255 }),
  origin: Type.Optional(Type.String({ format: 'uri', maxLength: 4096 })),
  dataClasses: Type.Array(
    Type.Union([
      Type.Literal('prompt'),
      Type.Literal('file-content'),
      Type.Literal('memory'),
      Type.Literal('artifact'),
      Type.Literal('usage-metadata'),
    ]),
    { uniqueItems: true },
  ),
});

export const ToolLimits = StrictObject({
  timeoutMs: DurationMs,
  maximumOutputBytes: ByteCount,
  maximumMemoryBytes: Type.Optional(ByteCount),
  maximumCpuMs: Type.Optional(DurationMs),
  network: Type.Union([
    Type.Literal('denied'),
    Type.Literal('allowlisted'),
    Type.Literal('unrestricted'),
  ]),
});

export const ToolDescriptor = StrictObject(
  {
    id: ToolId,
    stableName: Type.String({ pattern: '^[a-z][a-z0-9_.-]{1,127}$' }),
    version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: 4096 }),
    source: Type.Union([Type.Literal('native'), Type.Literal('mcp'), Type.Literal('custom')]),
    inputSchema: JsonObject,
    outputSchema: JsonObject,
    declaredEffects: Type.Array(ToolEffect, { minItems: 1, uniqueItems: true }),
    defaultRisk: ToolRisk,
    requiresProject: Type.Boolean(),
    available: Type.Boolean(),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/tool-descriptor.schema.json' },
);

export const ToolIntent = StrictObject(
  {
    id: ToolId,
    descriptorName: Type.String({ pattern: '^[a-z][a-z0-9_.-]{1,127}$' }),
    descriptorVersion: Type.String({ minLength: 1, maxLength: 64 }),
    projectId: Type.Optional(ProjectId),
    arguments: JsonObject,
    reason: Type.String({ minLength: 1, maxLength: 4096 }),
    requestedAt: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/tool-intent.schema.json' },
);

export const ApprovalRequirement = StrictObject({
  required: Type.Boolean(),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  allowedScopes: Type.Array(PermissionScope, { uniqueItems: true }),
  freshApprovalOnly: Type.Boolean(),
});

export const ToolPreflight = StrictObject(
  {
    intentId: ToolId,
    normalizedArguments: JsonObject,
    resolvedResources: Type.Array(ResourceHandle, { uniqueItems: true }),
    effects: Type.Array(ToolEffect, { minItems: 1, uniqueItems: true }),
    risk: ToolRisk,
    destinations: Type.Array(DataDestination),
    limits: ToolLimits,
    approval: ApprovalRequirement,
    approvalDigest: Sha256,
    preparedAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/tool-preflight.schema.json' },
);

export const ToolApproval = StrictObject({
  id: ApprovalId,
  intentId: ToolId,
  digest: Sha256,
  decision: Type.Union([Type.Literal('approved'), Type.Literal('denied')]),
  scope: PermissionScope,
  decidedAt: UtcTimestamp,
  expiresAt: Nullable(UtcTimestamp),
});

export const ToolResult = Type.Union(
  [
    StrictObject({
      state: Type.Literal('completed'),
      intentId: ToolId,
      startedAt: UtcTimestamp,
      finishedAt: UtcTimestamp,
      durationMs: DurationMs,
      output: JsonValue,
      outputBytes: ByteCount,
      generatedResourceIds: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        uniqueItems: true,
      }),
      provenance: JsonObject,
    }),
    StrictObject({
      state: Type.Literal('failed'),
      intentId: ToolId,
      startedAt: UtcTimestamp,
      finishedAt: UtcTimestamp,
      durationMs: DurationMs,
      code: Type.String({ minLength: 1, maxLength: 128 }),
      message: Type.String({ minLength: 1, maxLength: 4096 }),
      retryable: Type.Boolean(),
      partialOutput: Type.Optional(JsonValue),
    }),
    StrictObject({
      state: Type.Literal('denied'),
      intentId: ToolId,
      decidedAt: UtcTimestamp,
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
    StrictObject({
      state: Type.Literal('cancelled'),
      intentId: ToolId,
      cancelledAt: UtcTimestamp,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    }),
    StrictObject({
      state: Type.Literal('expired'),
      intentId: ToolId,
      expiredAt: UtcTimestamp,
    }),
  ],
  { $id: 'https://schemas.cupcakeagi.local/v1/tool-result.schema.json' },
);

export type ToolEffect = Static<typeof ToolEffect>;
export type ToolDescriptor = Static<typeof ToolDescriptor>;
export type ToolIntent = Static<typeof ToolIntent>;
export type ToolPreflight = Static<typeof ToolPreflight>;
export type ToolApproval = Static<typeof ToolApproval>;
export type ToolResult = Static<typeof ToolResult>;
