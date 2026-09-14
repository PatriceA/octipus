/**
 * `await import()` a module by filesystem path.
 *
 * Node's ESM loader takes a URL, not a path. On POSIX the two are close enough
 * that `import('/app/src/channels/telegram/index.ts')` works by accident; on
 * Windows `import('C:\\app\\src\\channels\\telegram\\index.ts')` parses `C:` as
 * a URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * Every drop-folder loader in the codebase — channels, capabilities, the
 * artifact toolbox, extensions, plugins — imported a path it had just built
 * with `resolve()`, and each wrapped the import in a `catch` that logs and
 * skips. So on Windows they did not fail loudly: they found nothing and
 * carried on. A backend there started with `Channels initialized
 * (auto-discovered)` in the log and not one channel registered — no Telegram,
 * Slack, Teams or WhatsApp, and no plugin or extension either.
 *
 * Their unit tests passed throughout, because under Vitest the import goes
 * through Vite's module runner, which resolves a bare absolute path happily.
 * Only the real Node loader rejects it, so the suite was green in exactly the
 * configuration the product is not run in. `tests/channels-discovery.e2e` is
 * the subprocess check that closes that gap.
 *
 * A bare specifier is passed through untouched: `pathToFileURL('lodash')`
 * would resolve it against the cwd and turn a package into a missing file.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function importModuleAt(target: string, query?: string): Promise<Record<string, unknown>> {
  if (!isAbsolute(target)) {
    return import(query ? `${target}?${query}` : target) as Promise<Record<string, unknown>>;
  }
  // `search` on the URL rather than a suffix on the path: appended to a path,
  // the `?` of a cache-buster is percent-encoded by `pathToFileURL` and becomes
  // part of the filename.
  const url = pathToFileURL(target);
  if (query) url.search = query;
  return import(url.href) as Promise<Record<string, unknown>>;
}
