import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, expectNoConsoleErrors } from './fixtures/auth';

const UI=process.env.LLAMA_MONITOR_UI_DIR;
test.skip(!UI,'Set LLAMA_MONITOR_UI_DIR to the package under review.');
const base='/api/plugin-ui/llama-monitor/';
type Failure='start'|'sample'|'metadata'|'stop'|'profiles'|null;
async function setup(page:Page){
 const profile={id:'one',name:'Engine One',url:'https://one.example.com',connection:'engine_one',telemetryConnection:''};
 const entries=new Map<string,{value:any;version:number}>([['profiles',{value:{profiles:[profile,{...profile,id:'two',name:'Engine Two',url:'https://two.example.com',connection:'engine_two'}]},version:1}]]);
 const state={entries,failure:null as Failure,offline:false,probes:0};
 await page.route('**/api/plugin-ui',r=>r.fulfill({json:{pages:[{plugin:'llama-monitor',pluginTitle:'Monitor',title:'Monitor',path:'dashboard',src:base+'index.html'}]}}));
 await page.route('**/api/plugin-ui/llama-monitor/**',r=>{
  const url=new URL(r.request().url()),file=url.pathname.slice(base.length),source=url.origin+base;
  return r.fulfill({body:readFileSync(join(UI!,file)),headers:{
   'content-type':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript',
   'access-control-allow-origin':'*',
   'content-security-policy':"default-src 'none'; script-src "+source+"; style-src "+source+"; connect-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  }});
 });
 await page.route('**/api/plugins/llama-monitor/store**',r=>{
  const req=r.request(),url=new URL(req.url()),key=decodeURIComponent(url.pathname.split('/store/')[1]||'');
  if(req.method()==='GET'){
   if(!key)return r.fulfill({json:{keys:[...entries.keys()].filter(k=>k.startsWith(url.searchParams.get('prefix')||'')).sort().map(key=>({key}))}});
   return r.fulfill(entries.has(key)?{json:entries.get(key)}:{status:404,json:{code:'not_found',error:'No such key'}});
  }
  if(req.method()==='PUT'){
   const body=req.postDataJSON(),value=body.value;
   const denied=state.failure==='profiles'&&key==='profiles'
    ||state.failure==='start'&&key.startsWith('session/')&&!entries.has(key)
    ||state.failure==='sample'&&key.startsWith('sample/')
    ||state.failure==='metadata'&&key.startsWith('session/')&&value.count>0
    ||state.failure==='stop'&&key.startsWith('session/')&&value.stoppedAt;
   if(denied)return r.fulfill({status:403,json:{code:'storage_failure',error:'Injected storage failure'}});
   const version=(entries.get(key)?.version||0)+1;entries.set(key,{value,version});
   return r.fulfill({json:{version}});
  }
  entries.delete(key);return r.fulfill({json:{deleted:true}});
 });
 await page.route('**/api/plugins/llama-monitor/call/read_engine',r=>{
  if(state.offline)return r.fulfill({json:{result:{isError:true,content:[{type:'text',text:'Engine offline'}]}}});
  state.probes++;
  const snapshot={at:new Date(Date.now()+state.probes*1000).toISOString(),health:{status:'ok'},models:{data:[{id:'Only-on-One',status:'loaded'}]},host:{cpuPercent:50},metrics:'llamacpp:requests_processing 1'};
  return r.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(snapshot)}]}}});
 });
 await page.goto('/plugins/llama-monitor/dashboard');
 const frame=page.frameLocator('[data-testid="plugin-frame"]');
 await expect(frame.locator('#status')).toContainText('Ready.');
 await frame.locator('#engines').selectOption('one');
 await frame.locator('#interval').selectOption('60');
 return {state,frame};
}

