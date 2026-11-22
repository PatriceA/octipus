/**
 * Healing the JSON of a view that is still streaming, for the preview
 * (docs/plans/inline-ui-views-spec.md §5): open strings, lists and objects
 * are closed, and a trailing incomplete key, literal or number is dropped
 * with its key. The result is lint-checked like any body; a preview renders
 * only when it validates, so a half-written component name simply waits for
 * the next chunk.
 */

class Invalid extends Error {}

const MAX_DEPTH = 64;
const NUMBER_RUN_RE = /[-+0-9.eE]+/y;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const LITERALS: ReadonlyArray<[string, boolean | null]> = [['true', true], ['false', false], ['null', null]];
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A value read from the prefix; `complete` is false when the text ended inside it. */
type Read = { value: unknown; complete: boolean };

class PartialParser {
  private i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++;
  }

  private get eof(): boolean { return this.i >= this.s.length; }

  /** A value, or null when the text ends before anything usable. Throws `Invalid` on a syntax error. */
  value(depth: number): Read | null {
    if (depth > MAX_DEPTH) throw new Invalid('too deep');
    this.ws();
    if (this.eof) return null;
    const ch = this.s[this.i];
    if (ch === '{') return this.object(depth);
    if (ch === '[') return this.array(depth);
    if (ch === '"') return this.string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.number();
    for (const [word, value] of LITERALS) {
      const rest = this.s.slice(this.i, this.i + word.length);
      if (rest === word) { this.i += word.length; return { value, complete: true }; }
      if (this.i + rest.length === this.s.length && word.startsWith(rest)) { this.i = this.s.length; return null; }
    }
    throw new Invalid(`unexpected ${ch}`);
  }

  private string(): Read {
    let out = '';
    this.i++;
    while (!this.eof) {
      const ch = this.s[this.i];
      if (ch === '"') { this.i++; return { value: out, complete: true }; }
      if (ch === '\\') {
        const next = this.s[this.i + 1];
        if (next === undefined) break;
        if (next === 'u') {
          const hex = this.s.slice(this.i + 2, this.i + 6);
          if (hex.length < 4 && this.i + 2 + hex.length === this.s.length) break;
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Invalid('bad escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 6;
          continue;
        }
        if (!Object.hasOwn(ESCAPES, next)) throw new Invalid('bad escape');
        out += ESCAPES[next];
        this.i += 2;
        continue;
      }
      out += ch;
      this.i++;
    }
    this.i = this.s.length;
    return { value: out, complete: false };
  }

  private number(): Read | null {
    NUMBER_RUN_RE.lastIndex = this.i;
    const run = NUMBER_RUN_RE.exec(this.s)?.[0] ?? '';
    const atEnd = this.i + run.length === this.s.length;
    const valid = NUMBER_RE.exec(run)?.[0];
    if (!atEnd && valid !== run) throw new Invalid('bad number');
    this.i += run.length;
    // At the end a number may be cut short (`12.`, `1e`): keep its valid prefix, or drop it.
    if (!valid || (atEnd && valid !== run)) return null;
    return { value: Number(valid), complete: !atEnd };
  }

  private object(depth: number): Read {
    const obj: Record<string, unknown> = {};
    this.i++;
    for (let first = true; ; first = false) {
      this.ws();
      if (this.eof) return { value: obj, complete: false };
      if (this.s[this.i] === '}' && first) { this.i++; return { value: obj, complete: true }; }
      if (this.s[this.i] !== '"') throw new Invalid('expected a key');
      const key = this.string();
      if (!key.complete) return { value: obj, complete: false };
      this.ws();
      if (this.eof) return { value: obj, complete: false };
      if (this.s[this.i] !== ':') throw new Invalid('expected :');
      this.i++;
      const read = this.value(depth + 1);
      if (!read) return { value: obj, complete: false };
      // defineProperty: a key named __proto__ stays an own property, as JSON.parse makes it.
      Object.defineProperty(obj, key.value as string, { value: read.value, enumerable: true, writable: true, configurable: true });
      if (!read.complete) return { value: obj, complete: false };
      this.ws();
      if (this.eof) return { value: obj, complete: false };
      const ch = this.s[this.i++];
      if (ch === '}') return { value: obj, complete: true };
      if (ch !== ',') throw new Invalid('expected , or }');
    }
  }

  private array(depth: number): Read {
    const list: unknown[] = [];
    this.i++;
    for (let first = true; ; first = false) {
      this.ws();
      if (this.eof) return { value: list, complete: false };
      if (this.s[this.i] === ']' && first) { this.i++; return { value: list, complete: true }; }
      const read = this.value(depth + 1);
      if (!read) return { value: list, complete: false };
      list.push(read.value);
      if (!read.complete) return { value: list, complete: false };
      this.ws();
      if (this.eof) return { value: list, complete: false };
      const ch = this.s[this.i++];
      if (ch === ']') return { value: list, complete: true };
      if (ch !== ',') throw new Invalid('expected , or ]');
    }
  }

  /** The whole text as one object; trailing text after it is a syntax error. */
  document(): Read | null {
    this.ws();
    if (this.s[this.i] !== '{') return null;
    const read = this.value(0);
    this.ws();
    if (!this.eof) throw new Invalid('text after the view');
    return read;
  }
}

/**
 * The prefix of a view's JSON made parseable, as JSON text, or null when it
 * holds nothing usable (blank, not an object, or a syntax error that more
 * text cannot fix).
 */
export function healPartialJson(text: string): string | null {
  try {
    const read = new PartialParser(text).document();
    return read ? JSON.stringify(read.value) : null;
  } catch (err) {
    // A syntax error means there is no preview yet; that is the answer, not a failure.
    if (err instanceof Invalid) return null;
    throw err;
  }
}
