import { Type, type Static } from '@sinclair/typebox';
import {
  BranchId,
  ConversationId,
  JsonObject,
  MessageId,
  Nullable,
  StrictObject,
  UtcTimestamp,
  UuidV7,
} from './primitives.js';

export const GroupStrategy = Type.Union([
  Type.Literal('smart-selective'),
  Type.Literal('mentions-only'),
]);

export const PersonaPersonality = StrictObject({
  preset: Type.String({ minLength: 1, maxLength: 40 }),
  warmth: Type.Number({ minimum: 0, maximum: 1 }),
  brevity: Type.Number({ minimum: 0, maximum: 1 }),
  initiative: Type.Number({ minimum: 0, maximum: 1 }),
});

export const Persona = StrictObject(
  {
    id: UuidV7,
    name: Type.String({ minLength: 1, maxLength: 40 }),
    handle: Type.String({ pattern: '^[a-z0-9_-]{2,32}$' }),
    avatar: Type.String({ maxLength: 200 }),
    role: Type.String({ maxLength: 120 }),
    description: Type.String({ maxLength: 1000 }),
    instructions: Type.String({ maxLength: 4000 }),
    speakWhen: Type.String({ maxLength: 1000 }),
    personality: PersonaPersonality,
    modelId: Type.String({ minLength: 1, maxLength: 500 }),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    archivedAt: Nullable(UtcTimestamp),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/persona.schema.json' },
);

export const ParticipantAvailability = StrictObject({
  status: Type.Union([
    Type.Literal('ready'),
    Type.Literal('model_missing'),
    Type.Literal('provider_unavailable'),
    Type.Literal('local_not_loaded'),
    Type.Literal('archived'),
  ]),
  message: Type.String({ maxLength: 500 }),
});

export const ConversationParticipant = StrictObject(
  {
    id: UuidV7,
    conversationId: ConversationId,
    personaId: UuidV7,
    position: Type.Integer({ minimum: 0, maximum: 7 }),
    enabled: Type.Boolean(),
    isLead: Type.Boolean(),
    addedAt: UtcTimestamp,
    persona: Persona,
    availability: ParticipantAvailability,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/conversation-participant.schema.json' },
);

export const ConversationGroupSettings = StrictObject({
  conversationId: ConversationId,
  strategy: GroupStrategy,
  maxReplies: Type.Integer({ minimum: 1, maximum: 3 }),
  leadParticipantId: Nullable(UuidV7),
  rosterRevision: Type.Integer({ minimum: 1 }),
  updatedAt: UtcTimestamp,
});

export const GroupSpeakerSnapshot = StrictObject({
  participantId: UuidV7,
  personaId: UuidV7,
  name: Type.String({ minLength: 1, maxLength: 40 }),
  handle: Type.String({ pattern: '^[a-z0-9_-]{2,32}$' }),
  avatar: Type.String({ maxLength: 200 }),
  role: Type.String({ maxLength: 120 }),
  modelId: Type.String({ minLength: 1, maxLength: 500 }),
  providerId: Type.String({ minLength: 1, maxLength: 200 }),
  privacyRoute: Type.Union([
    Type.Literal('local'),
    Type.Literal('self_hosted'),
    Type.Literal('cloud'),
  ]),
});

export const GroupModelRoute = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 500 }),
  provider: Type.String({ minLength: 1, maxLength: 200 }),
  privacyRoute: Type.String({ minLength: 1, maxLength: 40 }),
  costClass: Type.String({ minLength: 1, maxLength: 80 }),
});

export const GroupEligibleSpeaker = StrictObject({
  participantId: UuidV7,
  persona: Persona,
  model: GroupModelRoute,
  selectionReason: Nullable(Type.String({ maxLength: 120 })),
  attachmentCompatibility: Type.Union([Type.Literal('compatible'), Type.Literal('not_applicable')]),
});

export const GroupIneligibleReason = Type.Union([
  Type.Literal('attachment_incompatible'),
  Type.Literal('offline_blocked'),
  Type.Literal('model_missing'),
  Type.Literal('provider_unavailable'),
  Type.Literal('local_not_loaded'),
  Type.Literal('archived'),
]);

