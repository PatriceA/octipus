/**
 * Load `.md` as a string module.
 *
 * The role prompts live beside their config as markdown and are imported, so
 * the bundler inlines them and the shipped artifact carries its prompts. That
 * works for the bundle (esbuild's text loader) and the test runner (a Vite
 * plugin); Node itself needs telling, which is what this does.
 *
 * Registered via `--import` on every script that boots product code. There is
 * a test that every such script carries the flag, because forgetting it means
 * the entry point cannot start at all.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.split('?')[0].endsWith('.md')) {
      return nextLoad(url, context);
    }
    const text = readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  },
});
