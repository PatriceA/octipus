import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch, connectionFor, connectionUrl, readBoundedResponse, readConnectionProfiles, connectionProfileSchema } from './credential-connections';
import { assertNoCredentialTemplates } from './credential-boundary';

const fx = vi.hoisted(() => ({ value: 'CANARY_CONNECTION_SECRET_9x~!', allowedTools: [] as string[], allowedAgents: [] as string[], reads: vi.fn() }));
vi.mock('./vault', () => ({ getVault: () => ({ list: async () => [], getByNameAuthorized: async (agent: {toolId:string;agentId?:string}) => {
  if ((fx.allowedTools.length && !fx.allowedTools.includes(agent.toolId)) || (fx.allowedAgents.length && !fx.allowedAgents.includes(agent.agentId??''))) return null;
  fx.reads(); return fx.value;
} }) }));
let dir: string; const saved = process.env.OCTIPUS_CONNECTIONS_FILE;
const caller = { userId: 'alice', workspaceId: 'w1', agentId: 'agent-a' };
let profile: ReturnType<typeof connectionProfileSchema.parse>;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'octi-connection-'));
  process.env.OCTIPUS_CONNECTIONS_FILE = join(dir, 'profiles.json');
  fx.value = 'CANARY_CONNECTION_SECRET_9x~!'; fx.allowedTools = []; fx.allowedAgents = []; fx.reads.mockClear();
  profile = connectionProfileSchema.parse({ id: 'test', userId: 'alice', workspaceId: 'w1', credential: 'TEST_TOKEN', http: { origin: 'https://api.example.test', auth: { type: 'bearer' }, methods: ['GET','POST'] } });
});
afterEach(async () => { await stop?.(); stop = undefined; if (saved === undefined) delete process.env.OCTIPUS_CONNECTIONS_FILE; else process.env.OCTIPUS_CONNECTIONS_FILE = saved; await rm(dir, { recursive: true, force: true }); });
const store = async () => writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!, JSON.stringify([profile]), { mode: 0o600 });
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stop = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  profile.http!.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; profile.http!.allowInsecureHttp = true;
}
describe('credential connection boundary', () => {
  it('binds an authorized named profile, rejects foreign user/workspace before reading the vault', async () => {
    await store(); expect((await connectionFor('test', caller)).id).toBe('test');
    for (const c of [{...caller,userId:'bob'},{...caller,workspaceId:'w2'},{...caller,space:{id:'space'}}]) await expect(connectionFor('test',c)).rejects.toThrow(/unavailable/);
    expect(fx.reads).not.toHaveBeenCalled();
  });
  it.each(['//evil.test/x','https://evil.test/x','/../private','/api/%252e%252e/private','/api/..%2fprivate','/api/\\evil'])('rejects origin/path escapes: %s', path => {
    profile.http!.pathPrefix = '/api'; expect(() => connectionUrl(profile,path)).toThrow();
  });
  it('authorizes tool and agent ACLs before decryption and sends no request on denial', async () => {
    fx.allowedTools=['shell']; await expect(authenticatedFetch(profile,caller,'/api')).rejects.toThrow(/denied/);
    fx.allowedTools=[]; fx.allowedAgents=['other']; await expect(authenticatedFetch(profile,caller,'/api')).rejects.toThrow(/denied/);
    expect(fx.reads).not.toHaveBeenCalled();
  });
  it('keeps the credential out of profile persistence and redacts raw/encoded server echoes', async () => {
    await endpoint((req,res) => {
      expect(req.headers.authorization).toBe(`Bearer ${fx.value}`);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ raw:fx.value, b64:Buffer.from(fx.value).toString('base64'), hex:Buffer.from(fx.value).toString('hex'), url:encodeURIComponent(fx.value) }));
    }); await store();
    const {response,mask}=await authenticatedFetch(await connectionFor('test',caller),caller,'/api');
    const safe=JSON.stringify(mask(JSON.parse(await readBoundedResponse(response))));
    for (const v of [fx.value,Buffer.from(fx.value).toString('base64'),Buffer.from(fx.value).toString('hex'),encodeURIComponent(fx.value)]) expect(safe).not.toContain(v);
    expect(await readFile(process.env.OCTIPUS_CONNECTIONS_FILE!,'utf8')).not.toContain(fx.value);
  });
  it('does not follow redirects or permit an auth/routing override', async () => {
    let requests=0; await endpoint((_req,res)=>{requests++;res.writeHead(302,{Location:'http://127.0.0.1:1/leak'}).end();});
    const {response}=await authenticatedFetch(profile,caller,'/api'); expect(response.status).toBe(302);expect(requests).toBe(1);
    await expect(authenticatedFetch(profile,caller,'/api',{headers:{Authorization:'override'}})).rejects.toThrow(/controlled/);
  });
  it('fails closed for missing credentials/configuration, denied methods, oversized output and insecure origins', async () => {
    expect(await readConnectionProfiles()).toEqual([]);
    await expect(authenticatedFetch(profile,caller,'/api',{method:'DELETE'})).rejects.toThrow(/method/);
    await expect(readBoundedResponse(new Response('long'),2)).rejects.toThrow(/size/);
    profile.http!.origin='http://internal.test'; await store(); await expect(readConnectionProfiles()).rejects.toThrow(/invalid/);
  });
  it.each(['\0', '\r', '\n', '\u0100'])('does not reflect invalid vault header values into exceptions: %j', async invalid => {
    fx.value = 'PRIVATE_CANARY' + invalid + 'suffix';
    let failure: unknown; try { await authenticatedFetch(profile,caller,'/api'); } catch(error) { failure=error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('PRIVATE_CANARY');
  });
  it('supports token-as-Basic-username authentication without a password', async () => {
    profile.http!.auth={type:'basic-token'};
    await endpoint((req,res)=>{expect(req.headers.authorization).toBe(`Basic ${Buffer.from(fx.value+':').toString('base64')}`);res.end('ok');});
    const {response}=await authenticatedFetch(profile,caller,'/api');expect(await readBoundedResponse(response)).toBe('ok');
  });
  it('enforces the public-network policy for self-service profiles at request time', async () => {
    let requests=0;await endpoint((_req,res)=>{requests++;res.end('unexpected');});profile.http!.networkPolicy='public';
    await expect(authenticatedFetch(profile,caller,'/api')).rejects.toThrow(/request failed/);expect(requests).toBe(0);
  });
  it('continues rejecting shell redirection, file templates and nested general interpolation without creating a file', async () => {
    const path=join(dir,'leak');
    for(const input of [{command:`echo "$TOKEN" > ${path}`,env:{TOKEN:'{{secret:TEST_TOKEN}}'}},{content:'${vault.TEST_TOKEN}'},{nested:[JSON.stringify({secret:'{{secret:TEST_TOKEN}}'})]}]) expect(()=>assertNoCredentialTemplates(input)).toThrow(/Policy credential-boundary/);
    await expect(readFile(path)).rejects.toThrow(); expect(fx.reads).not.toHaveBeenCalled();
  });
});
