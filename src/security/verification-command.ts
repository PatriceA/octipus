import { posix } from 'node:path';
import { tokenizeSafe } from '@/tools/shell/policy';

/** A trailing CLI fallback annotation is a shell comment, never new executable syntax. */
export function withoutVerificationFallbackComment(command: string): string {
  const match = /(?:\r?\n|[ \t]+)#[ \t]*octipus-fallback:[ \t]+[^\r\n]*\S[ \t]*(?:\r?\n)?$/.exec(command);
  if (!match) return command;
  const executable = command.slice(0, match.index);
  // Fail closed for unmatched quotes and multiple lines; the fixed grammar below rejects escaping and extra executable effects.
  // The caller must still validate the complete fixed verification grammar.
  if (/[$`\u0000-\u001f\u007f]/.test(executable) || !tokenizeSafe(executable)) return command;
  return executable;
}

/** Narrow, static read-only verification identity. Never general shell equivalence. */
export function verificationCommandKey(command: string): string | undefined {
  command = withoutVerificationFallbackComment(command);
  if (/[$`\u0000-\u001f\u007f]/.test(command)) return undefined;
  // This tokenizer is not a shell parser. Consent equivalence deliberately
  // excludes escaping and control syntax; only this fixed output literal uses backslashes.
  const staticSyntax = command.replaceAll(String.raw`'\nHTTP %{http_code}\n'`, "'format'");
  if (/[\\;|<>]/.test(staticSyntax)) return undefined;
  const argv = tokenizeSafe(command);
  if (!argv) return undefined;
  if (argv[0] === 'curl') {
    if (command.includes('&')) return undefined;
    let method = 'GET'; let explicitGet = false; let url: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (['--fail', '--silent', '--show-error'].includes(arg) || /^-[fsS]+$/.test(arg)) continue;
      if (['--head', '-I'].includes(arg)) { if (explicitGet) return undefined; method = 'HEAD'; continue; }
      if (['--max-time', '--connect-timeout'].includes(arg)) {
        if (!/^[1-9][0-9]{0,2}$/.test(argv[++i] ?? '')) return undefined;
        continue;
      }
      if (['--request', '-X'].includes(arg)) {
        if (argv[++i] !== 'GET' || method === 'HEAD') return undefined;
        explicitGet = true;
        continue;
      }
      if (['--write-out', '-w'].includes(arg)) {
        if (!['%{http_code}', '\\nHTTP %{http_code}\\n'].includes(argv[++i])) return undefined;
        continue;
      }
      if (arg.startsWith('-') || url || /[{}\[\]*?]/.test(arg)) return undefined;
      try {
        const parsed = new URL(arg);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.href !== arg) return undefined;
        url = parsed.href;
      } catch { return undefined; }
    }
    return url ? JSON.stringify(['curl', method, url]) : undefined;
  }
  if (argv[0] !== 'ssh') return undefined;
  let i = 1;
  while (argv[i] === '-o') {
    const option = argv[i + 1];
    if (option !== 'BatchMode=yes' && !/^ConnectTimeout=[1-9][0-9]?$/.test(option ?? '')) return undefined;
    i += 2;
  }
  const target = argv[i++]; const remote = argv[i++];
  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target ?? '') || !remote || i !== argv.length) return undefined;
  // The profile must name the canonical default compose.yaml. Custom files
  // retain exact matching; no commands besides project status qualify.
  const explicit = /^docker +compose +-f +(\/[a-zA-Z0-9_./-]+\/compose\.yaml) +ps(?: +--format +json)?$/.exec(remote);
  const implicit = /^cd +(\/[a-zA-Z0-9_./-]+) +&& +docker +compose +ps(?: +--format +json)?$/.exec(remote);
  if (implicit && implicit[1] !== posix.normalize(implicit[1])) return undefined;
  const file = explicit?.[1] ?? (implicit ? posix.join(implicit[1], 'compose.yaml') : undefined);
  if (!file || file !== posix.normalize(file)) return undefined;
  return JSON.stringify(['ssh-compose-status', target, posix.normalize(file)]);
}

/** Only a listed verification command grants its identical read target. */
export function matchingVerificationCommand(commands: string[], requested: string): string | undefined {
  const key = verificationCommandKey(requested);
  return key ? commands.find(command => verificationCommandKey(command) === key && (tokenizeSafe(withoutVerificationFallbackComment(command))?.[0] !== 'ssh' || /^docker +compose +-f /.test(tokenizeSafe(withoutVerificationFallbackComment(command))?.at(-1) ?? ''))) : undefined;
}

/** Anchor a registered-shell shorthand to the approved file; never execute remote discovery. */
export function rewriteVerificationCommand(approved: string, requested: string): string | undefined {
  const key = verificationCommandKey(requested);
  if (!key || verificationCommandKey(approved) !== key) return undefined;
  const candidate = tokenizeSafe(withoutVerificationFallbackComment(requested))!; const original = tokenizeSafe(withoutVerificationFallbackComment(approved))!;
  if (candidate[0] !== 'ssh' || !candidate.at(-1)?.startsWith('cd ')) {
    const executable = withoutVerificationFallbackComment(requested);
    return executable !== requested ? executable : undefined;
  }
  const file = /^docker +compose +-f +(\/[a-zA-Z0-9_./-]+\/compose\.yaml) +ps(?: +--format +json)?$/.exec(original.at(-1) ?? '')?.[1];
  if (!file) return undefined;
  // All prefix words passed the SSH target/transport whitelist above.
  const remote = `docker compose -f ${file} ps${candidate.at(-1)?.endsWith('--format json') ? ' --format json' : ''}`;
  return `${candidate.slice(0, -1).join(' ')} '${remote}'`;
}

export function implicitVerificationCommand(command: string): boolean {
  command = withoutVerificationFallbackComment(command);
  return !!verificationCommandKey(command) && tokenizeSafe(command)?.[0] === 'ssh' && !!tokenizeSafe(command)?.at(-1)?.startsWith('cd ');
}
