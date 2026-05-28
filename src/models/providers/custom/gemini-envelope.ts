/**
 * Request envelope transforms for the Gemini-compat custom provider.
 *
 * Two envelopes supported:
 *
 *   - 'standard': native Google Gemini wire format. Body shape:
 *       { contents: [{ role, parts: [{text}|{functionCall}|{functionResponse}] }],
 *         systemInstruction?, tools?, generationConfig?: { temperature, maxOutputTokens, ... } }
 *     Path:  /v1beta/models/{model}:generateContent
 *     Stream: /v1beta/models/{model}:streamGenerateContent (SSE)
 *
 *   - 'gemini-blocks-config': bespoke wrapper used by some Gemini-fronting proxies.
 *     Body shape:
 *       { mode:'text', model, messages:[{role, content:[{type:'text',text}]}], stream,
 *         config: { temperature, maxTokens, response_schema?, tools? } }
 *     Path:  '/generate' (single endpoint, stream toggled by `stream` flag)
 *
 * The transform takes a normalized "GenericRequest" and emits the wire body.
 * Response parsing is identical for both envelopes — these proxies all return
 * native Gemini response shape (`candidates[].content.parts[]`).
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
   * When true, sets thinkingConfig.thinkingBudget = 0 so Gemini 3 doesn't
   * spend output tokens on internal reasoning. Map from extraBody.think:false.
   */
  disableThinking?: boolean;
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

  return contents;
}

/** Extract system instruction (concatenated content from system messages, if any) */
export function extractSystemInstruction(messages: AgentMessage[]): { parts: Array<{ text: string }> } | undefined {
  const systems = messages.filter((m) => m.role === 'system' && m.content?.trim());
  if (!systems.length) return undefined;
  return { parts: [{ text: systems.map((m) => m.content).join('\n\n') }] };
}

function parseToolContent(content: string): unknown {
  if (!content) return {};
  try { return JSON.parse(content); } catch { return { result: content }; }
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
 *     `additionalProperties`) — silently, so existing call sites don't break
 *
 * The result is a *copy*; the input is not mutated.
 */
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
  if (req.disableThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  if (req.tools?.length) body.tools = buildGeminiTools(req.tools);

  return body;
}

/** Build the request body for envelope='gemini-blocks-config' */
export function buildBlocksConfigEnvelope(req: GenericGeminiRequest): Record<string, unknown> {
  const messages = req.messages.map((msg) => {
    if (msg.role === 'tool') {
      // Bespoke proxies typically don't accept native tool messages —
      // surface tool results as user-text blocks.
      return {
        role: 'user',
        content: [{ type: 'text', text: `[tool ${msg.name || 'result'}] ${msg.content}` }],
      };
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content && msg.content.trim()) {
        blocks.push({ type: 'text', text: msg.content });
      }
      // Encode tool calls as text — bespoke proxies don't have a standard tool-call block.
      blocks.push({
        type: 'text',
        text: msg.toolCalls.map((tc) => `[tool_call ${tc.name}(${JSON.stringify(tc.arguments)})]`).join('\n'),
      });
      return { role: 'assistant', content: blocks };
    }

    return {
      role: msg.role,
      content: [{ type: 'text', text: msg.content }],
    };
  });

  const config: Record<string, unknown> = {};
  if (req.temperature != null) config.temperature = req.temperature;
  if (req.maxTokens != null) config.maxTokens = req.maxTokens;
  if (req.topP != null) config.topP = req.topP;
  if (req.stopSequences?.length) config.stopSequences = req.stopSequences;
  if (req.responseMimeType) config.response_mime_type = req.responseMimeType;
  if (req.responseSchema) config.response_schema = req.responseSchema;
  if (req.disableThinking) config.thinkingConfig = { thinkingBudget: 0 };

  // Tools: bespoke proxies (like TPG) accept Gemini-style under config.tools
  if (req.tools?.length) {
    config.tools = req.tools.map((t) => {
      if (t.type !== 'function') {
        throw new Error(`Unsupported tool type for Gemini envelope: ${t.type}`);
      }
      return {
        name: t.function.name,
        description: t.function.description,
        parameters: sanitizeSchemaForGemini(t.function.parameters) as Record<string, unknown>,
      };
    });
  }

  return {
    mode: 'text',
    model: req.model,
    messages,
    stream: req.stream,
    config,
  };
}