test('initial session write failure leaves Start retryable and controls usable',async({authenticatedPage:page,consoleErrors})=>{
 const {state,frame}=await setup(page);
 state.failure='start';await frame.locator('#start').click();
 await expect(frame.locator('#error')).toHaveText('Injected storage failure');
 await expect(frame.locator('#start')).toBeEnabled();
 await expect(frame.locator('#stop')).toBeDisabled();
 await expect(frame.locator('#save')).toBeEnabled();
 expect([...state.entries.keys()].filter(k=>k.startsWith('session/'))).toHaveLength(0);
 state.failure=null;await frame.locator('#start').click();
 await expect(frame.locator('#stop')).toBeEnabled();
 await frame.locator('#stop').click();
 await expect(frame.locator('#session-label')).toHaveText('Session stopped and saved.');
 const saved=[...state.entries.entries()].find(([k])=>k.startsWith('session/'))![1].value;
 expect(saved.count).toBe(1);
 expectNoConsoleErrors(consoleErrors);
});

for(const failure of ['sample','metadata'] as const){
 test(failure+' failure cannot enter saved count or history statistics',async({authenticatedPage:page,consoleErrors})=>{
  const {state,frame}=await setup(page);state.failure=failure;
  await frame.locator('#start').click();
  await expect(frame.locator('#error')).toHaveText('Injected storage failure');
  await expect(frame.locator('#stop')).toBeEnabled();
  const key=[...state.entries.keys()].find(k=>k.startsWith('session/'))!;
  expect(state.entries.get(key)!.value.count).toBe(0);
  state.failure=null;await frame.locator('#stop').click();
  await expect(frame.locator('#session-label')).toHaveText('Session stopped and saved.');
  const record=state.entries.get(key)!.value;
  expect(record.count).toBe(0);
  expect(record.summary.metrics.cpuPercent.average).toBeNull();
  expect([...state.entries.keys()].filter(k=>k.startsWith('sample/'))).toHaveLength(failure==='metadata'?1:0);
  await page.reload();
  await expect(frame.locator('#status')).toContainText('Ready.');
  await frame.locator('#view').click();
  await expect(frame.locator('#average-note')).toContainText('0 snapshots.');
  await expect(frame.locator('#status')).toContainText('no committed samples');
  await expect(frame.locator('#host-cards')).toBeHidden();
  expectNoConsoleErrors(consoleErrors);
 });
}

test('an uncommitted sample slot can be replaced and metadata failure on Stop is retryable',async({authenticatedPage:page,consoleErrors})=>{
 const {state,frame}=await setup(page);state.failure='metadata';
 await frame.locator('#start').click();
 await expect(frame.locator('#error')).toHaveText('Injected storage failure');
 state.failure=null;await frame.locator('#refresh').click();
 await expect(frame.locator('#average-note')).toContainText('1 snapshots.');
 const key=[...state.entries.keys()].find(k=>k.startsWith('session/'))!;
 expect([...state.entries.keys()].filter(k=>k.startsWith('sample/'))).toHaveLength(1);
 expect(state.entries.get(key)!.value.count).toBe(1);
 state.failure='stop';await frame.locator('#stop').click();
 await expect(frame.locator('#error')).toHaveText('Injected storage failure');
 await expect(frame.locator('#stop')).toBeEnabled();
 expect(state.entries.get(key)!.value.stoppedAt).toBeNull();
 state.failure=null;await frame.locator('#stop').click();
 await expect(frame.locator('#session-label')).toHaveText('Session stopped and saved.');
 expect(state.entries.get(key)!.value.stoppedAt).toEqual(expect.any(String));
 expectNoConsoleErrors(consoleErrors);
});

