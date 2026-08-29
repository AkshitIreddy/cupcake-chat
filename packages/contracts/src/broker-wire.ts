import { Type, type Static } from '@sinclair/typebox';
import {
  JsonObject,
  JsonValue,
  Nullable,
  Sha256,
  StrictObject,
  UtcTimestamp,
} from './primitives.js';
import type { ToolEffect } from './tools.js';

/** Exact snake_case values emitted by `cupcake_runtime.tools.models._wire`. */
export const BrokerWireEffect = Type.Union([
  Type.Literal('read_files'),
  Type.Literal('write_files'),
  Type.Literal('network'),
  Type.Literal('execute_code'),
  Type.Literal('delete'),
  Type.Literal('external_communication'),
  Type.Literal('money'),
  Type.Literal('install'),
  Type.Literal('system_change'),
  Type.Literal('unsandboxed_execution'),
]);

/** Exact Rust `policy::Effect` Serde values. These are broker-internal, not product values. */
export const BrokerNativeEffect = Type.Union([
  Type.Literal('read_files'),
  Type.Literal('write_files'),
  Type.Literal('delete'),
  Type.Literal('network_read'),
  Type.Literal('external_communication'),
  Type.Literal('spend_money'),
  Type.Literal('install_software'),
  Type.Literal('system_change'),
  Type.Literal('execute_sandboxed'),
  Type.Literal('execute_unsandboxed'),
  Type.Literal('manage_models'),
  Type.Literal('manage_artifacts'),
]);

export const brokerEffectTranslation = {
  'read-local': { runtime: 'read_files', native: 'read_files' },
  'write-local': { runtime: 'write_files', native: 'write_files' },
  'delete-local': { runtime: 'delete', native: 'delete' },
  'network-read': { runtime: 'network', native: 'network_read' },
  'external-communication': {
    runtime: 'external_communication',
    native: 'external_communication',
  },
  'financial-transaction': { runtime: 'money', native: 'spend_money' },
  'install-software': { runtime: 'install', native: 'install_software' },
  'system-change': { runtime: 'system_change', native: 'system_change' },
  'execute-sandboxed': { runtime: 'execute_code', native: 'execute_sandboxed' },
  'execute-unsandboxed': {
    runtime: 'unsandboxed_execution',
    native: 'execute_unsandboxed',
  },
} as const satisfies Record<
  ToolEffect,
  {
    readonly runtime: Static<typeof BrokerWireEffect>;
    readonly native: Static<typeof BrokerNativeEffect>;
  }
>;

export const BrokerDataFlowDisclosure = StrictObject({
  destination: Type.Union([
    Type.Literal('local'),
    Type.Literal('provider'),
    Type.Literal('mcp_server'),
    Type.Literal('public_web'),
  ]),
  destination_label: Type.String({ minLength: 1, maxLength: 255 }),
  categories: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { minItems: 1 }),
  purpose: Type.String({ minLength: 1, maxLength: 2048 }),
  contains_user_content: Type.Boolean(),
});

export const BrokerToolDescriptor = StrictObject({
  name: Type.String({ pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$' }),
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
  display_name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.String({ minLength: 1, maxLength: 4096 }),
  input_schema: JsonObject,
  output_schema: JsonObject,
  effects: Type.Array(BrokerWireEffect, { uniqueItems: true }),
  required_grants: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
    uniqueItems: true,
  }),
  default_data_flows: Type.Array(BrokerDataFlowDisclosure),
  timeout_seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
  cancellable: Type.Boolean(),
  category: Type.String({ minLength: 1, maxLength: 128 }),
});

export const BrokerToolIntent = StrictObject({
  invocation_id: Type.String({ minLength: 1, maxLength: 255 }),
  run_id: Type.String({ minLength: 1, maxLength: 255 }),
  tool_name: Type.String({ minLength: 1, maxLength: 255 }),
  tool_version: Type.String({ minLength: 1, maxLength: 64 }),
  arguments: JsonObject,
  project_id: Nullable(Type.String({ minLength: 1, maxLength: 255 })),
  task_id: Nullable(Type.String({ minLength: 1, maxLength: 255 })),
  requested_at: UtcTimestamp,
});

