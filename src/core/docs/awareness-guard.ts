/**
 * The wire format of a `y-protocols` awareness update, read and written by
 * the document hub so it can own the awareness of a live note
 * (docs/plans/coworking-spec.md §7.3): which client ids a connection may
 * announce, and who the states say they are.
 *
 * An update is `varUint(count)` then, per client, `varUint(clientId)`,
 * `varUint(clock)` and `varString(JSON state)` (lib0 encoding: 7 bits per
 * byte, low first, high bit set on every byte but the last; a string is its
 * UTF-8 byte length then the bytes). `null` is a removed state.
 */

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  varUint(): number {
    let num = 0;
    let mult = 1;
    for (;;) {
      const byte = this.bytes[this.pos++];
      if (byte === undefined) throw new Error('awareness update ends inside a number');
      num += (byte & 0x7f) * mult;
      if (byte < 0x80) return num;
      mult *= 128;
      if (num > Number.MAX_SAFE_INTEGER) throw new Error('awareness update carries a number past 2^53');
    }
  }

  varString(): string {
    const length = this.varUint();
    if (this.pos + length > this.bytes.length) throw new Error('awareness update ends inside a string');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }

  get done(): boolean {
    return this.pos === this.bytes.length;
  }
}

/** The entries of an awareness update. Throws on a malformed update (or a state that is not an object or null). */
export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const reader = new Reader(update);
  const count = reader.varUint();
  const entries: AwarenessEntry[] = [];
  for (let i = 0; i < count; i++) {
    const clientId = reader.varUint();
    const clock = reader.varUint();
    const state: unknown = JSON.parse(reader.varString());
    if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
      throw new Error('awareness state is neither an object nor null');
    }
    entries.push({ clientId, clock, state: state as Record<string, unknown> | null });
  }
  if (!reader.done) throw new Error('awareness update has trailing bytes');
  return entries;
}

function writeVarUint(out: number[], value: number): void {
  let num = value;
  while (num > 0x7f) {
    out.push(0x80 | (num % 128));
    num = Math.floor(num / 128);
  }
  out.push(num);
}

/** Encode entries as an awareness update `applyAwarenessUpdate` reads. */
export function encodeAwarenessUpdate(entries: AwarenessEntry[]): Uint8Array {
  const out: number[] = [];
  writeVarUint(out, entries.length);
  const encoder = new TextEncoder();
  for (const entry of entries) {
    writeVarUint(out, entry.clientId);
    writeVarUint(out, entry.clock);
    const bytes = encoder.encode(JSON.stringify(entry.state));
    writeVarUint(out, bytes.length);
    for (const byte of bytes) out.push(byte);
  }
  return Uint8Array.from(out);
}
