import { describe, expect, test } from 'vitest';
import { routeApproval } from '@/security/approval-policy';
import { matchDestructiveCommand, matchElevatedCommand } from './policy';

/**
 * A command that cannot be taken back needs a human, and a worker that cannot
 * reach one must refuse rather than proceed.
 *
 * A harness benchmark asked octipus to `rm -rf ./*` from an interactive
 * terminal. A spawned `coding` child ran it: `shell` declares `execute` as ASK,
 * but `canPromptHuman()` is true only for the root, so the child's ASK fell
 * through to `unattendedDenyActions` — which shipped empty — and auto-approved.
 * Zero approval requests were raised, and the directory was gone. The root
 * would have asked. The child it spawned did not.
 *
 * Two halves, tested separately because they fail independently: destruction
 * has to be RECOGNISED (it needs no privilege, so the elevated check never saw
 * it), and once recognised it has to be REFUSED for a caller nobody can ask.
 */

describe('recognising a command that cannot be undone', () => {
  test.each([
    ['rm -rf ./*', 'rm -r'],
    ['rm -rf node_modules', 'rm -r'],
    ['rm -r build', 'rm -r'],
    ['rm --recursive dist', 'rm -r'],
    ['shred secrets.env', 'shred'],
    ['dd if=/dev/zero of=/tmp/disk.img', 'dd of='],
    ['find . -name "*.tmp" -delete', 'find -delete'],
    ['git reset --hard HEAD~3', 'git reset --hard'],
    ['git clean -fd', 'git clean -f'],
    ['git push --force origin main', 'git push --force'],
    ['git push -f', 'git push --force'],
    ['git checkout .', 'git checkout .'],
  ])('%s is destructive', (command, expected) => {
    expect(matchDestructiveCommand(command)).toBe(expected);
  });

  test('it is found after a separator, which is where it actually appeared', () => {
    // The command that emptied the directory was exactly this shape.
    expect(matchDestructiveCommand('cd "/some/project" && rm -rf ./*')).toBe('rm -r');
    expect(matchDestructiveCommand('npm test; rm -rf dist')).toBe('rm -r');
  });

  test('quoting does not hide it', () => {
    expect(matchDestructiveCommand("rm -rf '/tmp/build'")).toBe('rm -r');
  });

  test('a wrapper does not hide it', () => {
    expect(matchDestructiveCommand('timeout 5 rm -rf dist')).toBe('rm -r');
    expect(matchDestructiveCommand('sh -c "rm -rf dist"')).toBe('rm -r');
  });
});

describe('ordinary work is not destructive', () => {
  test.each([
    'npm test',
    'ls -la',
    'rm stale.log',
    'git status',
    'git push origin main',
    'git checkout -b feature',
    'grep -r TODO src',
    'find . -name "*.ts"',
    'cat README.md',
    'python3 -m unittest discover',
  ])('%s is left alone', (command) => {
    expect(matchDestructiveCommand(command)).toBeNull();
  });

  test('a single named file is deliberately NOT on the list', () => {
    // The bar is "takes out more than it names". One file an agent just wrote,
    // in a repo, is the most common edit there is — gating it would train
    // people to approve without reading, which is worse than not asking.
    expect(matchDestructiveCommand('rm ledger.py')).toBeNull();
  });

  test('destruction and elevation are different questions', () => {
    // The whole reason this class had to exist: `rm -rf` needs no privilege,
    // so the elevated check waved it through.
    expect(matchElevatedCommand('rm -rf ./*')).toBeNull();
    expect(matchDestructiveCommand('rm -rf ./*')).toBe('rm -r');
  });
});