export const GroupIneligibleSpeaker = StrictObject({
  participantId: UuidV7,
  persona: Persona,
  model: StrictObject({
    id: Type.String({ minLength: 1, maxLength: 500 }),
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    privacyRoute: Type.String({ minLength: 1, maxLength: 40 }),
    costClass: Type.String({ minLength: 1, maxLength: 80 }),
  }),
  selectionReason: Nullable(Type.String({ maxLength: 120 })),
  attachmentCompatibility: Type.Literal('incompatible'),
  reasonCode: GroupIneligibleReason,
  message: Type.String({ minLength: 1, maxLength: 500 }),
  repairAction: Type.String({ minLength: 1, maxLength: 100 }),
});

export const GroupDisclosure = StrictObject({
  selector: Nullable(GroupEligibleSpeaker),
  candidateRoutes: Type.Array(GroupEligibleSpeaker, { maxItems: 8 }),
  ineligibleRoutes: Type.Array(GroupIneligibleSpeaker, { maxItems: 8 }),
  maxSelectorCalls: Type.Integer({ minimum: 0, maximum: 3 }),
  selectorMaxOutputTokens: Type.Integer({ minimum: 0, maximum: 1024 }),
  maxReplies: Type.Integer({ minimum: 1, maximum: 3 }),
});

