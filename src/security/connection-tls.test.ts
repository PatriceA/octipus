import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { fetchWithCertificatePin, inspectConnectionCertificate } from './connection-tls';
import { apiConnectionSchema } from '@/shared/api-connection';
import { authenticatedFetch, connectionProfileSchema, readBoundedResponse } from './credential-connections';

const vaultReads=vi.hoisted(()=>vi.fn());
vi.mock('@/security/vault',()=>({getVault:()=>({getByNameAuthorized:async(_caller:unknown,name:string)=>{vaultReads();return name==='OPNsense_KEY'?'SYNTHETIC_OPNSENSE_KEY':'SYNTHETIC_TLS_CANARY';}})}));

let dir:string;
const certificates:{key:Buffer;cert:Buffer;pin:string}[]=[];
const servers:Server[]=[];
beforeAll(()=>{
 dir=mkdtempSync(join(tmpdir(),'octi-synthetic-tls-'));
 for(let i=0;i<2;i++){
  const keyPath=join(dir,`key${i}.pem`),certPath=join(dir,`cert${i}.pem`);
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=synthetic-device.invalid'],{stdio:'ignore'});
  const cert=readFileSync(certPath);certificates.push({key:readFileSync(keyPath),cert,pin:new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase()});
 }
});
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
async function endpoint(index=0,redirect?:string,expectedAuth='Bearer SYNTHETIC_TLS_CANARY'){
 let requests=0,plaintextBytes=0;
 const server=createServer(certificates[index],(req,res)=>{
  requests++;
  if(redirect){res.writeHead(302,{Location:redirect});res.end();return;}
  expect(req.headers.authorization).toBe(expectedAuth);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
 });
 server.on('secureConnection',socket=>socket.on('data',chunk=>{plaintextBytes+=chunk.length;}));
 servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{origin:`https://127.0.0.1:${(server.address() as {port:number}).port}`,requests:()=>requests,bytes:()=>plaintextBytes};
}
const init=()=>({headers:{Authorization:'Bearer SYNTHETIC_TLS_CANARY'},signal:AbortSignal.timeout(3000)});
test('inspection reads certificate metadata without sending any HTTP request or credential',async()=>{
 const e=await endpoint();const info=await inspectConnectionCertificate(e.origin);
 expect(info.certificateSha256).toBe(certificates[0].pin);expect(info.commonName).toBe('synthetic-device.invalid');
 expect(info.verificationError).not.toBeNull();expect(e.requests()).toBe(0);expect(e.bytes()).toBe(0);
 expect(JSON.stringify(info)).not.toContain('SYNTHETIC_TLS_CANARY');
});
test('explicit exact-certificate trust works while default TLS remains strict',async()=>{
 const e=await endpoint();await expect(fetch(e.origin,init())).rejects.toThrow();
 const response=await fetchWithCertificatePin(new URL(e.origin+'/api/status'),init(),certificates[0].pin);
 expect(await response.json()).toEqual({ok:true});expect(e.requests()).toBe(1);
 await expect(fetch(e.origin,init())).rejects.toThrow();
});
test('wrong or replaced certificate receives zero HTTP plaintext, including credentials',async()=>{
 const e=await endpoint(1);
 await expect(fetchWithCertificatePin(new URL(e.origin+'/api'),init(),certificates[0].pin)).rejects.toThrow(/certificate changed/);
 expect(e.requests()).toBe(0);expect(e.bytes()).toBe(0);
});
test('a redirect cannot carry credentials to a second origin',async()=>{
 const destination=await endpoint(1);const e=await endpoint(0,destination.origin+'/stolen');
 const response=await fetchWithCertificatePin(new URL(e.origin+'/api'),init(),certificates[0].pin);
 expect(response.status).toBe(302);await response.text();expect(destination.requests()).toBe(0);
});
test('aborting a TLS handshake rejects promptly without leaving a pending request',async()=>{
 const sockets=new Set<import('node:net').Socket>();const server=createTcpServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=new URL(`https://127.0.0.1:${(server.address() as {port:number}).port}/api`);
  await expect(fetchWithCertificatePin(url,{...init(),signal:AbortSignal.timeout(30)},certificates[0].pin)).rejects.toThrow();
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('HTTP origins and malformed certificate fingerprints cannot enable certificate trust',async()=>{
 await expect(inspectConnectionCertificate('http://127.0.0.1')).rejects.toThrow(/HTTPS/);
 const config={id:'device',origin:'http://127.0.0.1',pathPrefix:'/api',auth:{type:'bearer'},methods:['GET'],allowInsecureHttp:true,tls:{mode:'pinned',certificateSha256:'a'.repeat(64)}};
 expect(apiConnectionSchema.safeParse(config).success).toBe(false);
 expect(apiConnectionSchema.safeParse({...config,origin:'https://127.0.0.1',tls:{mode:'pinned',certificateSha256:'bad'}}).success).toBe(false);
});
test('the broker uses both vault references with pinned TLS, preserves ACLs and redacts Basic credentials',async()=>{
 const key='SYNTHETIC_OPNSENSE_KEY',secret='SYNTHETIC_TLS_CANARY',auth=`Basic ${Buffer.from(key+':'+secret).toString('base64')}`;
 const e=await endpoint(0,undefined,auth);
 const profile=connectionProfileSchema.parse({id:'opnsense',userId:'owner',workspaceId:null,credential:'OPNsense_SECRET',http:{origin:e.origin,pathPrefix:'/api',auth:{type:'basic',usernameCredential:'OPNsense_KEY'},methods:['GET'],tls:{mode:'pinned',certificateSha256:certificates[0].pin}}});
 const result=await authenticatedFetch(profile,{userId:'owner'},'/api/status', {signal:AbortSignal.timeout(3000)});
 expect(JSON.parse(await readBoundedResponse(result.response))).toEqual({ok:true});expect(e.requests()).toBe(1);
 const masked=JSON.stringify(result.mask({key,secret,auth}));expect(masked).not.toContain(key);expect(masked).not.toContain(secret);expect(masked).not.toContain(auth);
 vaultReads.mockClear();
 await expect(authenticatedFetch(profile,{userId:'other'},'/api/status')).rejects.toThrow(/access denied/);
 expect(vaultReads).not.toHaveBeenCalled();expect(e.requests()).toBe(1);
 const publicProfile={...profile,http:{...profile.http!,networkPolicy:'public' as const}};
 expect(connectionProfileSchema.safeParse(publicProfile).success).toBe(true);
 await expect(authenticatedFetch(publicProfile,{userId:'owner'},'/api/status')).rejects.toThrow(/public destinations/);
 expect(e.requests()).toBe(1);
});
