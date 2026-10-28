/** Quote-aware shell segments, including commands inside active substitutions.
 * Literal argument and here-document contents never become command segments.
 * Unsupported/malformed input returns null for a conservative policy fallback.
 */
export function shellCommandSegments(command: string, executableHeredoc?: (pipeline: string[][]) => boolean): string[][] | null {
  let i = 0;
  function scan(stop = '', depth = 0): string[][] {
    if (depth > 24) throw new Error('Shell nesting limit');
    const segments: string[][] = [];
    let argv: string[] = [], word = '', started = false, quoted = false;
    let quote = '';
    let pipeline = 0;
    const commands: Array<{ argv: string[]; pipeline: number }> = [];
    let redirect: { heredoc: boolean; stripTabs: boolean; hereString: boolean } | undefined;
    const strings: Array<{ body: string; pipeline: number }> = [];
    const documents: Array<{ delimiter: string; quoted: boolean; stripTabs: boolean; pipeline: number }> = [];
    const token = () => {
      if (!started) return;
      if (redirect?.hereString) strings.push({ body: word, pipeline });
      else if (redirect?.heredoc) documents.push({ delimiter: word, quoted, stripTabs: redirect.stripTabs, pipeline });
      else if (!redirect) argv.push(word);
      word = ''; started = false; quoted = false; redirect = undefined;
    };
    const segment = () => { token(); if (redirect) throw new Error('Missing redirection target'); if (argv.length) { segments.push(argv); commands.push({ argv, pipeline }); } argv = []; };
    const hereStrings = () => {
      for (const source of strings.splice(0)) {
        if (executableHeredoc?.(commands.filter(entry => entry.pipeline === source.pipeline).map(entry => entry.argv))) segments.push(['sh', '-c', source.body]);
      }
    };
    const heredocs = () => {
      for (const document of documents.splice(0)) {
        const start = i;
        let end = command.length, after = end;
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i);
          const next = lineEnd < 0 ? command.length : lineEnd;
          const line = command.slice(i, next);
          if ((document.stripTabs ? line.replace(/^\t+/, '') : line) === document.delimiter) {
            end = i; after = lineEnd < 0 ? next : next + 1; break;
          }
          i = lineEnd < 0 ? next : next + 1;
        }
        if (executableHeredoc?.(commands.filter(entry => entry.pipeline === document.pipeline).map(entry => entry.argv))) {
          // stdin to a shell (including cat | sh) is executable source even
          // when the outer delimiter was quoted. Recurse through policy's
          // ordinary bounded shell-command-string path.
          segments.push(['sh', '-c', command.slice(start, end)]);
        }
        // Unquoted heredocs expand substitutions; quotes INSIDE their body are
        // literal, so don't parse the body as ordinary shell source.
        if (!document.quoted) {
          i = start;
          while (i < end) {
            const c = command[i];
            if (c === '\\' && ['$', '`', '\\', '\n'].includes(command[i + 1])) { i += 2; continue; }
            if (c === '`' || c === '$' && command[i + 1] === '(') {
              i += c === '`' ? 1 : 2;
              segments.push(...scan(c === '`' ? '`' : ')', depth + 1));
            } else i++;
          }
        }
        i = after;
      }
    };
    while (i < command.length) {
      const c = command[i];
      if (!quote && stop && c === stop) { i++; segment(); hereStrings(); return segments; }
      if (quote === "'") { if (c === "'") quote = ''; else word += c; i++; continue; }
      if (c === '\\' && process.platform !== 'win32') {
        if (i + 1 === command.length) throw new Error('Trailing escape');
        const next = command[i + 1];
        if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += c;
        if (next !== '\n') { word += next; started = true; quoted = true; }
        i += 2; continue;
      }
      if (c === '`' || c === '$' && command[i + 1] === '(') {
        const end = c === '`' ? '`' : ')';
        i += c === '`' ? 1 : 2;
        segments.push(...scan(end, depth + 1));
        word += '__substitution__'; started = true; continue;
      }
      if (quote === '"') { if (c === '"') quote = ''; else word += c; i++; continue; }
      if (c === "'" || c === '"') { quote = c; started = true; quoted = true; i++; continue; }
      if (c === '#' && !started) { while (i < command.length && command[i] !== '\n') i++; continue; }
      if (c === '<' || c === '>') {
        // A numeric prefix belongs to the redirect, not argv: 2>&1 cmd.
        if (started && !quoted && /^(?:\d+|\{[a-z_][a-z0-9_]*\})$/i.test(word)) { word = ''; started = false; }
        else token();
        if (redirect) throw new Error('Missing redirection target');
        i++;
        const heredoc = c === '<' && command[i] === '<';
        if (command[i] === c) i++;
        const hereString = heredoc && command[i] === '<';
        if (hereString || ['&', '|'].includes(command[i])) i++;
        const stripTabs = heredoc && command[i] === '-';
        if (stripTabs) i++;
        redirect = { heredoc: heredoc && !hereString, stripTabs, hereString };
        continue;
      }
      if ((c === '{' || c === '}') && !started && (i + 1 === command.length || /[\s;]/.test(command[i + 1]))) { segment(); i++; continue; }
      if (c === '(') { segment(); i++; segments.push(...scan(')', depth + 1)); continue; }
      if (/[;&|\n)]/.test(c)) {
        segment();
        const booleanPipe = c === '|' && command[i + 1] === '|';
        const stderrPipe = c === '|' && command[i + 1] === '&';
        i += booleanPipe || stderrPipe ? 2 : 1;
        if (c === '\n') heredocs();
        if (c !== '|' || booleanPipe) pipeline++;
        continue;
      }
      if (/\s/.test(c)) { token(); i++; continue; }
      word += c; started = true; i++;
    }
    if (quote || stop) throw new Error('Unclosed shell syntax');
    segment();
    hereStrings();
    return segments;
  }
  try { return scan(); } catch { return null; }
}
