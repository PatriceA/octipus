import { describe, expect, test, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), connection: vi.fn(), read: vi.fn(), held: vi.fn() }));
vi.mock('@/security/credential-connections', () => ({ authenticatedFetch: mocks.fetch, connectionFor: mocks.connection, readBoundedResponse: mocks.read }));
vi.mock('./host-api', () => ({ userHeldScopes: mocks.held }));
const { connectionGetAllowed, pluginConnectionGet } = await import('./host-connections');
const settings = { connection_grants: JSON.stringify({ llama: ['/health', '/metrics'] }) };
beforeEach(() => {
 vi.clearAllMocks();
 mocks.held.mockResolvedValue(['connections:read']);
 mocks.connection.mockResolvedValue({ id: 'llama' });
 mocks.fetch.mockResolvedValue({ response: new Response('{}', {headers:{'content-type':'application/json'}}), mask:(x:unknown)=>x });
 mocks.read.mockResolvedValue('{}');
});
describe('plugin connection grants', () => {
 test('only exact admin-configured path and connection; no wildcards or fallback', () => {
  expect(connectionGetAllowed(settings,'llama','/metrics')).toBe(true);
  for(const path of ['/metrics?token=x','//evil.example/metrics','https://evil.example','/props','/metrics#x','/metrics\n']) expect(connectionGetAllowed(settings,'llama',path)).toBe(false);
  expect(connectionGetAllowed(settings,'opnsense','/health')).toBe(false);
  for(const value of ['', 'null','[]','{"__proto__": ["/health"]}'])expect(connectionGetAllowed({connection_grants:value},'llama','/health')).toBe(false);
 });
 test('denied grant and permission cannot reach trusted client', async () => {
  expect(await pluginConnectionGet({userId:'alice'},settings,{connection:'other',path:'/health'})).toMatchObject({status:403});
  mocks.held.mockResolvedValue([]);
  expect(await pluginConnectionGet({userId:'alice'},settings,{connection:'llama',path:'/health'})).toMatchObject({status:403});
  expect(mocks.fetch).not.toHaveBeenCalled();
 });
 test('caller bound, GET only, bounded response, credential mask applied', async () => {
  mocks.fetch.mockResolvedValue({response:new Response('{}',{headers:{'content-type':'application/json'}}),mask:()=>({status:200,ok:true,body:'masked'})});
  const caller={userId:'alice',workspaceId:'personal'};
  expect(await pluginConnectionGet(caller,settings,{connection:'llama',path:'/health'})).toEqual({status:200,ok:true,body:'masked'});
  expect(mocks.connection).toHaveBeenCalledWith('llama',caller);
  expect(mocks.fetch).toHaveBeenCalledWith({id:'llama'},caller,'/health',expect.objectContaining({method:'GET',signal:expect.any(AbortSignal)}));
  expect(mocks.read).toHaveBeenCalledWith(expect.any(Response),1048576);
 });
 test('credential errors never reflected', async () => {
  mocks.connection.mockRejectedValue(new Error('private credential content'));
  const out=await pluginConnectionGet({userId:'bob'},settings,{connection:'llama',path:'/health'});
  expect(out).toMatchObject({status:502,code:'connection_failed'});
  expect(JSON.stringify(out)).not.toContain('private credential content');
 });
 test('a saved URL cannot silently name another connection origin', async () => {
  mocks.connection.mockResolvedValue({id:'llama',http:{origin:'http://192.168.1.156:8080'}});
  expect(await pluginConnectionGet({userId:'alice'},settings,{connection:'llama',path:'/health',expectedOrigin:'http://other.example'})).toMatchObject({status:403,code:'connection_origin_mismatch'});
  expect(mocks.fetch).not.toHaveBeenCalled();
 });
});
