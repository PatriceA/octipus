/**
 * Pseudonymization on the way to remote models (docs/PROTECTION-LEVELS.md,
 * C6c). Names, addresses, IBANs, phone numbers, e-mail addresses, dates of
 * birth and identifiers (customer, patient, insurance numbers) are replaced
 * by stable placeholders (`[PERSON_1]`, `[IBAN_1]`) before a request leaves,
 * and the placeholders in the answer are translated back before anyone sees
 * it. Each session keeps its own mapping, so a name is the same placeholder
 * in every message of the conversation.
 *
 * The detector is pattern-based and tuned to German formats. It errs on the
 * side of replacing: a word taken for a surname costs some answer quality, a
 * name missed leaves the house.
 */
import { GERMAN_FIRST_NAMES } from './german-names';

export type PseudonymKind = 'PERSON' | 'EMAIL' | 'PHONE' | 'IBAN' | 'ADDRESS' | 'PLACE' | 'DATE' | 'ID';

const KINDS: readonly PseudonymKind[] = ['PERSON', 'EMAIL', 'PHONE', 'IBAN', 'ADDRESS', 'PLACE', 'DATE', 'ID'];
const TOKEN_RE = new RegExp(`\\[(${KINDS.join('|')})_(\\d+)\\]`, 'g');

interface Span { start: number; end: number; kind: PseudonymKind; value: string }

const UPPER = 'A-ZÄÖÜ';
const LOWER = 'a-zäöüß';
const WORD = `[${UPPER}][${LOWER}]+`;
/** A name word: capitalised, optionally double-barrelled (Hans-Peter, Müller-Lüdenscheidt). */
const NAME = `${WORD}(?:-${WORD})?`;

