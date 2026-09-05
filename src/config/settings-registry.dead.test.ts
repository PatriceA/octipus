import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { SETTINGS_REGISTRY, settingKeyToConfigPath } from './settings-registry';

/**
 * Every setting on the Settings page must actually do something.
 *
 * A QA pass found six root agent settings — `enabled`, `defaultModel`,
 * `piiFilterEnabled`, `maxPipelineStages`, `approvalTimeoutMs`,
 * `workerTimeoutMs` — declared in the schema, listed in the registry, rendered
 * as editable fields, persisted on save, and read by nothing. The operator had
 * set `workerTimeoutMs` to 100 minutes; workers were bounded by
 * `swarm.levelDefaults.*.wallMs` the whole time. A control that changes nothing
 * is worse than a missing one: it answers a question wrongly.
 *
 * The check is a source scan, deliberately loose about HOW a setting is read
 * (`cfg.api.port`, a destructure, a string key) and strict about WHETHER it is
 * read anywhere outside the config layer that declares it.
 *
 * Adding a setting means wiring it. If this fails on a key you just added,
 * the fix is to consume it — not to widen the allowlist.
 */

/** The files that merely DECLARE settings; a mention here is not a reader. */
const DECLARATION_ONLY =
  /src\/config\/(schema|defaults|legacy-loader|settings-registry|settings-registry\.dead\.test)\.ts/;

const SEARCH_ROOTS = ['src', 'scripts', 'web/app', 'web/components', 'web/lib'];

/** Lines outside the config layer matching `pattern` (an extended regex). */
function grepLines(pattern: string): string[] {
  let out = '';
  try {
    out = execFileSync(
      'grep',
      ['-rnE', '--include=*.ts', '--include=*.tsx', pattern, ...SEARCH_ROOTS],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // grep exits 1 when nothing matches
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => !DECLARATION_ONLY.test(line))
    .filter((line) => !line.includes('/node_modules/'));
}

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this setting read anywhere?
 *
 * Three signals, because config is read three ways in this codebase and no
 * single pattern sees all of them:
 *
 *  1. **Parent-qualified** — `cfg.agent.promptTier`, `runtimePartial.n8n?.url`.
 *     Optional chaining allowed.
 *  2. **Env var** — `process.env.AGENT_PROMPT_TIER`.
 *  3. **Leaf near its section** — the read went through a renamed local
 *     (`n8nConfig.apiKey`, `defaults.wallMs`), so the leaf is matched only when
 *     the line, or the path of the file it is in, also names the setting's
 *     section. That is what stops `ollama.defaultModel`'s readers from vouching
 *     for `agent.defaultModel`, which is precisely how the leaf-only
 *     version of this check would have passed two of the dead keys it exists to
 *     catch.
 *
 * Known limit: a leaf as generic as `enabled`, inside a file whose path already
 * names the section, can still be vouched for by an unrelated mention. Signal 3
 * is a floor, not a proof.
 */
function isRead(key: string, envVar?: string): boolean {
  const path = settingKeyToConfigPath(key);
  const leaf = path.at(-1) as string;
  const parent = path.length > 1 ? (path.at(-2) as string) : undefined;
  const section = path[0] as string;

  if (parent && grepLines(`${esc(parent)}\\??\\.${esc(leaf)}`).length > 0) return true;
  if (envVar && grepLines(esc(envVar)).length > 0) return true;

  const sectionRe = new RegExp(esc(section), 'i');
  return grepLines(`\\b${esc(leaf)}\\b`).some((line) => {
    const [file] = line.split(':', 1);
    return sectionRe.test(line) || sectionRe.test(file ?? '');
  });
}

describe('no setting is declared without a consumer', () => {
  test('every registry key is read somewhere outside the config layer', () => {
    const dead: string[] = [];

    for (const def of SETTINGS_REGISTRY) {
      if (!isRead(def.key, def.envVar)) dead.push(def.key);
    }

    expect(dead, `settings with no reader — wire them or delete them:\n  ${dead.join('\n  ')}`).toEqual([]);
  });
});