export const GroupTurnPreflight = StrictObject(
  {
    turnId: UuidV7,
    planRevision: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    rosterRevision: Type.Integer({ minimum: 1 }),
    headMessageId: Nullable(MessageId),
    userMessageId: Type.Null(),
    mode: Type.Union([Type.Literal('mentions'), Type.Literal('smart')]),
    strategy: GroupStrategy,
    maxReplies: Type.Integer({ minimum: 1, maximum: 3 }),
    maxSelectorCalls: Type.Integer({ minimum: 0, maximum: 3 }),
    selectorMaxOutputTokens: Type.Integer({ minimum: 0, maximum: 1024 }),
    selector: Nullable(GroupEligibleSpeaker),
    eligibleSpeakers: Type.Array(GroupEligibleSpeaker, { maxItems: 8 }),
    ineligibleSpeakers: Type.Array(GroupIneligibleSpeaker, { maxItems: 8 }),
    sendable: Type.Boolean(),
    confirmationRequired: Type.Boolean(),
    confirmationToken: Nullable(Type.String({ minLength: 32, maxLength: 256 })),
    expiresAt: UtcTimestamp,
    disclosure: GroupDisclosure,
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/group-turn-preflight.schema.json' },
);

export const GroupSelection = StrictObject({
  decision: Type.Union([Type.Literal('speak'), Type.Literal('pass')]),
  participantId: Nullable(UuidV7),
  reasonCode: Type.Union([
    Type.Literal('best_fit'),
    Type.Literal('specialist'),
    Type.Literal('cross_check'),
    Type.Literal('distinct_perspective'),
    Type.Literal('acknowledgement'),
    Type.Literal('user_asked_to_wait'),
    Type.Literal('no_distinct_value'),
  ]),
  reason: Type.String({ maxLength: 120 }),
});

export const GroupTurnMember = StrictObject({
  sequence: Type.Integer({ minimum: 1, maximum: 3 }),
  participantId: UuidV7,
  status: Type.Union([
    Type.Literal('selected'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  messageId: Nullable(MessageId),
  selectionReasonCode: Type.String({ maxLength: 40 }),
  selectionReason: Type.String({ maxLength: 120 }),
  speaker: GroupSpeakerSnapshot,
  usage: JsonObject,
  errorCode: Nullable(Type.String({ maxLength: 128 })),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});

export const GroupSelectorUsage = StrictObject({
  status: Type.Union([
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  selection: Nullable(GroupSelection),
  usage: JsonObject,
  errorCode: Nullable(Type.String({ maxLength: 128 })),
});

export const GroupTurnPlan = StrictObject({
  conversationId: ConversationId,
  branchId: BranchId,
  headMessageId: Nullable(MessageId),
  projectId: Type.Union([UuidV7, Type.Null()]),
  rosterRevision: Type.Integer({ minimum: 1 }),
  strategy: GroupStrategy,
  mode: Type.Union([Type.Literal('mentions'), Type.Literal('smart')]),
  mentions: Type.Array(UuidV7, { maxItems: 3 }),
  selector: Nullable(GroupEligibleSpeaker),
  eligibleSpeakers: Type.Array(GroupEligibleSpeaker, { maxItems: 8 }),
  ineligibleSpeakers: Type.Array(GroupIneligibleSpeaker, { maxItems: 8 }),
  maxReplies: Type.Integer({ minimum: 1, maximum: 3 }),
  maxSelectorCalls: Type.Integer({ minimum: 0, maximum: 3 }),
  selectorMaxOutputTokens: Type.Integer({ minimum: 0, maximum: 1024 }),
  effectiveOffline: Type.Boolean(),
  contentSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  attachmentBindings: Type.Array(JsonObject, { maxItems: 32 }),
  referenceBindings: Type.Array(JsonObject, { maxItems: 32 }),
  memoryIds: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32 }),
  toolIds: Type.Array(Type.Never(), { maxItems: 0 }),
  maxOutputTokens: Nullable(Type.Integer({ minimum: 1 })),
});

export const GroupTurn = StrictObject(
  {
    turnId: UuidV7,
    conversationId: ConversationId,
    branchId: BranchId,
    userMessageId: MessageId,
    status: Type.Union([
      Type.Literal('running'),
      Type.Literal('completed'),
      Type.Literal('waiting_for_you'),
      Type.Literal('selection_failed'),
      Type.Literal('member_failed'),
      Type.Literal('cancelled'),
      Type.Literal('awaiting_tool'),
      Type.Literal('interrupted'),
    ]),
    mode: Type.Union([Type.Literal('mentions'), Type.Literal('smart')]),
    digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    planRevision: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    rosterRevision: Type.Integer({ minimum: 1 }),
    maxReplies: Type.Integer({ minimum: 1, maximum: 3 }),
    maxSelectorCalls: Type.Integer({ minimum: 0, maximum: 3 }),
    selectorCalls: Type.Integer({ minimum: 0, maximum: 3 }),
    responderCalls: Type.Integer({ minimum: 0, maximum: 3 }),
    selectorUsage: Type.Array(GroupSelectorUsage, { maxItems: 3 }),
    plan: GroupTurnPlan,
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    completedAt: Nullable(UtcTimestamp),
    members: Type.Array(GroupTurnMember, { maxItems: 3 }),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/group-turn.schema.json' },
);

export type GroupStrategy = Static<typeof GroupStrategy>;
export type PersonaPersonality = Static<typeof PersonaPersonality>;
export type Persona = Static<typeof Persona>;
export type ParticipantAvailability = Static<typeof ParticipantAvailability>;
export type ConversationParticipant = Static<typeof ConversationParticipant>;
export type ConversationGroupSettings = Static<typeof ConversationGroupSettings>;
export type GroupSpeakerSnapshot = Static<typeof GroupSpeakerSnapshot>;
export type GroupModelRoute = Static<typeof GroupModelRoute>;
export type GroupEligibleSpeaker = Static<typeof GroupEligibleSpeaker>;
export type GroupIneligibleSpeaker = Static<typeof GroupIneligibleSpeaker>;
export type GroupDisclosure = Static<typeof GroupDisclosure>;
export type GroupSelection = Static<typeof GroupSelection>;
export type GroupTurnMember = Static<typeof GroupTurnMember>;
export type GroupSelectorUsage = Static<typeof GroupSelectorUsage>;
export type GroupTurnPlan = Static<typeof GroupTurnPlan>;
export type GroupTurnPreflight = Static<typeof GroupTurnPreflight>;
export type GroupTurn = Static<typeof GroupTurn>;
