import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MEDIA_TOOLS = ['octipus_generate_image', 'octipus_describe_image', 'octipus_transcribe_audio', 'octipus_speak'];

/** A backend with the given modules state; records each request. */
async function backend(t, modules, answer = () => ({})) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (req.url === '/api/modules') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(modules));
    }
    calls.push({ url: req.url, body });
    const out = answer(req.url, body);
    if (out instanceof Buffer) {
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.end(out);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new Client({ name: 'media-smoke', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { OCTIPUS_URL: `http://127.0.0.1:${server.address().port}`, OCTIPUS_API_KEY: 'k' }, stderr: 'pipe' }));
  return { client, calls };
}

/** Tool names once the first sync turned `marker` on. */
async function syncedNames(client, marker) {
  let names = [];
  for (let i = 0; i < 50 && !names.includes(marker); i++) {
    names = (await client.listTools()).tools.map(tool => tool.name);
    if (!names.includes(marker)) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(names.includes(marker), 'synced');
  return names;
}

test('each media tool is shown only while its capability is configured (and speech while voice is on)', { timeout: 10000 }, async t => {
  const { client } = await backend(t, {
    modules: [], enabled: ['people'],
    capabilities: [{ id: 'draw', on: true }, { id: 'see', on: false }, { id: 'hear', on: true }, { id: 'speak', on: true }],
  });
  const names = await syncedNames(client, 'octipus_generate_image');
  assert.ok(names.includes('octipus_generate_image'), 'draw is configured');
  assert.ok(!names.includes('octipus_describe_image'), 'nothing can see');
  // hear and speak are configured, but /api/voice is the voice module's and it is off.
  assert.ok(!names.includes('octipus_transcribe_audio'), 'voice module off');
  assert.ok(!names.includes('octipus_speak'), 'voice module off');
});

test('media tools call the lanes and return images and audio as content', { timeout: 10000 }, async t => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
  const { client, calls } = await backend(t, {
    modules: [], enabled: ['voice'],
    capabilities: [{ id: 'draw', on: true }, { id: 'see', on: true }, { id: 'hear', on: true }, { id: 'speak', on: true }],
  }, (url) => {
    if (url === '/api/media/images') return { images: [{ mimeType: 'image/png', base64: png }], model: 'gpt image', revisedPrompt: 'a red cat' };
    if (url === '/api/media/describe') return { description: 'A red cat.', model: 'vision row' };
    if (url === '/api/voice/transcribe') return { text: 'hello there', model: 'whisper', language: 'en' };
    if (url === '/api/voice/speak') return Buffer.from('ID3audio');
    return {};
  });
  const names = await syncedNames(client, 'octipus_speak');
  for (const name of MEDIA_TOOLS) assert.ok(names.includes(name), name);

  const drawn = await client.callTool({ name: 'octipus_generate_image', arguments: { prompt: 'a cat', n: 1 } });
  assert.deepEqual(drawn.content[0], { type: 'image', data: png, mimeType: 'image/png' });
  assert.match(drawn.content[1].text, /gpt image/);
  assert.match(drawn.content[1].text, /a red cat/);

  const seen = await client.callTool({ name: 'octipus_describe_image', arguments: { image: `data:image/png;base64,${png}`, question: 'Colour?' } });
  assert.match(seen.content[0].text, /A red cat\./);

  const heard = await client.callTool({ name: 'octipus_transcribe_audio', arguments: { audio: 'AAAA', format: 'wav' } });
  assert.match(heard.content[0].text, /hello there/);

  const spoken = await client.callTool({ name: 'octipus_speak', arguments: { text: 'Hello' } });
  assert.deepEqual(spoken.content[0], { type: 'audio', data: Buffer.from('ID3audio').toString('base64'), mimeType: 'audio/mpeg' });

  assert.deepEqual(calls.map(c => c.url), ['/api/media/images', '/api/media/describe', '/api/voice/transcribe', '/api/voice/speak']);
  assert.deepEqual(calls[0].body, { prompt: 'a cat', n: 1 });
  assert.deepEqual(calls[1].body, { image: png, question: 'Colour?' });
  assert.deepEqual(calls[2].body, { audio: 'AAAA', format: 'wav' });
  assert.deepEqual(calls[3].body, { text: 'Hello' });
});
