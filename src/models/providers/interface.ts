import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { DecisionAnswers, DecisionRequest } from '../decision';

/**
 * Unified model provider interface.
 * All providers (LiteLLM, direct Ollama, CLI tools) implement this.
 */
export interface ModelProvider {
  readonly name: string;
  readonly type: ProviderType;

  /** Check if this provider can handle the given model */
  supportsModel(modelName: string): boolean;

  /** Create a chat completion */
  complete(options: CompletionOptions): Promise<CompletionResult>;

  /** Create a streaming chat completion */
  stream(options: CompletionOptions): AsyncGenerator<StreamChunk>;

  /** Generate embeddings (optional — not all providers support it) */
  embed?(texts: string[], model: string, endpoint?: string): Promise<number[][]>;

  /**
   * Native document OCR (optional — only providers with a dedicated OCR
   * endpoint). Providers without this are OCR'd page-by-page via a vision model.
   */
  ocr?(document: OcrDocument, model: string): Promise<OcrResult>;

  /**
   * Image generation (optional — providers with an image endpoint). Called
   * through `generateImageWithLane` (models/image-generation.ts), never directly.
   */
  generateImage?(request: ImageGenerationRequest): Promise<ImageGenerationResult>;

  /**
   * Decision ("System One") models only: typed questions → calibrated answers.
   * Called through `decide()` in models/decision.ts, never directly.
   */
  decide?(request: DecisionRequest): Promise<DecisionAnswers>;

  /** Check provider health */
  checkHealth(): Promise<ProviderHealthStatus>;

  /** Get quota status (for subscription-based providers) */
  getQuotaStatus?(): Promise<QuotaStatus>;
}

export type ProviderType = 'litellm' | 'direct' | 'cli';

/** A document handed to a native OCR endpoint. */
export type OcrDocument =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; data: string; mimeType: string };

/**
 * Result of a native OCR call. Deliberately minimal: callers only consume the
 * page markdown. Providers may return images/bboxes/usage — we don't model
 * fields nothing reads.
 */
export interface OcrResult {
  pages: Array<{ index: number; markdown: string }>;
  model: string;
}

export interface ProviderHealthStatus {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface QuotaStatus {
  provider: string;
  hasQuota: boolean;
  /** Tokens remaining in current period, undefined if unknown */
  tokensRemaining?: number;
  /** When the quota resets */
  resetsAt?: Date;
  /** Whether the provider reported quota exhaustion */
  exhausted: boolean;
  /** Error message from last quota check */
  lastError?: string;
}

/** The shape of a requested image. */
export type ImageAspect = 'square' | 'landscape' | 'portrait';

/** One image-generation call on a model row of the Image generation lane. */
export interface ImageGenerationRequest {
  /** The provider's model id. */
  model: string;
  /** The registry row (`model_config.name`), for the row's endpoint and custom config. */
  modelConfigName: string;
  prompt: string;
  /** How many images (1–4). */
  n: number;
  aspect: ImageAspect;
  /** Images to edit or take as reference (only where the provider supports it). */
  references?: Array<{ data: Buffer; mimeType: string }>;
  /** The row's key, already resolved under the row's owner. */
  apiKey?: string;
  /** For usage scoping (a personal row's owner). */
  userId?: string;
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  images: Array<{ data: Buffer; mimeType: string }>;
  /** The prompt the provider actually used, when it rewrites prompts. */
  revisedPrompt?: string;
  /** USD the provider reported for the call (OpenRouter), when it does. */
  cost?: number;
}
