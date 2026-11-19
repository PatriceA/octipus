import { expect, test } from 'vitest';
import { applySessionCliSettings, configuredCliEffort } from './session-cli-settings';
import { CLIArgumentBuilder } from '@/core/cli-adapters';
const scope = { modelName: 'my-codex', topic: 'build', role: 'coding', adapter: 'Codex CLI' };
test('defaults and other sessions/topics/roles stay unchanged', () => {
  const base = { model: 'configured-model', permissionMode: 'read-only', extraArgs: ['--strict-config'] };
  expect(applySessionCliSettings(base, [], scope)).toEqual(base);
  expect(
    applySessionCliSettings(base, [{ modelName: scope.modelName, topic: 'verify', model: 'different' }], scope),
  ).toEqual(base);
  expect(
    applySessionCliSettings(
      base,
      [{ modelName: scope.modelName, topic: 'build', role: 'review', model: 'different' }],
      scope,
    ),
  ).toEqual(base);
  expect(base).toEqual({ model: 'configured-model', permissionMode: 'read-only', extraArgs: ['--strict-config'] });
});
test('role overrides win without mutating global settings or permission controls', () => {
  const base = { model: 'configured-model', permissionMode: 'read-only', extraArgs: [] };
  const entries = [
    { modelName: scope.modelName, topic: scope.topic, model: 'topic-model' },
    { modelName: scope.modelName, topic: scope.topic, role: scope.role, model: 'role-model', effort: 'high' },
  ];
  expect(applySessionCliSettings(base, entries, scope)).toMatchObject({
    model: 'role-model',
    effort: 'high',
    sessionModelOverride: true,
    permissionMode: 'read-only',
  });
  expect(base.model).toBe('configured-model');
});
test('unsupported effort and unsafe model identifiers fail before a subprocess starts', () => {
  expect(() => applySessionCliSettings({}, [{ ...scope, model: 'x"\n-evil' }], scope)).toThrow(/identifier/);
  expect(() => applySessionCliSettings({}, [{ ...scope, effort: 'invented' }], scope)).toThrow(/not supported/);
});
test('Codex session choices override workstation defaults and reach typed CLI flags', () => {
  const before = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = 'workstation-model';
  try {
    const settings = applySessionCliSettings({}, [{ ...scope, model: 'chosen-model', effort: 'xhigh' }], scope);
    const built = new CLIArgumentBuilder().build('Codex CLI', 'hello', settings, []);
    expect(built.args).toContain('model="chosen-model"');
    expect(built.args).toContain('model_reasoning_effort="xhigh"');
  } finally {
    if (before === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = before;
  }
});
test('Claude effort replaces a configured additive flag instead of duplicating it', () => {
  const settings = applySessionCliSettings(
    { extraArgs: ['--effort', 'low', '--no-chrome'] },
    [{ ...scope, effort: 'high' }],
    { ...scope, adapter: 'Claude Code' },
  );
  expect(settings.extraArgs).toEqual(['--no-chrome']);
  const built = new CLIArgumentBuilder().build('Claude Code', 'hello', settings, []);
  expect(built.args).toContain('--effort');
  expect(built.args[built.args.indexOf('--effort') + 1]).toBe('high');
});

test('agent-specific effort inherits a topic-wide model choice', () => {
  const settings = applySessionCliSettings(
    {},
    [
      { modelName: scope.modelName, topic: scope.topic, model: 'topic-model' },
      { modelName: scope.modelName, topic: scope.topic, role: 'coding', effort: 'high' },
    ],
    scope,
  );
  expect(settings).toMatchObject({ model: 'topic-model', effort: 'high' });
});

test('the inspector can describe configured effort without adding duplicate flags', () => {
  const base = { extraArgs: ['--effort=low', '--effort', 'high'] };
  expect(configuredCliEffort(base, 'Claude Code')).toBe('high');
  expect(base.extraArgs).toEqual(['--effort=low', '--effort', 'high']);
  expect(configuredCliEffort({ extraArgs: ['--reasoning-effort', 'xhigh'] }, 'Muse Code')).toBe('xhigh');
});