test('saved engine edits preserve identity and history and survive reload',async({authenticatedPage:page,consoleErrors})=>{
 const {state,frame}=await setup(page);
 await frame.locator('#start').click();
 await expect(frame.locator('#stop')).toBeEnabled();
 await frame.locator('#stop').click();
 await expect(frame.locator('#session-label')).toHaveText('Session stopped and saved.');
 const key=[...state.entries.keys()].find(k=>k.startsWith('session/'))!;
 const history=JSON.stringify(state.entries.get(key));
 await frame.locator('#edit').click();
 await expect(frame.locator('#name')).toHaveValue('Engine One');
 await frame.locator('#name').fill('Renamed engine');
 await frame.locator('#url').fill('https://updated.example.com');
 await frame.locator('#connection').fill('updated_engine');
 await frame.locator('#telemetry-connection').fill('host_metrics');
 await frame.locator('#save').click();
 await expect(frame.locator('#status')).toContainText('Engine saved: Renamed engine');
 expect(state.entries.get('profiles')!.value.profiles).toEqual([
  {id:'one',name:'Renamed engine',url:'https://updated.example.com',connection:'updated_engine',telemetryConnection:'host_metrics'},
  expect.objectContaining({id:'two',name:'Engine Two'}),
 ]);
 expect(JSON.stringify(state.entries.get(key))).toBe(history);
 await page.reload();
 await expect(frame.locator('#status')).toContainText('Ready.');
 await frame.locator('#engines').selectOption('one');
 await frame.locator('#edit').click();
 await expect(frame.locator('#name')).toHaveValue('Renamed engine');
 await expect(frame.locator('#url')).toHaveValue('https://updated.example.com');
 await expect(frame.locator('#connection')).toHaveValue('updated_engine');
 await expect(frame.locator('#telemetry-connection')).toHaveValue('host_metrics');
 expectNoConsoleErrors(consoleErrors);
});

test('cancelled edits never write and failed edits remain retryable',async({authenticatedPage:page,consoleErrors})=>{
 const {state,frame}=await setup(page);
 const original=JSON.stringify(state.entries.get('profiles'));
 await frame.locator('#edit').click();
 await frame.locator('#name').fill('Discarded');
 await frame.locator('#cancel-edit').click();
 await expect(frame.locator('#name')).toHaveValue('');
 expect(JSON.stringify(state.entries.get('profiles'))).toBe(original);
 await frame.locator('#edit').click();
 await frame.locator('#name').fill('Retry engine');
 state.failure='profiles';await frame.locator('#save').click();
 await expect(frame.locator('#error')).toHaveText('Injected storage failure');
 await expect(frame.locator('#save')).toBeEnabled();
 await expect(frame.locator('#name')).toHaveValue('Retry engine');
 expect(JSON.stringify(state.entries.get('profiles'))).toBe(original);
 state.failure=null;await frame.locator('#save').click();
 await expect(frame.locator('#status')).toContainText('Engine saved: Retry engine');
 expect(state.entries.get('profiles')!.value.profiles).toHaveLength(2);
 await frame.locator('#start').click();
 await expect(frame.locator('#stop')).toBeEnabled();
 await expect(frame.locator('#edit')).toBeDisabled();
 await expect(frame.locator('#save')).toBeDisabled();
 await expect(frame.locator('#name')).toBeDisabled();
 await frame.locator('#stop').click();
 await expect(frame.locator('#edit')).toBeEnabled();
 expectNoConsoleErrors(consoleErrors);
});

test('engine switch and removal clear old telemetry even when next engine read fails',async({authenticatedPage:page,consoleErrors})=>{
 const {state,frame}=await setup(page);
 await frame.locator('#refresh').click();
 await expect(frame.locator('#models')).toContainText('Only-on-One');
 await frame.locator('#engines').selectOption('two');
 await expect(frame.locator('#cards .card')).toHaveCount(0);
 await expect(frame.locator('#models')).toHaveText('No snapshot yet.');
 await expect(frame.locator('#summary tr')).toHaveCount(0);
 await expect(frame.locator('#status')).toContainText('Engine Two: no snapshot yet');
 state.offline=true;await frame.locator('#refresh').click();
 await expect(frame.locator('#error')).toHaveText('Engine offline');
 await expect(frame.locator('#models')).not.toContainText('Only-on-One');
 await frame.locator('#remove').click();
 await expect(frame.locator('#status')).toContainText('Choose an engine');
 await expect(frame.locator('#cards .card')).toHaveCount(0);
 expectNoConsoleErrors(consoleErrors);
});
