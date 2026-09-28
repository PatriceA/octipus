/** Public learning-check receipt; raw execution evidence stays on the server. */
export interface LearningCheckView {
  id: string;
  title: string;
  status: string;
  stage: string | null;
  error: string | null;
  createdAt: string;
  result: { reason?: string; outputs?: Array<{ kind: string; status: string; id?: string; detail?: string }> } | null;
}
