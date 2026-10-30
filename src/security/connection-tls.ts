import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect, type TLSSocket } from 'node:tls';
import { fetchPinned } from '@/utils/sanitize';

const sha256 = (socket: TLSSocket) => {
  const raw=socket.getPeerCertificate().raw;
  if(!raw)throw new Error('Server did not present a certificate');
  return createHash('sha256').update(raw).digest('hex');
};
export class CertificatePinMismatchError extends Error {
  constructor(){super('Server certificate changed. Inspect and approve the new certificate in Secrets → Connect API before retrying.');this.name='CertificatePinMismatchError';}
}
export function certificateVerificationCode(error:unknown):string|null {
  const allowed=new Set(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
  let value=error;
  for(let i=0;i<5&&value&&typeof value==='object';i++){
    const e=value as {code?:unknown;cause?:unknown};if(typeof e.code==='string'&&allowed.has(e.code))return e.code;value=e.cause;
  }
  return null;
}
function serviceOrigin(origin:string):URL {
  if(origin.length>2048)throw new Error('Use a valid HTTPS origin');
  const url=new URL(origin);
  if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password)throw new Error('Use an HTTPS origin without a path');
  return url;
}

/** Public certificate only; never send credentials or an HTTP request. */
export async function inspectConnectionCertificate(origin:string) {
  const url=serviceOrigin(origin),host=url.hostname.replace(/^\[|\]$/g,'');
  return new Promise<{origin:string;certificateSha256:string;commonName:string;issuer:string;validFrom:string;validTo:string;verificationError:string|null}>((resolve,reject)=>{
    const socket=connect({host,port:Number(url.port||443),servername:isIP(host)?undefined:host,rejectUnauthorized:false});
    const timer=setTimeout(()=>socket.destroy(new Error('Certificate inspection timed out')),10000);
    socket.once('error',reject);socket.once('close',()=>{clearTimeout(timer);reject(new Error('TLS connection closed during certificate inspection'));});
    socket.once('secureConnect',()=>{
      try {
        const cert=socket.getPeerCertificate();
        resolve({origin,certificateSha256:sha256(socket),commonName:String(cert.subject?.CN??'').slice(0,200),issuer:String(cert.issuer?.CN??'').slice(0,200),validFrom:cert.valid_from,validTo:cert.valid_to,verificationError:socket.authorized?null:String(socket.authorizationError).slice(0,200)});
      }catch(error){reject(error);}finally{socket.destroy();}
    });
  });
}

/** Hold the HTTP request until the exact certificate has been checked. */
class CertificateAgent extends Agent {
  private candidates=new Set<TLSSocket>();
  constructor(private readonly fingerprint:string,private readonly onClose:()=>void){super({keepAlive:false,maxCachedSessions:0});}
  override createConnection(options:RequestOptions,callback?:(error:Error|null,stream:Duplex)=>void) {
    const host=String(options.hostname??options.host??'localhost').replace(/^\[|\]$/g,'');
    const socket=connect({host,port:Number(options.port??443),servername:options.servername||(isIP(host)?undefined:host),lookup:options.lookup,rejectUnauthorized:false,ALPNProtocols:['http/1.1']});
    this.candidates.add(socket);
    let finished=false;
    const finish=(error:Error|null)=>{if(finished)return;finished=true;callback?.(error,socket);};
    const timer=setTimeout(()=>socket.destroy(new Error('TLS handshake timed out')),10000);
    socket.once('close',()=>{clearTimeout(timer);this.candidates.delete(socket);finish(new Error('TLS connection closed'));if(!this.candidates.size)this.onClose();});
    socket.once('error',error=>finish(error));
    socket.once('secureConnect',()=>{
      clearTimeout(timer);
      try {
        const actual=Buffer.from(sha256(socket),'hex'),expected=Buffer.from(this.fingerprint,'hex');
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new CertificatePinMismatchError();
        finish(null);
      }catch(error){socket.destroy(error as Error);}
    });
    // Returning the socket here would let HTTP write before pin validation.
    return undefined;
  }
  override destroy(){for(const socket of this.candidates)socket.destroy(new Error('TLS request cancelled'));super.destroy();}
}

export async function fetchWithCertificatePin(url:URL,init:RequestInit,fingerprint:string):Promise<Response> {
  serviceOrigin(url.origin);
  if(!/^[a-f0-9]{64}$/i.test(fingerprint))throw new Error('Invalid certificate fingerprint');
  const agent=new CertificateAgent(fingerprint,()=>init.signal?.removeEventListener('abort',abort));
  const abort=()=>agent.destroy();
  if(init.signal?.aborted)throw new Error('Request aborted');
  init.signal?.addEventListener('abort',abort,{once:true});
  try {
    const response=await fetchPinned(url.toString(),null,init,agent);
    // The body owns the socket after headers; keep abort support until close.
    return response;
  }catch(error){init.signal?.removeEventListener('abort',abort);agent.destroy();throw error;}
}
