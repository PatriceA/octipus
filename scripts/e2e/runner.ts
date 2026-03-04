/**
 * TestRunner — drives E2E tests with assert helpers and result tracking.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export class TestRunner {
  readonly results: TestResult[] = [];

  async test(name: string, fn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    try {
      await fn();
      this.results.push({ name, passed: true, durationMs: Date.now() - start });
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${name} (${Date.now() - start}ms)\n`);
    } catch (err) {
      const error = (err as Error).message;
      this.results.push({ name, passed: false, error, durationMs: Date.now() - start });
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}: ${error}\n`);
    }
  }

  printSummary(): void {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const total = this.results.length;
    const totalTime = this.results.reduce((sum, r) => sum + r.durationMs, 0);

    console.log('\n' + '─'.repeat(60));
    console.log(`\x1b[1mResults:\x1b[0m ${passed}/${total} passed, ${failed} failed (${totalTime}ms)`);

    if (failed > 0) {
      console.log('\n\x1b[31mFailed tests:\x1b[0m');
      for (const r of this.results.filter(r => !r.passed)) {
        console.log(`  ✗ ${r.name}: ${r.error}`);
      }
    } else {
      console.log('\x1b[32m\nAll tests passed!\x1b[0m');
    }
  }

  get failed(): number {
    return this.results.filter(r => !r.passed).length;
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertStatus(actual: number, expected: number): void {
  assert(actual === expected, `Expected status ${expected}, got ${actual}`);
}
