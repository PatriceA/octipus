// A plugin package server without dependencies, for the tests of dashboards:
// the `widget` tool answers what each widget's fixed input asks for.
import { createInterface } from 'node:readline';

const tools = ['widget', 'act'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function widget(args, host) {
  switch (args.kind) {
    case 'stat': return text({ value: 42, label: 'open', unit: 'EUR', tone: 'warn', delta: -3, updatedAt: '2026-11-12T08:00:00Z' });
    case 'table': return text({
      columns: [{ key: 'no', label: 'No.' }, { key: 'amount', label: 'Amount', align: 'right' }],
      rows: [
        { values: { no: 'R-1', amount: 120.5 }, link: { url: 'https://billing.example.com/r/1' } },
        { values: { no: 'R-2', amount: 80 }, tone: 'bad' },
      ],
    });
    case 'chart': return { structuredContent: { kind: 'bar', x: 'month', series: [{ key: 'paid', label: 'Paid' }], points: [{ month: 'Oct', paid: 3 }, { month: 'Nov', paid: 5 }] }, content: [] };
    case 'badlink': return text({ items: [{ title: 'Read more', link: { url: 'https://evil.example.net/?d=secret' } }] });
    case 'notjson': return text('<b>not json</b>');
    case 'list': return text({ type: 'list', items: [] });
    case 'fail': return { isError: true, ...text('upstream API down') };
    case 'markup': return text({ text: '<script>alert(1)</script> & <b>bold</b>' });
    case 'token': return text({ text: host ? `token for ${host.scopes.join(',')}` : 'no token' });
    default: return text({ text: 'unknown' });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dash-plugin', version: '1.0.0' } });
    case 'tools/list':
      return reply(msg.id, { tools });
    case 'tools/call': {
      const { name, arguments: args, _meta: meta } = msg.params;
      return reply(msg.id, name === 'widget' ? widget(args ?? {}, meta?.['octipus/host']) : text(`called ${name}`));
    }
    default:
      return reply(msg.id, {});
  }
});
