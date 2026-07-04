/**
 * Request envelope transform for the Gemini-compat custom provider.
 *
 * Emits native Google Gemini wire format. Body shape:
 *     { contents: [{ role, parts: [{text}|{functionCall}|{functionResponse}] }],
 *       systemInstruction?, tools?, generationConfig?: { temperature, maxOutputTokens, ... } }
 *   Path:  /v1beta/models/{model}:generateContent
 *   Stream: /v1beta/models/{model}:streamGenerateContent (SSE)
 *
 * The transform takes a normalized "GenericRequest" and emits the wire body.
 * Responses come back as native Gemini shape (`candidates[].content.parts[]`).
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { AgentMessage } from '@/core/types';

export interface GenericGeminiRequest {
  model: string;
  messages: AgentMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: ChatCompletionTool[];
  stream: boolean;
  responseSchema?: Record<string, unknown>;
  responseMimeType?: string;
  /**
   * When true, minimize internal reasoning. Maps to a per-tier thinkingConfig
   * (never thinkingBudget:0 on Gemini 3 — that's a hard error). From
   * extraBody.think:false.
   */
  disableThinking?: boolean;
  /** Tool-calling policy → functionCallingConfig.mode (AUTO/ANY/NONE). */
  toolChoice?: 'auto' | 'required' | 'none';
}

/**
 * Per-tier Gemini thinkingConfig (pi's rules, google.ts:410-501).
 * Gemini 3 cannot use thinkingBudget:0; flash-lite's minimal budget is 512.
 * Returns the `thinkingConfig` fragment or undefined to leave model defaults.
 */
export function geminiThinkingConfig(
  modelId: string,
  opts: { disable?: boolean },
): Record<string, unknown> | undefined {
  const id = (modelId || '').toLowerCase();
  const isGemini3 = /gemini-3(?:\.\d+)?/.test(id);
  const isGemini3Pro = /gemini-3(?:\.\d+)?-pro/.test(id);
  const isFlashLite = /flash-lite/.test(id);
  const isGemma4 = /gemma-?4/.test(id);

  if (opts.disable) {
    if (isGemini3Pro) return { thinkingLevel: 'LOW' };
    if (isGemini3 || isGemma4) return { thinkingLevel: 'MINIMAL' };
    return { thinkingBudget: 0 }; // Gemini 2.x supports full disable
  }
  // Not disabling: only guarantee a floor for 2.5 flash-lite so a burst of
  // thinking can't starve the tool call. Everything else uses model defaults.
  if (isFlashLite && /2\.5/.test(id)) return { thinkingBudget: 512 };
  return undefined;
}

/** Build native Gemini `contents` array from AgentMessage[]. system messages
 *  are extracted into systemInstruction by the caller. */
export function buildGeminiContents(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled separately

    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.name || 'unknown',
            response: parseToolContent(msg.content),
          },
        }],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      // Replay raw assistant content when available — preserves Gemini 3
      // thought_signature on functionCall parts. Reconstructing from
      // msg.toolCalls drops the signature and Vertex rejects the next turn
      // with 400 ("Function call is missing a thought_signature").
      const raw = msg.providerRaw as { content?: Record<string, unknown> } | undefined;
      if (raw?.content) {
        contents.push(raw.content);
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content && msg.content.trim()) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  return mergeConsecutiveSameRole(contents);
}

/**
 * Fold consecutive same-role `contents` entries into one, concatenating their
 * `parts`. Gemini rejects a request with 400 INVALID_ARGUMENT ("function call
 * turn comes immediately after a user turn or after a function response turn")
 * when a `model` turn carrying a `functionCall` follows another `model` turn —
 * which happens whenever the agent loop emits two assistant turns back to back
 * (e.g. an empty/text-only turn then a tool-call turn, or a nudge path). Unlike
 * OpenAI, Gemini has no tolerance for adjacent same-role turns, so we coalesce
 * them here. This also correctly merges back-to-back tool results into a single
 * user turn with multiple `functionResponse` parts.
 */
function mergeConsecutiveSameRole(
  contents: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  for (const entry of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === entry.role) {
      const prevParts = Array.isArray(prev.parts) ? prev.parts : [];
      const nextParts = Array.isArray(entry.parts) ? entry.parts : [];
      prev.parts = [...prevParts, ...nextParts];
      continue;
    }
    // Shallow-copy so we never mutate the caller's raw content objects.
    merged.push({ ...entry });
  }
  return merged;
}

