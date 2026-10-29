import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
const fixture = vi.hoisted(() => ({ user: {id:'owner',isAdmin:true} as {id:string;isAdmin:boolean}|null, save:vi.fn() }));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({user:fixture.user})) };
});
vi.mock('@/db/repositories/vault-api-connection', () => ({ saveVaultApiConnection:fixture.save, VaultConnectionError:class extends Error {} }));
import { vaultRoutes } from './vault';
const app = new App().group('/api', group => group.use(vaultRoutes));
const id='80c99ba7-fb66-4449-85b5-a8a9cdc22e6b',workspaceId='deb3089f-328c-4139-a835-6a238d718747';
const config={id:'appwrite_octipus_mobile',origin:'https://appwrite.example.com',pathPrefix:'/v1',auth:{type:'header',name:'X-Appwrite-Key',prefix:''},headers:{'X-Appwrite-Project':'synthetic-project'},methods:['GET'],allowInsecureHttp:false};
const request=(body:unknown,credentialId=id)=>app.handle(new Request(`http://test/api/vault/${credentialId}/api-connection?workspaceId=${workspaceId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
beforeEach(()=>{vi.clearAllMocks();fixture.user={id:'owner',isAdmin:true};fixture.save.mockImplementation(async(_u,_id,_ws,body)=>body);});
test('the real route validator accepts valid credential and workspace UUIDs',async()=>{
  const response=await request(config);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({connection:config});
  expect(fixture.save).toHaveBeenCalledWith('owner',id,workspaceId,config,{allowPrivateOrigins:true});
});
test('rejects an origin containing an API path with actionable guidance',async()=>{
  const response=await request({...config,origin:config.origin+'/v1'});
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('without a path');
  expect(fixture.save).not.toHaveBeenCalled();
});
test('keeps UUID, authentication and secret-field validation enforced',async()=>{
  expect((await request(config,'not-an-id')).status).toBe(422);
  fixture.user=null;expect((await request(config)).status).toBe(401);
  fixture.user={id:'owner',isAdmin:false};
  expect((await request({...config,headers:{'X-Appwrite-Key':'SYNTHETIC_SECRET'}})).status).toBe(400);
  expect(fixture.save).not.toHaveBeenCalled();
  const response=await request({...config,['SYNTHETIC_SECRET']:'SYNTHETIC_SECRET'});
  expect(response.status).toBe(400);expect(JSON.stringify(await response.json())).not.toContain('SYNTHETIC_SECRET');
});
test('removes a connection through the same UUID-validated route',async()=>{
  const response=await request(null);expect(response.status).toBe(200);
  expect(await response.json()).toEqual({connection:null});
});
