import {randomBytes} from 'node:crypto';
import type {LoginTokenAuth} from '@/shared/login-token-auth';
import type {LoginRecord} from '@/shared/vault-login';

export class LoginTokenError extends Error {}

type Session={accessToken:string;refreshToken?:string;expiresAt:number;secrets:string[]};
const sessions=new Map<string,Session>();
type Pending={promise:Promise<Session>;controller:AbortController;waiters:number;settled:boolean};
const pending=new Map<string,Pending>();
const MAX_SESSIONS=256;

/** Tokens stay in process memory. Every use must first re-authorize the vault Login. */
export async function loginTokenSession(key:string,auth:LoginTokenAuth,login:LoginRecord,
  request:(path:string,init:RequestInit)=>Promise<Response>,signal?:AbortSignal):Promise<Session>{
  signal?.throwIfAborted();
  const current=sessions.get(key);
  if(current&&current.expiresAt>Date.now())return current;
  let job=pending.get(key);
  if(!job){
    // Bound both live caches and concurrent exchanges; never evict an in-flight request.
    if(pending.size>=MAX_SESSIONS)throw new LoginTokenError('Login authentication is busy; retry later');
    const controller=new AbortController();
    const promise=exchange(key,auth,login,current,(path,init)=>request(path,{...init,signal:controller.signal}));
    job={promise,controller,waiters:0,settled:false};
    pending.set(key,job);
    const entry=job;
    void promise.finally(()=>{entry.settled=true;pending.delete(key);}).catch(()=>{});
  }
  const entry=job;entry.waiters++;
  try{
    const result=await new Promise<Session>((resolve,reject)=>{
      const abort=()=>{signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('Login request cancelled'));};
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      entry.promise.then(value=>{signal?.removeEventListener('abort',abort);resolve(value);},error=>{signal?.removeEventListener('abort',abort);reject(error);});
    });
    signal?.throwIfAborted();return result;
  }finally{
    entry.waiters--;
    if(!entry.waiters&&!entry.settled)entry.controller.abort();
  }
}

async function exchange(key:string,auth:LoginTokenAuth,login:LoginRecord,current:Session|undefined,
  request:(path:string,init:RequestInit)=>Promise<Response>):Promise<Session>{
  async function post(path:string,body:Record<string,string>):Promise<{status:number;data:Record<string,unknown>}> {
    const csrf=auth.csrf?randomBytes(24).toString('hex'):null;
    const headers=new Headers({'Content-Type':'application/json','Accept':'application/json'});
    if(auth.csrf&&csrf)headers.set(auth.csrf.header,csrf);
    const target=auth.csrf?`${path}?${new URLSearchParams({[auth.csrf.query]:csrf!})}`:path;
    const response=await request(target,{method:'POST',headers,body:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();return {status:response.status,data:{}};}
    // Token responses are bounded and never become tool results, even on parse errors.
    const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw new LoginTokenError();chunks.push(value);}
      const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new LoginTokenError();
      return {status:response.status,data:parsed as Record<string,unknown>};
    }catch{throw new LoginTokenError('Login token response is invalid or too large; credentials and tokens withheld');}
    finally{await reader?.cancel().catch(()=>{});}
  }
  try{
    let result:Awaited<ReturnType<typeof post>>|undefined;
    let refreshed=false;
    if(current?.refreshToken&&auth.refreshPath){
      result=await post(auth.refreshPath,{[auth.refreshTokenRequestField]:current.refreshToken});
      if(result.status===400||result.status===401)result=undefined;
      else refreshed=result.status>=200&&result.status<300;
    }
    if(!result)result=await post(auth.loginPath,{...(auth.language?{language:auth.language}:{}),[auth.usernameField]:login.username,[auth.passwordField]:login.password});
    if(result.status<200||result.status>=300)throw new LoginTokenError(`Login token exchange failed (HTTP ${result.status}); credentials and tokens withheld`);
    const access=result.data[auth.accessTokenField],refresh=result.data[auth.refreshTokenField];
    if(typeof access!=='string'||!access||access.length>32768||/[\x00-\x20\x7f-\uffff]/.test(access))throw new LoginTokenError('Login token response has no valid access token; credentials and tokens withheld');
    if(refresh!==undefined&&(typeof refresh!=='string'||!refresh||refresh.length>32768))throw new LoginTokenError('Login token response has an invalid refresh token; credentials and tokens withheld');
    const duration=result.data[auth.expiresInField];
    if(duration!==undefined&&(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0))throw new LoginTokenError('Login token response has an invalid expiry; credentials and tokens withheld');
    const seconds=typeof duration==='number'&&Number.isFinite(duration)&&duration>0?Math.min(duration,3600):auth.sessionTtlSeconds;
    const refreshToken=typeof refresh==='string'?refresh:refreshed?current?.refreshToken:undefined;
    const session:Session={accessToken:access,refreshToken,expiresAt:Date.now()+seconds*1000-Math.min(30000,seconds*100),
      secrets:[...new Set([...(current?.secrets??[]),access,...(refreshToken?[refreshToken]:[]),...Object.entries(result.data).filter(([name,value])=>typeof value==='string'&&/token/i.test(name)).map(([,value])=>value as string)])].slice(-64)};
    sessions.delete(key);sessions.set(key,session);
    while(sessions.size>MAX_SESSIONS)sessions.delete(sessions.keys().next().value!);
    return session;
  }catch(error){sessions.delete(key);throw error;}
}

/** Never replay an application request, especially a mutation, after HTTP 401. */
export function invalidateLoginToken(key:string):void {const session=sessions.get(key);if(session)session.expiresAt=0;}
