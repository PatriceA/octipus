export interface EvalDataPoint {
  id: string;
  input: string;           // the prompt
  output: string;          // model's response
  context?: string[];      // optional RAG context
  reference?: string;      // expected/ideal answer
  model: string;
  provider: string;
  latencyMs?: number;
  // For tool accuracy evaluation
  expectedToolCall?: { name: string; args: Record<string, unknown> };
  actualToolCall?: { name: string; args: Record<string, unknown> };
  // For instruction following
  systemPrompt?: string;
  constraints?: string[];
}

export interface EvalScore {
  metric: string;          // evaluator name
  score: number;           // 0.0-1.0
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  reasoning?: string;      // why this score
}

export interface Evaluator {
  name: string;
  description: string;
  evaluate: (dataPoint: EvalDataPoint) => Promise<EvalScore>;
}

export interface EvalResult {
  dataPointId: string;
  scores: EvalScore[];
  timestamp: Date;
}

export interface EvalRun {
  id: string;
  name: string;
  model: string;
  evaluators: string[];
  results: EvalResult[];
  summary: Record<string, { mean: number; passRate: number; count: number }>;
  createdAt: Date;
}
