import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {authenticatedFetch,connectionProfileSchema,readBoundedResponse,type ConnectionProfile} from './credential-connections';
import {apiConnectionSchema} from '@/shared/api-connection';
const fx=vi.hoisted(()=>({read:vi.fn(),password:'synthetic-password',allowed:true}));
vi.mock('./vault',()=>({getVault:()=>({getLoginAuthorized:fx.read})}));
let server:ReturnType<typeof createServer>,profile:ConnectionProfile;
const caller={userId:'owner',workspaceId:'workspace',agentId:'agent'};
const username='synthetic:username',access='synthetic-access-token',refresh='synthetic-refresh-token';
let logins=0,refreshes=0,resources=0;
let authBody:unknown,refreshBody:unknown,refreshStatus=200,resourceStatus=200,invalidResponse=false;
let now=0;let loginGate:Promise<void>|undefined;
async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
beforeEach(async()=>{
 loginGate=undefined;logins=0;refreshes=0;resources=0;refreshStatus=200;resourceStatus=200;invalidResponse=false;authBody=undefined;refreshBody=undefined;fx.allowed=true;fx.password='synthetic-password';
 fx.read.mockReset().mockImplementation(async()=>fx.allowed?{origin:profile.http!.origin,username,password:fx.password}:null);
 server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  const url=new URL(req.url!,'http://localhost');res.setHeader('Content-Type','application/json');
  expect(req.headers.cookie).toBeUndefined();
  expect(url.searchParams.get('_csrf')).toBe(req.headers['x-xsrf-token']);
  if(url.pathname==='/api/login'){
   logins++;authBody=await body(req);if(loginGate)await loginGate;expect(req.headers.authorization).toBeUndefined();
   res.end(JSON.stringify(invalidResponse?{error:'synthetic-password'}:{access_token:access+logins,refresh_token:refresh+logins,id_token:'synthetic-id-token',expires_in:300}));
  }else if(url.pathname==='/api/public/refresh-access-token'){
   refreshes++;refreshBody=await body(req);expect(req.headers.authorization).toBeUndefined();res.statusCode=refreshStatus;
   res.end(JSON.stringify(refreshStatus===200?{access_token:access+'refreshed'+refreshes,refresh_token:refresh+'rotated'+refreshes,expires_in:300}:{error:'synthetic-password'}));
  }else{
   resources++;expect(req.headers.authorization).toMatch(/^Bearer synthetic-access-token/);res.statusCode=resourceStatus;
   res.end(JSON.stringify({password:fx.password,username,authorization:req.headers.authorization,access:access+logins,refresh:refresh+logins,id:'synthetic-id-token',encoded:Buffer.from(refresh+logins).toString('base64')}));
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 profile=connectionProfileSchema.parse({id:'token-login',userId:'owner',workspaceId:null,credential:'saved-login',http:{origin,pathPrefix:'/api',auth:{type:'login-token',loginPath:'/api/login',refreshPath:'/api/public/refresh-access-token',language:'de',csrf:{query:'_csrf',header:'X-XSRF-TOKEN'}},methods:['GET','POST'],allowInsecureHttp:true}});
 now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
});
afterEach(async()=>{vi.restoreAllMocks();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const get=()=>authenticatedFetch(profile,caller,'/api/account');
test('posts Login fields privately, caches access tokens, rotates refresh tokens and masks all known token output',async()=>{
 const result=await get();expect(authBody).toEqual({username,password:fx.password,language:'de'});
 const safe=JSON.stringify(result.mask(JSON.parse(await readBoundedResponse(result.response))));
 for(const value of [username,fx.password,access+'1',refresh+'1','synthetic-id-token',Buffer.from(refresh+'1').toString('base64')])expect(safe).not.toContain(value);
 await Promise.all([get(),get()]);expect(logins).toBe(1);expect(resources).toBe(3);
 now+=300000;await Promise.all([get(),get()]);expect(refreshes).toBe(1);expect(logins).toBe(1);expect(refreshBody).toEqual({refreshToken:refresh+'1'});
 now+=300000;await get();expect(refreshes).toBe(2);expect(refreshBody).toEqual({refreshToken:refresh+'rotated1'});
 expect(fx.read).toHaveBeenCalledWith(expect.objectContaining({workspaceId:null,toolId:'connections',agentId:'agent'}),'saved-login',profile.http!.origin);
});
test('authentication POST is consented by mode while ordinary methods stay restricted; managed routes never become tool results',async()=>{
 profile.http!.methods=['GET'];await get();expect(logins).toBe(1);
 fx.read.mockClear();for(const path of ['/api/login','/api/%6cogin','/api/login/','/api/public/refresh-access-token','/api/LOGIN','/api/login.json'])await expect(authenticatedFetch(profile,caller,path)).rejects.toThrow('managed internally');
 expect(fx.read).not.toHaveBeenCalled();
 for(const path of ['/api//login','/api/login;foo'])await expect(authenticatedFetch(profile,caller,path)).rejects.toThrow('canonical');
 await expect(authenticatedFetch(profile,caller,'/api/account',{method:'POST',body:'{}'})).rejects.toThrow('method');
 for(const principal of [{...caller,userId:'foreign'},{...caller,space:{id:'shared'}}])await expect(authenticatedFetch(profile,principal,'/api/account')).rejects.toThrow('access denied');
 expect(logins).toBe(1);
});
test('rechecks Login access for cached tokens and starts a fresh session after a credential change',async()=>{
 await get();fx.allowed=false;await expect(get()).rejects.toThrow('Login unavailable');expect(resources).toBe(1);
 fx.allowed=true;fx.password='replacement-password';await get();expect(logins).toBe(2);expect(authBody).toMatchObject({password:fx.password});
});
test('refresh rejection reauthenticates once; transient refresh failure reports safely without a password retry loop',async()=>{
 await get();now+=300000;refreshStatus=401;await get();expect(logins).toBe(2);expect(refreshes).toBe(1);
 now+=300000;refreshStatus=503;await expect(get()).rejects.toThrow('HTTP 503');expect(logins).toBe(2);expect(resources).toBe(2);
});
test('invalid authentication responses never expose provider bodies, and a mutation returning 401 is not replayed',async()=>{
 invalidResponse=true;let error;try{await get();}catch(e){error=e;}expect(String(error)).toContain('no valid access token');expect(String(error)).not.toContain(fx.password);expect(resources).toBe(0);
 invalidResponse=false;resourceStatus=401;const result=await authenticatedFetch(profile,caller,'/api/update',{method:'POST',body:'{}'});expect(result.response.status).toBe(401);expect(resources).toBe(1);expect(logins).toBe(2);expect(refreshes).toBe(0);
 resourceStatus=200;await get();expect(refreshes).toBe(1);
});
test('controlled auth/CSRF headers and out-of-prefix issuer endpoints cannot trigger an exchange',async()=>{
 await expect(authenticatedFetch(profile,caller,'/api/account',{headers:{Authorization:'anything'}})).rejects.toThrow('controlled');
 await expect(authenticatedFetch(profile,caller,'/api/account',{headers:{'X-XSRF-TOKEN':'anything'}})).rejects.toThrow('managed');
 await expect(authenticatedFetch(profile,caller,'/api/account?_csrf=anything')).rejects.toThrow('managed');
 if(profile.http!.auth.type==='login-token')profile.http!.auth.loginPath='/outside/login';
 fx.read.mockClear();await expect(get()).rejects.toThrow('outside');expect(fx.read).not.toHaveBeenCalled();expect(logins).toBe(0);
});
test('shared schema rejects URL escapes, dangerous field names and colliding JSON mappings',()=>{
 const config={id:'login',origin:'https://api.example.test',pathPrefix:'/api',methods:['GET'],auth:{type:'login-token',loginPath:'/api/login'}};
 expect(apiConnectionSchema.safeParse(config).success).toBe(true);
 for(const patch of [{loginPath:'https://evil.test/login'},{loginPath:'//evil.test/login'},{loginPath:'/outside/login'},{loginPath:'/api/../login'},{usernameField:'__proto__'},{usernameField:'password'},{csrf:{query:'_csrf',header:'Authorization'}}])expect(apiConnectionSchema.safeParse({...config,auth:{...config.auth,...patch}}).success).toBe(false);
});

test('a cancelled waiter settles promptly without cancelling another caller sharing authentication',async()=>{
 let release!:()=>void;loginGate=new Promise<void>(resolve=>{release=resolve;});
 const a=new AbortController(),b=new AbortController();
 const first=authenticatedFetch(profile,caller,'/api/account',{signal:a.signal});const firstResult=first.then(()=> 'ok',()=> 'aborted');
 await vi.waitFor(()=>expect(logins).toBe(1));
 const second=authenticatedFetch(profile,caller,'/api/account',{signal:b.signal});const secondResult=second.then(()=> 'ok',()=> 'aborted');
 await vi.waitFor(()=>expect(fx.read).toHaveBeenCalledTimes(2));b.abort();
 expect(await secondResult).toBe('aborted');expect(resources).toBe(0);
 release();expect(await firstResult).toBe('ok');expect(logins).toBe(1);expect(resources).toBe(1);
});
test('the initiating caller cancellation does not own another waiter’s exchange',async()=>{
 let release!:()=>void;loginGate=new Promise<void>(resolve=>{release=resolve;});
 const abort=new AbortController();const first=authenticatedFetch(profile,caller,'/api/account',{signal:abort.signal});const firstResult=first.then(()=> 'ok',()=> 'aborted');
 await vi.waitFor(()=>expect(logins).toBe(1));const second=get();
 await vi.waitFor(()=>expect(fx.read).toHaveBeenCalledTimes(2));abort.abort();expect(await firstResult).toBe('aborted');release();
 expect((await second).response.status).toBe(200);expect(logins).toBe(1);
});
