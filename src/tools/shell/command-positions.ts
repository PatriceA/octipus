/** Quote-aware shell segments, including commands inside active substitutions.
 * Literal argument contents never become segments. Unsupported/malformed input
 * returns null so policy callers can retain their conservative fallback.
 */
export function shellCommandSegments(command: string): string[][] | null {
  let i = 0;
  function scan(stop = '', depth = 0): string[][] {
    if (depth > 24) throw new Error('Shell nesting limit');
    const segments: string[][] = [];
    let argv: string[] = [], word = '', started = false;
    let quote = '';
    const token = () => { if (started) argv.push(word); word = ''; started = false; };
    const segment = () => { token(); if (argv.length) segments.push(argv); argv = []; };
    while (i < command.length) {
      const c = command[i];
      if (!quote && stop && c === stop) { i++; segment(); return segments; }
      if (quote === "'") {
        if (c === "'") quote = ''; else word += c;
        i++; continue;
      }
      if (c === '\\' && process.platform !== 'win32') {
        if (i + 1 === command.length) throw new Error('Trailing escape');
        const next = command[i + 1];
        if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += c;
        if (next !== '\n') word += next;
        started = true; i += 2; continue;
      }
      if (c === '`' || c === '$' && command[i + 1] === '(') {
        const end = c === '`' ? '`' : ')';
        i += c === '`' ? 1 : 2;
        segments.push(...scan(end, depth + 1));
        word += '__substitution__'; started = true; continue;
      }
      if (quote === '"') {
        if (c === '"') quote = ''; else word += c;
        i++; continue;
      }
      if (c === "'" || c === '"') { quote = c; started = true; i++; continue; }
      if (c === '#' && !started) {
        while (i < command.length && command[i] !== '\n') i++;
        continue;
      }
      if (c === '(') { segment(); i++; segments.push(...scan(')', depth + 1)); continue; }
      if (/[;&|\n)]/.test(c)) { segment(); i++; continue; }
      if (/\s/.test(c)) { token(); i++; continue; }
      word += c; started = true; i++;
    }
    if (quote || stop) throw new Error('Unclosed shell syntax');
    segment();
    return segments;
  }
  try { return scan(); } catch { return null; }
}
