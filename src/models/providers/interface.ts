import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';

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