export const BrokerToolPreflight = StrictObject({
  invocation_id: Type.String({ minLength: 1, maxLength: 255 }),
  descriptor_identity: Type.String({ minLength: 3, maxLength: 384 }),
  schema_digest: Sha256,
  resolved_resources: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    uniqueItems: true,
  }),
  effects: Type.Array(BrokerWireEffect, { uniqueItems: true }),
  disclosures: Type.Array(BrokerDataFlowDisclosure),
  decision: Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]),
  requires_fresh_approval: Type.Boolean(),
  intent_digest: Sha256,
  created_at: UtcTimestamp,
});

export const BrokerApprovalBinding = StrictObject({
  approval_id: Type.String({ minLength: 1, maxLength: 255 }),
  invocation_id: Type.String({ minLength: 1, maxLength: 255 }),
  intent_digest: Sha256,
  approved_effects: Type.Array(BrokerWireEffect, { uniqueItems: true }),
  approved_resources: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    uniqueItems: true,
  }),
  issued_at: UtcTimestamp,
  expires_at: UtcTimestamp,
  nonce: Type.String({ minLength: 16, maxLength: 255 }),
  signature: Sha256,
});

const BrokerPreflightPayload = StrictObject({
  intent: BrokerToolIntent,
  descriptor: BrokerToolDescriptor,
});
const BrokerApprovalPayload = StrictObject({
  preflight: BrokerToolPreflight,
  approval: BrokerApprovalBinding,
});
const BrokerExecutePayload = StrictObject({
  intent: BrokerToolIntent,
  preflight: BrokerToolPreflight,
  approval: Nullable(BrokerApprovalBinding),
});
const BrokerCancelPayload = StrictObject({
  invocation_id: Type.String({ minLength: 1, maxLength: 255 }),
  reason: Type.String({ minLength: 1, maxLength: 2048 }),
});

export const BrokerRuntimeRequest = Type.Union(
  [
    StrictObject({
      protocol_version: Type.Literal(1),
      request_type: Type.Literal('tool.preflight'),
      payload: BrokerPreflightPayload,
    }),
    StrictObject({
      protocol_version: Type.Literal(1),
      request_type: Type.Literal('tool.approval.verify'),
      payload: BrokerApprovalPayload,
    }),
    StrictObject({
      protocol_version: Type.Literal(1),
      request_type: Type.Literal('tool.execute'),
      payload: BrokerExecutePayload,
    }),
    StrictObject({
      protocol_version: Type.Literal(1),
      request_type: Type.Literal('tool.cancel'),
      payload: BrokerCancelPayload,
    }),
    StrictObject({
      protocol_version: Type.Literal(1),
      request_type: Type.Union([
        Type.Literal('mcp.connect'),
        Type.Literal('mcp.tools.list'),
        Type.Literal('mcp.tool.call'),
        Type.Literal('mcp.disconnect'),
      ]),
      payload: JsonObject,
    }),
  ],
  { $id: 'https://schemas.cupcakeagi.local/v1/broker-request.schema.json' },
);

export const BrokerToolResult = StrictObject(
  {
    invocation_id: Type.String({ minLength: 1, maxLength: 255 }),
    status: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('denied'),
    ]),
    output: JsonValue,
    error_code: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    error_message: Nullable(Type.String({ minLength: 1, maxLength: 4096 })),
    artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { uniqueItems: true }),
    started_at: Nullable(UtcTimestamp),
    finished_at: UtcTimestamp,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/broker-tool-result.schema.json' },
);

export type BrokerWireEffect = Static<typeof BrokerWireEffect>;
export type BrokerNativeEffect = Static<typeof BrokerNativeEffect>;
export type BrokerRuntimeRequest = Static<typeof BrokerRuntimeRequest>;
export type BrokerToolResult = Static<typeof BrokerToolResult>;