describe('who may actually run it', () => {
  const DENY = ['shell.execute_destructive'];

  test('the root, at a terminal, is asked', () => {
    expect(
      routeApproval({
        toolId: 'shell',
        action: 'execute_destructive',
        level: 'ASK',
        root: true,
        attended: true,
        unattendedDenyActions: DENY,
      }),
    ).toEqual({ route: 'ask_human' });
  });

  test('a spawned child is refused, not auto-approved', () => {
    const decision = routeApproval({
      toolId: 'shell',
      action: 'execute_destructive',
      level: 'ASK',
      role: 'coding',
      unattendedDenyActions: DENY,
    });
    expect(decision.route).toBe('deny');
    expect(decision.reason).toMatch(/human approval/i);
  });

  test('an ordinary command from the same child still runs', () => {
    // The fix must not stop a worker doing its job — only the undoable part.
    expect(
      routeApproval({
        toolId: 'shell',
        action: 'execute',
        level: 'ASK',
        role: 'coding',
        unattendedDenyActions: DENY,
      }),
    ).toEqual({ route: 'execute', autoApproved: true });
  });

  test('an empty deny list is what the bug looked like', () => {
    // Pinning the regression itself: with nothing listed, the same child call
    // auto-approves. This is the state that shipped.
    expect(
      routeApproval({
        toolId: 'shell',
        action: 'execute_destructive',
        level: 'ASK',
        role: 'coding',
        unattendedDenyActions: [],
      }),
    ).toEqual({ route: 'execute', autoApproved: true });
  });
});

describe('the default actually survives into the resolved config', () => {
  /**
   * The guard above is only real if it reaches a running process, and the first
   * cut of this fix did not. `legacy-loader.ts` computed
   * `(process.env.UNATTENDED_DENY_ACTIONS || '').split(',')…` unconditionally,
   * which is `[]` when the variable is unset — and `deepMerge` treats an array
   * as a scalar, so that empty array REPLACED the default instead of falling
   * back to it. A correct guard the shipping path never reaches is the bug this
   * whole change exists to fix, so it is asserted on the resolved config rather
   * than on the default literal.
   */
  test('an unset env var leaves the shipped default in place', async () => {
    const saved = process.env.UNATTENDED_DENY_ACTIONS;
    delete process.env.UNATTENDED_DENY_ACTIONS;
    try {
      const { loadFromEnvLegacy } = await import('@/config/legacy-loader');
      const { deepMerge } = await import('@/config/utils');
      const { defaultConfig } = await import('@/config/defaults');
      const merged = deepMerge(defaultConfig, loadFromEnvLegacy());
      expect(merged.multiuser?.unattendedDenyActions).toContain('shell.execute_destructive');
    } finally {
      if (saved !== undefined) process.env.UNATTENDED_DENY_ACTIONS = saved;
    }
  });

  test('an operator who sets it still wins', async () => {
    const saved = process.env.UNATTENDED_DENY_ACTIONS;
    process.env.UNATTENDED_DENY_ACTIONS = 'shell.execute';
    try {
      const { loadFromEnvLegacy } = await import('@/config/legacy-loader');
      const { deepMerge } = await import('@/config/utils');
      const { defaultConfig } = await import('@/config/defaults');
      const merged = deepMerge(defaultConfig, loadFromEnvLegacy());
      expect(merged.multiuser?.unattendedDenyActions).toEqual(['shell.execute']);
    } finally {
      if (saved === undefined) delete process.env.UNATTENDED_DENY_ACTIONS;
      else process.env.UNATTENDED_DENY_ACTIONS = saved;
    }
  });
});

describe('the other way out of the room', () => {
  /**
   * Closing the shell route is not the same as closing the door. With
   * `rm -rf` refused, an agent asked to empty a directory called
   * `filesystem__delete_file` twenty-one times instead — and got away with it,
   * because the shipped rule set contains `filesystem(*)` → allow. Rules match
   * on tool and path, never on action, so that single line outranked the
   * manifest's own `delete: ASK, dangerous: true`.
   *
   * The invariant now: a wildcard ALLOW cannot cover an action its own tool
   * declares dangerous. Deny rules are unaffected — they stay the strongest
   * thing in the system.
   */
  test('both irreversible routes are refused for a worker nobody can ask', async () => {
    const { defaultConfig } = await import('@/config/defaults');
    const deny = defaultConfig.multiuser?.unattendedDenyActions ?? [];

    for (const [toolId, action] of [
      ['shell', 'execute_destructive'],
      ['filesystem', 'delete'],
    ] as const) {
      const decision = routeApproval({
        toolId,
        action,
        level: 'ASK',
        role: 'coding',
        unattendedDenyActions: deny,
      });
      expect(decision.route, `${toolId}.${action} should be refused`).toBe('deny');
    }
  });

  test('a worker can still write and read — only the undoable part is gated', async () => {
    const { defaultConfig } = await import('@/config/defaults');
    const deny = defaultConfig.multiuser?.unattendedDenyActions ?? [];

    for (const [toolId, action] of [
      ['filesystem', 'write'],
      ['filesystem', 'read'],
      ['shell', 'execute'],
    ] as const) {
      const decision = routeApproval({
        toolId,
        action,
        level: 'ASK',
        role: 'coding',
        unattendedDenyActions: deny,
      });
      expect(decision.route, `${toolId}.${action} should still run`).toBe('execute');
    }
  });
});

