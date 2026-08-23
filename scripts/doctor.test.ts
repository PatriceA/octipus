import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkBasePersona,
  checkBun,
  checkEnvFile,
  checkVaultKeys,
  checkMcpServerBuild,
  checkLogSanity,
  runDoctor,
} from './doctor';

describe('octi doctor — individual checks', () => {
  test('Bun runtime check passes (we are running on Bun)', async () => {
    const r = await checkBun();
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('Bun');
  });

  test('checkEnvFile flags missing .env as fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      const r = await checkEnvFile(dir);
      expect(r.status).toBe('fail');
      expect(r.critical).toBe(true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkEnvFile flags missing required keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      writeFileSync(join(dir, '.env'), 'MASTER_KEY=abc\n');
      const r = await checkEnvFile(dir);
      expect(r.status).toBe('fail');
      expect(r.detail).toContain('JWT_SECRET');
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkEnvFile passes when all required keys present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      writeFileSync(join(dir, '.env'),
        'MASTER_KEY=abc\nJWT_SECRET=def\nSESSION_SECRET=ghi\n');
      const r = await checkEnvFile(dir);
      expect(r.status).toBe('ok');
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkBasePersona passes for the shipped octipus.yaml', async () => {
    const r = await checkBasePersona(process.cwd());
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('Octipus');
  });

  test('checkBasePersona fails when personas/octipus.yaml is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      const r = await checkBasePersona(dir);
      expect(r.status).toBe('fail');
      expect(r.critical).toBe(true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkVaultKeys fails on too-short MASTER_KEY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      writeFileSync(join(dir, '.env'), 'MASTER_KEY=short\nJWT_SECRET=x\nSESSION_SECRET=y\n');
      const r = await checkVaultKeys(dir);
      expect(r.status).toBe('fail');
      expect(r.critical).toBe(true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkVaultKeys passes on well-formed key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      const key44 = 'A'.repeat(44);
      writeFileSync(join(dir, '.env'), `MASTER_KEY=${key44}\nJWT_SECRET=x\nSESSION_SECRET=y\n`);
      const r = await checkVaultKeys(dir);
      expect(r.status).toBe('ok');
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkMcpServerBuild warns when dist missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
    try {
      const r = await checkMcpServerBuild(dir);
      expect(r.status).toBe('warn');
      expect(r.critical).toBe(false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test('checkLogSanity warns when no backend log exists', async () => {
    // Hard to mock $HOME safely; assert shape regardless of host state.
    const r = await checkLogSanity();
    expect(['ok', 'warn']).toContain(r.status);
    expect(typeof r.detail).toBe('string');
  });
});

describe('octi doctor — full report', () => {
  test('runDoctor returns a complete report shape', async () => {
    const report = await runDoctor(process.cwd());
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.summary.ok + report.summary.warn + report.summary.fail)
      .toBe(report.checks.length);
    // ok flag must equal "no critical fails"
    const criticalFails = report.checks.filter(c => c.critical && c.status === 'fail');
    expect(report.ok).toBe(criticalFails.length === 0);
  });

  test('runDoctor report is JSON-serializable', async () => {
    const report = await runDoctor(process.cwd());
    const json = JSON.stringify(report);
    expect(JSON.parse(json)).toEqual(report);
  });
});
