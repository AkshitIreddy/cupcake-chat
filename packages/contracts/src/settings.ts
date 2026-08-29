import { Type, type Static } from '@sinclair/typebox';
import { ModelSelection } from './models.js';
import { DurationMs, StrictObject } from './primitives.js';

export const ThemeId = Type.Union([
  Type.Literal('cupcake-light'),
  Type.Literal('cupcake-dark'),
  Type.Literal('minimal'),
  Type.Literal('classic'),
]);

export const PersonalityPreset = Type.Union([
  Type.Literal('balanced'),
  Type.Literal('concise'),
  Type.Literal('warm'),
  Type.Literal('analytical'),
  Type.Literal('custom'),
]);

export const AppSettings = StrictObject(
  {
    schemaVersion: Type.Literal(1),
    theme: ThemeId,
    followSystemTheme: Type.Boolean(),
    reducedMotion: Type.Union([
      Type.Literal('system'),
      Type.Literal('always'),
      Type.Literal('never'),
    ]),
    textScale: Type.Number({ minimum: 0.8, maximum: 2 }),
    defaultModel: ModelSelection,
    developerMode: Type.Boolean(),
    thoughtsAndDreams: Type.Boolean({ default: false }),
    proactiveSuggestions: Type.Boolean({ default: false }),
    sendShortcut: Type.Union([Type.Literal('enter'), Type.Literal('ctrl-enter')]),
    telemetry: Type.Union([Type.Literal('off'), Type.Literal('local-only')]),
    developerEventRetentionMs: DurationMs,
    personality: StrictObject({
      preset: PersonalityPreset,
      warmth: Type.Number({ minimum: 0, maximum: 1 }),
      verbosity: Type.Number({ minimum: 0, maximum: 1 }),
      initiative: Type.Number({ minimum: 0, maximum: 1 }),
      playfulness: Type.Number({ minimum: 0, maximum: 1 }),
    }),
    executionPolicy: StrictObject({
      sandboxedCodeEnabled: Type.Boolean(),
      unsandboxedCodeEnabled: Type.Literal(false),
      networkDefault: Type.Literal('denied'),
      automaticTaskThresholdMs: DurationMs,
    }),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/app-settings.schema.json' },
);

export const ThemeTokens = StrictObject(
  {
    id: ThemeId,
    colors: StrictObject({
      crumb: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
      paper: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
      cocoa: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
      berry: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
      pistachio: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
      blueberry: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
    }),
    typography: StrictObject({
      display: Type.String({ minLength: 1, maxLength: 128 }),
      body: Type.String({ minLength: 1, maxLength: 128 }),
      mono: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    mascotStyle: Type.Union([Type.Literal('flat'), Type.Literal('classic-glossy')]),
  },
  { $id: 'https://schemas.cupcakeagi.local/v1/theme-tokens.schema.json' },
);

export type ThemeId = Static<typeof ThemeId>;
export type AppSettings = Static<typeof AppSettings>;
export type ThemeTokens = Static<typeof ThemeTokens>;
