import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect} from './fixtures/auth';
const ui=process.env.RELEASE_RECONCILE_UI_DIR;
test.skip(!ui,'Set RELEASE_RECONCILE_UI_DIR to the reviewed package UI.');
test('saved release targets reload into the real page and remain explicit per audit',async({authenticatedPage:page})=>{
 const base='/api/plugin-ui/release-reconcile/';
 let profile: Record<string,unknown>|undefined;
 let started: Record<string,unknown>|undefined;
 await page.route('**/api/plugin-ui',r=>r.fulfill({json:{pages:[{plugin:'release-reconcile',pluginTitle:'Release reconciliation',title:'Release audit',path:'audit',src:base+'index.html'}],dashboards:[]}}));
 await page.route('**/api/plugin-ui/release-reconcile/**',r=>{
  const url=new URL(r.request().url());const file=url.pathname.slice(base.length);const source=url.origin+base;
  return r.fulfill({body:readFileSync(join(ui!,file)),headers:{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript','access-control-allow-origin':'*','content-security-policy':`default-src 'none'; script-src ${source}; style-src ${source}; connect-src 'none'; sandbox allow-scripts`}});
 });
 await page.route('**/api/plugins/release-reconcile/call/*',r=>{
  const tool=new URL(r.request().url()).pathname.split('/').at(-1)!;
  const args=r.request().postDataJSON().args;
  let result:unknown={};
  if(tool==='profile_list') result={profiles:profile?[{id:profile.id,name:profile.name}]:[]};
  if(tool==='audit_list')result={runs:[]};
  if(tool==='profile_save'){profile=args.profile;result={saved:true,id:profile?.id};}
  if(tool==='profile_get')result={profile};
  if(tool==='audit_start'){started=args;result={runId:'fixture-run',status:'running'};}
  if(tool==='audit_status')result={status:'error',error:'Fixture stops here'};
  return r.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(result)}]}}});
 });
 await page.goto('/plugins/release-reconcile/audit');
 const frame=page.frameLocator('[data-testid="plugin-frame"]');
 const initial={id:'release-check',name:'Release check',environmentId:'env',workspaceRoot:'/work',repos:[{key:'billing-api',product:'billing',path:'billing-api',source:'develop',release:'release/2.4.0',baseline:{tag:'v2.3.0'}}],targetVersions:{billing:'2.4.0'}};
 await frame.locator('#profile-json').fill(JSON.stringify(initial));
 await frame.locator('#save').click();
 await expect(frame.locator('#v-billing')).toHaveValue('2.4.0');
 await frame.locator('#v-billing').fill('2.4.1');
 await frame.locator('#save').click();
 await expect.poll(()=>profile?.targetVersions).toEqual({billing:'2.4.1'});
 await page.reload();
 await frame.locator('#profiles').selectOption('release-check');
 await frame.locator('#load').click();
 await expect(frame.locator('#v-billing')).toHaveValue('2.4.1');
 await frame.locator('#start').click();
 await expect.poll(()=>started?.versions).toEqual({billing:'2.4.1'});
});
