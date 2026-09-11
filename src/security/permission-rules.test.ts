import { describe, expect, test } from 'vitest';
import { DEFAULT_PERMISSION_RULES, PermissionRuleEngine } from './permission-rules';

describe('parseRule — patterns with parens in the matcher', () => {
  test('fork-bomb deny rule loads and denies the exact command', () => {
    const engine = new PermissionRuleEngine();
    engine.load({ deny: ['shell(:(){ :|:&};:)'] });
    const result = engine.evaluate('shell', 'execute', { command: ':(){ :|:&};:' });
    expect(result?.decision).toBe('deny');
  });

  test('ordinary prefix/any rules still parse alongside paren matchers', () => {
    const engine = new PermissionRuleEngine();
    engine.load({
      allow: ['shell(git:*)', 'filesystem(*)'],
      deny: ['shell(:(){ :|:&};:)'],
    });
    expect(engine.evaluate('shell', 'execute', { command: 'git status' })?.decision).toBe('allow');
    expect(engine.evaluate('filesystem', 'read', { path: '/x' })?.decision).toBe('allow');
    expect(engine.evaluate('docker', 'run')).toBeNull(); // no matching rule
  });
});

describe('default rules — relayed vendor CLI tools', () => {
  const engine = new PermissionRuleEngine();
  engine.load(DEFAULT_PERMISSION_RULES);
  test('allows read-only Claude tools and leaves mutating ones to the ASK default', () => {
    expect(engine.evaluate('cli-native:Read', 'Read', { file_path: '/etc/hosts' })?.decision).toBe('allow');
    expect(engine.evaluate('cli-native:Grep', 'Grep', { pattern: 'x' })?.decision).toBe('allow');
    expect(engine.evaluate('cli-native:Bash', 'Bash', { command: 'git status' })).toBeNull();
    expect(engine.evaluate('cli-native:Edit', 'Edit', { file_path: 'a.ts' })).toBeNull();
    expect(engine.evaluate('cli-native:Write', 'Write', { file_path: 'a.ts' })).toBeNull();
  });
});
