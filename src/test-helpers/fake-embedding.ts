/**
 * A deterministic stand-in for an embedding model, for suites that need the
 * vector leg of a search without a model: hashed bag-of-words vectors.
 *
 * Two texts are as similar as the words they share: the cosine of two texts
 * with word sets A and B (no repeats) is about |A ∩ B| / √(|A|·|B|). Short
 * and common words are left out, and a word counts by its first five letters
 * ("charges" is "charge"). It knows no synonyms: a suite that wants a
 * paraphrase to match says which words mean the same with `aliases`, which
 * keeps what is being tested visible in the test.
 *
 * Usage:
 *   const embed = fakeEmbedder({ aliases: { cost: 'price', charge: 'price' } });
 *   vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockImplementation(async (t) => embed(t));
 *   INSERT … embedding = vectorLiteral(embed(content))
 */

/** Wide enough that a handful of words rarely collide. */
export const FAKE_EMBEDDING_DIMENSION = 512;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'who', 'how', 'why', 'when', 'where', 'which', 'with', 'this',
  'that', 'from', 'have', 'has', 'had', 'our', 'your', 'you', 'they', 'them', 'their', 'there', 'about', 'can', 'could',
  'would', 'should', 'does', 'did', 'not', 'but', 'all', 'any', 'into', 'out', 'over', 'its', 'his', 'her', 'she',
  'him', 'per', 'also', 'just', 'than', 'then', 'some', 'tell', 'please',
]);

export interface FakeEmbedderOptions {
  /** Words (lower case) that stand for the same thing: each is replaced by its value before hashing. */
  aliases?: Record<string, string>;
  dimension?: number;
}

/** The words a text is embedded on, after aliases and the five-letter stem. */
export function fakeEmbeddingTerms(text: string, options: FakeEmbedderOptions = {}): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const concept = options.aliases?.[word] ?? word;
    out.add(concept.slice(0, 5));
  }
  return [...out];
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** An embedding function over `options`. A text with no counted word gets a fixed vector of its own. */
export function fakeEmbedder(options: FakeEmbedderOptions = {}): (text: string) => number[] {
  const dimension = options.dimension ?? FAKE_EMBEDDING_DIMENSION;
  return (text: string) => {
    const vector = new Array<number>(dimension).fill(0);
    const terms = fakeEmbeddingTerms(text, options);
    for (const term of terms.length ? terms : ['\u0000empty']) vector[fnv1a(term) % dimension] += 1;
    const norm = Math.sqrt(vector.reduce((n, x) => n + x * x, 0));
    return vector.map((x) => x / norm);
  };
}

/** Cosine similarity of two vectors (for asserting what the stand-in gives). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** pgvector's text form of a vector, for an INSERT. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
