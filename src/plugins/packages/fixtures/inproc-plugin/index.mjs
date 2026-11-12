// An in-process plugin for the tests (src/plugins/packages/in-process.isolation.test.ts):
// one tool, one agent hook, and a note of every load and dispose on globalThis.
const MARK = 'v1';

export default function inproc(octi) {
  const log = (globalThis.__inprocLog ??= []);
  log.push(`load ${MARK}`);
  octi.registerTool({
    id: 'ping',
    description: 'Answer pong',
    effect: 'read',
    handler: () => ({ pong: MARK }),
  });
  octi.hook('tool:before', async () => {});
  octi.onDispose(() => { log.push(`dispose ${MARK}`); });
}