describe('routes the guard used to leave open', () => {
  /**
   * Every one of these came out of an adversarial review of the first cut.
   * The pattern they share is the one the original incident demonstrated: an
   * agent refused the direct route takes the next one, so a guard is only worth
   * what its least-guarded neighbour is worth.
   */
  test.each([
    // Inline interpreter source — the head is `python3`, the destruction is in a string.
    ['python3 -c "import shutil; shutil.rmtree(\'.\')"', 'python3 inline code'],
    ['node -e "require(\'fs\').rmSync(\'.\', {recursive:true})"', 'node inline code'],
    ['perl -e "File::Path::rmtree(\'.\')"', null],
    // find -exec with something other than rm
    ['find . -exec shred {} ;', 'find -exec shred'],
    ['find . -exec unlink {} ;', 'find -exec unlink'],
    // the "make the destination match" idiom
    ['rsync -a --delete src/ dist/', 'rsync --delete'],
    // a worktree carries uncommitted work that exists nowhere else
    ['git worktree remove --force ../wt', 'git worktree remove --force'],
  ])('%s', (command, expected) => {
    const hit = matchDestructiveCommand(command);
    if (expected === null) expect(hit).not.toBe('rm -r');
    else expect(hit).toBe(expected);
  });

  test('an interpreter NOT given inline source is left alone', () => {
    expect(matchDestructiveCommand('python3 manage.py migrate')).toBeNull();
    expect(matchDestructiveCommand('node build.js')).toBeNull();
  });

  test('a read-only find that merely mentions rm is not destructive', () => {
    // Quote stripping turns the grep PATTERN into a bare `rm` token; scanning
    // the whole argv for it denied an entirely read-only search.
    expect(matchDestructiveCommand("find . -exec grep -rn 'rm ' {} ;")).toBeNull();
  });

  test('routine cleanup a build does on its own is not gated', () => {
    // A bounded glob names an extension inside a directory. Denying these
    // stranded ordinary autonomous work and taught people to wave prompts through.
    for (const command of ['rm dist/*.js', 'rm build/*.o', 'rm coverage/*.json']) {
      expect(matchDestructiveCommand(command), command).toBeNull();
    }
  });

  test('an unbounded glob still is', () => {
    for (const command of ['rm ./*', 'rm *', 'rm src/*']) {
      expect(matchDestructiveCommand(command), command).toBe('rm <glob>');
    }
  });
});

describe('the hot path stays hot', () => {
  /**
   * `base-tool` skips the permission round-trip entirely for a caller nobody
   * can ask, on the grounds that the only possible outcome is "carry on". That
   * was keyed on the deny list being EMPTY — so making the list non-empty by
   * default would have re-armed a DB round-trip for every unattended call to
   * every tool in the system, on top of the one `tool-executor` already does,
   * to guard two actions. It is keyed on the action now.
   */
  test('only the listed actions cost a check', async () => {
    const { isListedAction } = await import('@/security/approval-policy');
    const { defaultConfig } = await import('@/config/defaults');
    const deny = defaultConfig.multiuser?.unattendedDenyActions ?? [];

    expect(isListedAction(deny, 'shell', 'execute_destructive')).toBe(true);
    expect(isListedAction(deny, 'filesystem', 'delete')).toBe(true);

    for (const [toolId, action] of [
      ['filesystem', 'read'],
      ['filesystem', 'write'],
      ['filesystem', 'list'],
      ['shell', 'execute'],
      ['knowledge', 'search'],
      ['notes', 'write'],
    ] as const) {
      expect(isListedAction(deny, toolId, action), `${toolId}.${action}`).toBe(false);
    }
  });

  test('an unset list lets everything through the fast path', async () => {
    const { isListedAction } = await import('@/security/approval-policy');
    expect(isListedAction(undefined, 'shell', 'execute_destructive')).toBe(false);
    expect(isListedAction([], 'filesystem', 'delete')).toBe(false);
  });
});
