import {EventEmitter} from 'node:events';
import {beforeEach,expect,test,vi} from 'vitest';
const fx=vi.hoisted(()=>({validate:vi.fn(),connect:vi.fn(),fetch:vi.fn()}));
vi.mock('@/utils/sanitize',()=>({validateExternalUrl:fx.validate,fetchPinned:fx.fetch}));
vi.mock('node:tls',()=>({connect:fx.connect}));
import {fetchWithCertificatePin,inspectConnectionCertificate} from './connection-tls';
const pin='a'.repeat(64);
beforeEach(()=>{
 vi.clearAllMocks();fx.validate.mockResolvedValue({valid:true,addresses:['93.184.216.34']});
 fx.fetch.mockResolvedValue(new Response('ok'));
 fx.connect.mockImplementation(()=>{
 const socket=new EventEmitter() as EventEmitter&{getPeerCertificate:()=>unknown;destroy:()=>void;authorized:boolean;authorizationError:string};
 socket.getPeerCertificate=()=>({raw:Buffer.from('synthetic-certificate'),subject:{CN:'device'},issuer:{CN:'issuer'},valid_from:'Jan 1 2020 GMT',valid_to:'Jan 1 2030 GMT'});
 socket.destroy=()=>{socket.emit('close');};socket.authorized=false;socket.authorizationError='SELF_SIGNED_CERT';
 queueMicrotask(()=>socket.emit('secureConnect'));return socket;
 });
});
test('public certificate inspection pins TLS to the vetted address and preserves the original SNI',async()=>{
 const result=await inspectConnectionCertificate('https://device.example.test:8006',{publicOnly:true});
 expect(fx.connect).toHaveBeenCalledWith(expect.objectContaining({host:'93.184.216.34',port:8006,servername:'device.example.test'}));
 expect(result.commonName).toBe('device');expect(fx.fetch).not.toHaveBeenCalled();
});
test('a public owner pin uses a vetted connection address instead of reopening unrestricted network access',async()=>{
 const url=new URL('https://device.example.test:8006/api2/json/version');
 await fetchWithCertificatePin(url,{headers:{Authorization:'synthetic-secret'}},pin,{publicOnly:true});
 expect(fx.fetch).toHaveBeenCalledWith(url.toString(),'93.184.216.34',expect.anything(),expect.anything());
});
test('private/rebinding destinations are refused before any TLS socket or authenticated HTTP request',async()=>{
 fx.validate.mockResolvedValue({valid:false});
 await expect(inspectConnectionCertificate('https://device.example.test',{publicOnly:true})).rejects.toThrow('public destinations');
 await expect(fetchWithCertificatePin(new URL('https://127.0.0.1'),{headers:{Authorization:'synthetic-secret'}},pin,{publicOnly:true})).rejects.toThrow('public destinations');
 expect(fx.connect).not.toHaveBeenCalled();expect(fx.fetch).not.toHaveBeenCalled();
});
