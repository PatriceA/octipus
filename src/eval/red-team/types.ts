import type { Assertion, AssertionType, EvalTest } from '../types';

export type AttackCategory = 'injection' | 'confusion' | 'misuse' | 'leakage' | 'drift';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface RedTeamPlugin {
  name: string;
  description: string;
  category: AttackCategory;
  /** Generate attack test cases */
  generateTests(config?: RedTeamConfig): RedTeamTest[];
}

export interface RedTeamConfig {
  /** Number of variants to generate per attack type */
  variants?: number;
  /** Severity levels to include */
  severity?: Severity[];
}

export type RedTeamAssertionType =
  | 'not_contains'
  | 'classification'
  | 'routes_to_role'
  | 'defense_held';

export interface RedTeamAssertion extends Assertion {
  type: RedTeamAssertionType | AssertionType | string;
  value?: string | string[] | number;
}

export interface RedTeamTest extends EvalTest {
  plugin: string;
  severity: Severity;
  /** What the system should NOT do */
  expectedDefense: string;
  assertions: RedTeamAssertion[];
}
