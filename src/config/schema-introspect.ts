/**
 * Introspect the boot `configSchema` (zod) by setting dot-path, so write-time
 * validation and the settings UI share ONE source of truth with boot-time
 * validation. Without this, `settingsService.set()` only checked the value
 * TYPE while boot checked the full schema (ranges/enums) — letting out-of-range
 * values save fine and then break the next restart.
 */
import type { z } from 'zod';
import { configSchema } from './schema';
import { settingKeyToConfigPath } from './settings-registry';

// zod 4 node shapes vary; these are the wrapper types that hold an `innerType`.
const WRAPPER_TYPES = new Set(['default', 'prefault', 'optional', 'nullable', 'catch', 'readonly']);

// These helpers deliberately walk zod 4's untyped internal node graph (.def,
// .innerType, .shape, .minValue …), so `any` is unavoidable and scoped here.

/** Peel default/optional/etc. wrappers off a node to reach its core schema. */
function unwrap(s: any): any {
  while (s?.def && WRAPPER_TYPES.has(s.def.type) && s.def.innerType) {
    s = s.def.innerType;
  }
  return s;
}

/** The object field-map for an (unwrapped) object node, or null. */
function shapeOf(s: any): Record<string, any> | null {
  const node = unwrap(s);
  const shape = node?.shape ?? node?.def?.shape;
  if (!shape) return null;
  return typeof shape === 'function' ? shape() : shape;
}

/**
 * Resolve the zod schema for a setting key (e.g. 'orchestrator.liteMaxIterations'
 * → the ZodNumber). Returns null for keys that don't map into the config schema
 * (e.g. pure vault-only settings), so callers can fall back to type checks.
 */
export function getFieldSchema(key: string): z.ZodTypeAny | null {
  const path = settingKeyToConfigPath(key);
  let node: any = configSchema;
  for (const seg of path) {
    const shape = shapeOf(node);
    if (!shape || !shape[seg]) return null;
    node = shape[seg];
  }
  return node as z.ZodTypeAny;
}

/** Validate a value against the boot schema for `key`. */
export function validateSettingValue(key: string, value: unknown): { ok: true } | { ok: false; message: string } {
  const field = getFieldSchema(key);
  if (!field) return { ok: true }; // not in config schema — type check covers it
  const result = field.safeParse(value);
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  return { ok: false, message: issue?.message ?? 'invalid value' };
}

export interface EnumOption {
  value: string;
  label: string;
  description?: string;
}

export interface FieldConstraints {
  /** Inclusive minimum (numbers). */
  min?: number;
  /** Inclusive maximum (numbers). */
  max?: number;
  /** Whether the number must be an integer. */
  integer?: boolean;
  /** Allowed values for enum/string-union fields. */
  enumValues?: string[];
  /**
   * Human-friendly labels + help text for enum values, when a setting opts in
   * (see ENUM_LABELS). The UI renders these instead of the raw enum strings.
   */
  enumOptions?: EnumOption[];
}

/**
 * Display metadata for enum settings whose raw values are opaque (e.g. voice
 * providers). Keyed by setting key → value → {label, description}. The option
 * LIST still comes from the zod enum (source of truth); this only dresses it up,
 * so a value with no entry here just falls back to showing its raw string.
 */
const ENUM_LABELS: Record<string, Record<string, { label: string; description: string }>> = {
  'voice.sttProvider': {
    auto: { label: 'Automatic (recommended)', description: 'Picks the best available: cloud realtime if a key is set, otherwise local Whisper.' },
    whisper: { label: 'Local Whisper.cpp (offline)', description: 'Runs on this machine, no API key, free. Capped at the `base` model on CPU; lowest accuracy of the local options.' },
    fasterwhisper: { label: 'Local faster-whisper (offline)', description: 'Runs on this machine, no API key, free. ~4x faster than Whisper.cpp so it runs the `small`/`medium` model in realtime — best local accuracy. Needs `uv` (auto-provisions the rest on first use).' },
    mistral: { label: 'Voxtral (Mistral cloud)', description: 'Low-latency realtime streaming. Requires a Mistral API key.' },
    openai: { label: 'OpenAI (gpt-4o-transcribe)', description: 'Low-latency realtime streaming. Requires an OpenAI API key.' },
  },
  'voice.fasterWhisperModel': {
    tiny: { label: 'tiny', description: 'Fastest, lowest accuracy.' },
    base: { label: 'base', description: 'Fast, low accuracy.' },
    small: { label: 'small (recommended)', description: 'Big accuracy jump over base, comfortably realtime on CPU.' },
    medium: { label: 'medium', description: 'Near-best accuracy; realtime only on a fast multi-core CPU.' },
    large: { label: 'large', description: 'Best accuracy; needs a GPU or a very fast CPU for realtime.' },
  },
  'voice.ttsProvider': {
    mistral: { label: 'Voxtral (Mistral cloud)', description: 'Cloud voice, the default. Requires a Mistral API key.' },
    openai: { label: 'OpenAI (gpt-4o-mini-tts)', description: 'Cloud voice. Requires an OpenAI API key.' },
    kokoro: { label: 'Kokoro (offline)', description: 'Runs on this machine, no API key, free. Best-quality local voice in 2026. Needs the kokoro-tts CLI installed.' },
    piper: { label: 'Piper (offline)', description: 'Runs on this machine, no API key, free. Fastest/smallest local voice for low-end hardware. Needs the Piper binary + a .onnx voice file installed.' },
  },
};

/**
 * Extract human/UI-facing constraints from the schema for `key`, so the
 * settings UI can show accurate hints (and HTML min/max/step) instead of
 * claiming any value is valid. Returns null when the field has no constraints.
 */
export function getFieldConstraints(key: string): FieldConstraints | null {
  const field = getFieldSchema(key);
  if (!field) return null;
  const core = unwrap(field);
  const c: FieldConstraints = {};

  // zod 4 ZodNumber exposes resolved bounds directly.
  if (typeof core?.minValue === 'number' && Number.isFinite(core.minValue)) c.min = core.minValue;
  if (typeof core?.maxValue === 'number' && Number.isFinite(core.maxValue)) c.max = core.maxValue;
  if (core?.isInt === true) c.integer = true;

  // Enum / string-union options.
  const opts: unknown =
    core?.options ?? (core?.def?.entries ? Object.values(core.def.entries) : undefined);
  if (Array.isArray(opts) && opts.length > 0 && opts.every((o) => typeof o === 'string')) {
    c.enumValues = opts as string[];
    const labels = ENUM_LABELS[key];
    if (labels) {
      c.enumOptions = c.enumValues.map((v) => ({ value: v, label: labels[v]?.label ?? v, description: labels[v]?.description }));
    }
  }

  return c.min !== undefined || c.max !== undefined || c.integer || c.enumValues ? c : null;
}