/** Mod-97 check of an IBAN (ISO 13616). */
export function validIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('DE') && iban.length !== 22) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** Words after a postcode that are not a place ("12345 Euro"). */
const NOT_A_PLACE = new Set(['euro', 'eur', 'stück', 'mal', 'tage', 'jahre', 'monate', 'kunden', 'einheiten', 'seiten', 'zeichen', 'punkte', 'mitarbeiter']);
/** Capitalised words after a first name that are not a surname ("Anna Am Montag"). */
const NOT_A_SURNAME = new Set(['am', 'im', 'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'hat', 'ist', 'war', 'wird', 'sagt', 'schreibt', 'mit', 'von', 'für', 'aus', 'bei', 'nach', 'zum', 'zur', 'the', 'and']);

interface Detector { kind: PseudonymKind; re: RegExp; group?: number; accept?: (value: string, match: RegExpExecArray) => boolean }

const DETECTORS: readonly Detector[] = [
  { kind: 'EMAIL', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, accept: (v) => validIban(v) },
  // Identifiers behind their label: Kundennummer 4711-23, Vers.-Nr.: A123456789, Az. 3 O 123/24.
  // Case-sensitive: a lower-case word after the number ("4711-23 bitte") is not part of it.
  {
    kind: 'ID',
    re: /\b(?:Kunden(?:nummer|-?Nr\.?)|Kd\.?-?Nr\.?|Patienten(?:nummer|-?ID|-?Nr\.?)|Pat\.?-?Nr\.?|Versicherten(?:nummer|-?Nr\.?)|Versicherungs(?:nummer|-?Nr\.?)|Vers\.?-?Nr\.?|Mitglieds(?:nummer|-?Nr\.?)|Akten(?:zeichen|-?Nr\.?)|Az\.|Steuer-?(?:ID|Nr\.?|nummer|Identifikationsnummer)|Personalnummer|Vertragsnummer|[Cc]ustomer (?:ID|[Nn]o\.?|number)|[Pp]atient (?:ID|[Nn]o\.?))\s*[:#]?\s*([A-Z0-9][A-Z0-9./-]*(?: (?:[A-Z]|[A-Z0-9]*\d[A-Z0-9./-]*)){0,3})/g,
    group: 1,
    accept: (v) => /\d/.test(v) && v.length >= 3,
  },
  // Krankenversichertennummer: a letter and nine digits.
  { kind: 'ID', re: /\b[A-Z]\d{9}\b/g },
  // A date behind a birth label: geb. 03.04.1981, Geburtsdatum: 3.4.81.
  {
    kind: 'DATE',
    re: /\b(?:geb\.|geboren(?: am)?|Geburtsdatum|Geb\.-?Datum|date of birth|DOB|born(?: on)?)\s*:?\s*(\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)?\d{2})/gi,
    group: 1,
  },
  // Phone numbers: +49 / 0049 / a leading 0, at least seven digits.
  {
    kind: 'PHONE',
    re: /(?<![\w+])(?:\+|00)\d{1,3}[\s/-]?(?:\(0\)[\s/-]?)?\d{2,5}(?:[\s/-]?\d{2,8}){1,3}\b|(?<![\w.,])0[1-9]\d{1,4}[\s/-]\d{3,8}(?:[\s-]\d{1,5})?\b/g,
    accept: (v) => v.replace(/\D/g, '').length >= 7,
  },
  // Street and number: Musterstraße 12, Hauptstr. 5a, Am Markt 3.
  {
    kind: 'ADDRESS',
    re: new RegExp(`\\b(?:${WORD}(?:[- ]${WORD})* (?:Straße|Strasse|Str\\.|Weg|Gasse|Platz|Allee|Ring|Damm|Ufer|Chaussee|Steig|Pfad)|${WORD}(?:[- ]${WORD})*(?:straße|strasse|str\\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|stieg)|(?:${WORD}(?:straße|strasse|str\\.|weg|gasse|platz|allee))|(?:Am|An der|Im|In der|Zum|Zur|Auf dem|Hinter der) ${WORD})\\s\\d{1,4}\\s?[a-zA-Z]?\\b`, 'gu'),
  },
  // Postcode and place: 10115 Berlin, 80331 München-Schwabing.
  {
    kind: 'PLACE',
    re: new RegExp(`\\b(?:0[1-9]|[1-9]\\d)\\d{3}\\s${NAME}(?:\\s(?:an der|am|im)\\s${NAME})?`, 'gu'),
    accept: (v) => !NOT_A_PLACE.has(v.split(/\s+/)[1]?.toLowerCase() ?? ''),
  },
  // A title and a name: Herr Müller, Frau Dr. Anna Schmidt, Prof. Weber.
  {
    kind: 'PERSON',
    re: new RegExp(`\\b(?:Herrn?|Frau|Hr\\.|Fr\\.|Dr\\.|Prof\\.|Mr\\.?|Mrs\\.?|Ms\\.?)\\s+(?:(?:Dr\\.|Prof\\.)\\s+)*(${NAME}(?:\\s${NAME})?)`, 'gu'),
    group: 1,
    accept: (v) => !NOT_A_SURNAME.has(v.split(/\s+/)[0].toLowerCase()),
  },
  // A known first name and a surname: Anna Müller, Hans-Peter Schmidt.
  {
    kind: 'PERSON',
    re: new RegExp(`\\b(${NAME})\\s(${NAME})\\b`, 'gu'),
    accept: (_v, m) => GERMAN_FIRST_NAMES.has(m[1].split('-')[0].toLowerCase()) && !NOT_A_SURNAME.has(m[2].toLowerCase()),
  },
];

/** The personal data spans of `text`, non-overlapping, earlier detectors first. */
export function detect(text: string): Span[] {
  const spans: Span[] = [];
  const overlaps = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start);
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(text); m; m = d.re.exec(text)) {
      const value = (d.group ? m[d.group] : m[0])?.trim();
      if (!value) continue;
      const start = m.index + m[0].lastIndexOf(value);
      const end = start + value.length;
      if (d.accept && !d.accept(value, m)) { d.re.lastIndex = m.index + 1; continue; }
      if (!overlaps(start, end)) spans.push({ start, end, kind: d.kind, value });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A mapping between personal data and placeholders. One per session, so a
 * value keeps its placeholder across the conversation.
 */
export class Pseudonyms {
  private readonly byValue = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly counts = new Map<PseudonymKind, number>();
  private matcher: RegExp | null = null;

  get size(): number { return this.byValue.size; }

  private register(kind: PseudonymKind, value: string): void {
    if (this.byValue.has(value)) return;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const token = `[${kind}_${n}]`;
    this.byValue.set(value, token);
    this.byToken.set(token, value);
    this.matcher = null;
    // A person's surname alone stands for the same person ("Frau Schmidt" … "Schmidt").
    if (kind === 'PERSON') {
      const parts = value.split(/\s+/);
      const last = parts[parts.length - 1];
      if (parts.length > 1 && last.length > 2 && !this.byValue.has(last)) this.byValue.set(last, token);
    }
  }

  /** `text` with every known and every newly detected value replaced by its placeholder. */
  pseudonymize(text: string): string {
    if (!text) return text;
    for (const span of detect(text)) this.register(span.kind, span.value);
    if (this.byValue.size === 0) return text;
    if (!this.matcher) {
      const values = [...this.byValue.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
      this.matcher = new RegExp(`(?<![\\p{L}\\p{N}@.])(?:${values.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
    }
    this.matcher.lastIndex = 0;
    return text.replace(this.matcher, (v) => this.byValue.get(v) ?? v);
  }

  /** `text` with its placeholders translated back; unknown ones stay as they are. */
  restore(text: string): string {
    if (!text || this.byToken.size === 0) return text;
    TOKEN_RE.lastIndex = 0;
    return text.replace(TOKEN_RE, (token) => this.byToken.get(token) ?? token);
  }

  /** Every string in `value` (an object, an array, a string) translated back. */
  restoreDeep<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v)) as T;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restoreDeep(v)])) as T;
    }
    return value;
  }

  /** Every string in `value` pseudonymized. */
  pseudonymizeDeep<T>(value: T): T {
    if (typeof value === 'string') return this.pseudonymize(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.pseudonymizeDeep(v)) as T;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.pseudonymizeDeep(v)])) as T;
    }
    return value;
  }
}

/**
 * Translates a streamed text back. A placeholder can be split across two
 * chunks (`[PER` + `SON_1]`): text from an unclosed `[` near the end is held
 * until the next chunk, or `flush`.
 */
export class StreamRestorer {
  private held = '';
  constructor(private readonly pseudonyms: Pseudonyms) {}

  push(chunk: string): string {
    const text = this.held + chunk;
    const open = text.lastIndexOf('[');
    if (open >= 0 && !text.includes(']', open) && text.length - open <= 16) {
      this.held = text.slice(open);
      return this.pseudonyms.restore(text.slice(0, open));
    }
    this.held = '';
    return this.pseudonyms.restore(text);
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return this.pseudonyms.restore(rest);
  }
}

// ── Per-session mappings ────────────────────────────────────────────────────

const MAX_SESSIONS = 2_000;
const sessions = new Map<string, Pseudonyms>();

/** The session's mapping (a fresh one for work outside a session). */
export function pseudonymsOf(sessionId: string | undefined): Pseudonyms {
  if (!sessionId) return new Pseudonyms();
  const found = sessions.get(sessionId);
  if (found) {
    sessions.delete(sessionId); // LRU order
    sessions.set(sessionId, found);
    return found;
  }
  const created = new Pseudonyms();
  sessions.set(sessionId, created);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return created;
}

/** Test seam. */
export function resetPseudonyms(): void {
  sessions.clear();
}
