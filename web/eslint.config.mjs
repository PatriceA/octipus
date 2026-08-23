import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The gate this config exists for is the React Compiler's hook rules — the
 * previous framework preset carried them, and clearing the forty-one errors
 * they found was a deliberate piece of work. Keep them; the rest of the preset
 * was framework-specific (`next/image`, `next/link`, page conventions) and has
 * nothing left to check.
 */
export default [
  {
    // `public/` holds the artifact SDK — a generated bundle and its plain-JS
    // source, neither of which is application code.
    ignores: ['dist/', 'out/', 'node_modules/', 'src-tauri/', 'public/', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Off, not tuned: the previous preset never reported these, so switching
      // them on here would mix a new rule class into a framework migration.
      // Every react-hooks rule keeps its own default level, which is what the
      // `--max-warnings 0` in the lint script is guarding.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
