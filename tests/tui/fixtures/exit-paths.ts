/**
 * Starts the shared terminal runtime, draws one row, then leaves by the exit
 * path named on the command line. Test-only: the runtime itself has no way
 * to be told to crash.
 */
import { createRuntime } from '../../../src/tui-pi/runtime';

const path = process.argv.at(-1);
const runtime = createRuntime({ title: 'exit paths', screen: process.argv.includes('--inline') ? 'inline' : 'alt', mouse: 'app' });
runtime.tui.addChild({ render: () => ['exit-path fixture ready'], invalidate() {} });
runtime.tui.start();
// Registered after the runtime's own handlers, so it runs after the restore.
process.on('exit', () => { process.stdout.write(`\nraw-after-exit:${process.stdin.isRaw}\n`); });

setTimeout(() => {
  if (path === 'throw') throw new Error('fixture exception');
  if (path === 'reject') void Promise.reject(new Error('fixture rejection'));
  if (path === 'exit') process.exit(3);
  if (path === 'hangup') process.kill(process.pid, 'SIGHUP');
}, 400);