/** Extract system instruction (concatenated content from system messages, if any) */
export function extractSystemInstruction(messages: AgentMessage[]): { parts: Array<{ text: string }> } | undefined {
  const systems = messages.filter((m) => m.role === 'system' && m.content?.trim());
  if (!systems.length) return undefined;
  return { parts: [{ text: systems.map((m) => m.content).join('\n\n') }] };
}

function parseToolContent(content: string): unknown {
  if (!content) return {};
  // Gemini's functionResponse.response must be an OBJECT. A tool result that is
  // valid JSON but a scalar/array (a number, string, boolean, or list) 400s
  // unless wrapped — mirror the non-JSON fallback and box it as { result }.
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/**
 * Recursively sanitize a JSON Schema fragment for Gemini's strict
 * `function_declarations` validator. OpenAI tolerates minor omissions
 * (array without `items`, object without `properties`); Gemini rejects
 * the entire request with `* GenerateContentRequest.tools[0].function_declarations[N]
 * .parameters.properties[X].items: missing field`. We:
 *
 *   - inject `items: { type: 'string' }` when an `array` schema has no `items`
 *   - inject `properties: {}` when an `object` schema has no `properties`
 *   - drop JSON Schema fields Gemini doesn't recognize (`default`,
 *     `additionalProperties`) and JSON-Schema meta keywords ($schema, $id,
 *     $anchor, $dynamicAnchor, $vocabulary, $comment, $defs, definitions) —
 *     mirroring pi's sanitizeForOpenApi. `$ref` is PRESERVED (Gemini resolves
 *     refs); only the meta-declarations are stripped.
 *
 * The result is a *copy*; the input is not mutated.
 */
const JSON_SCHEMA_META_KEYS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$vocabulary',
  '$comment',
  '$defs',
  'definitions',
]);

export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeSchemaForGemini(entry));
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    // Gemini rejects unknown keywords; strip the ones we know are unsupported.
    if (k === 'default' || k === 'additionalProperties') continue;
    // Strip JSON-Schema meta-declarations (but keep $ref).
    if (JSON_SCHEMA_META_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeSchemaForGemini(pv);
      }
      out[k] = props;
      continue;
    }
    if (k === 'items') {
      out[k] = sanitizeSchemaForGemini(v);
      continue;
    }
    out[k] = sanitizeSchemaForGemini(v);
  }
  const type = out.type;
  if (type === 'array' && out.items === undefined) {
    // Best-effort default — Gemini just needs *some* shape. Most agent-facing
    // arrays in this codebase are arrays of strings or arrays of opaque
    // objects; the model still gets the param description to clarify intent.
    out.items = { type: 'string' };
  }
  if (type === 'object' && out.properties === undefined) {
    out.properties = {};
  }
  return out;
}

/** Translate OpenAI tool schema → Gemini tool schema (`functionDeclarations`) */
export function buildGeminiTools(tools: ChatCompletionTool[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((t) => {
      if (t.type !== 'function') {
        throw new Error(`Unsupported tool type for Gemini: ${t.type}`);
      }
      return {
        name: t.function.name,
        description: t.function.description,
        parameters: sanitizeSchemaForGemini(t.function.parameters) as Record<string, unknown>,
      };
    }),
  }];
}

/** Build the request body for envelope='standard' (native Gemini) */
export function buildStandardEnvelope(req: GenericGeminiRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: buildGeminiContents(req.messages),
  };

  const sys = extractSystemInstruction(req.messages);
  if (sys) body.systemInstruction = sys;

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature != null) generationConfig.temperature = req.temperature;
  if (req.maxTokens != null) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.topP != null) generationConfig.topP = req.topP;
  if (req.stopSequences?.length) generationConfig.stopSequences = req.stopSequences;
  if (req.responseMimeType) generationConfig.responseMimeType = req.responseMimeType;
  if (req.responseSchema) generationConfig.responseSchema = req.responseSchema;
  const thinkingConfig = geminiThinkingConfig(req.model, { disable: req.disableThinking });
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  if (req.tools?.length) {
    body.tools = buildGeminiTools(req.tools);
    const mode = req.toolChoice === 'required' ? 'ANY' : req.toolChoice === 'none' ? 'NONE' : 'AUTO';
    body.toolConfig = { functionCallingConfig: { mode } };
  }

  return body;
}
