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
 const initial={id:'release-check',name:'Release check',environmentId:'env',workspaceRoot:'/work',ticketProjects:['ABC'],tracker:{connection:'tracker',kind:'jira-cloud',versionFormat:'{product}: v.{version}'},repos:[{key:'billing-api',product:'billing',path:'billing-api',source:'develop',release:'release/2.4.0',baseline:{tag:'v2.3.0'}}],targetVersions:{billing:'2.4.0'}};
 await frame.getByText('Advanced profile JSON',{exact:true}).click();
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

test('a new release profile uses discovered repositories and refs without editing JSON or identifiers',async({authenticatedPage:page})=>{
 const base='/api/plugin-ui/release-reconcile/';
 let profile: Record<string,unknown>|undefined;
 await page.route('**/api/plugin-ui',r=>r.fulfill({json:{pages:[{plugin:'release-reconcile',pluginTitle:'Release reconciliation',title:'Release audit',path:'audit',src:base+'index.html'}],dashboards:[]}}));
 await page.route('**/api/plugin-ui/release-reconcile/**',r=>{
  const url=new URL(r.request().url());const file=url.pathname.slice(base.length);const source=url.origin+base;
  return r.fulfill({body:readFileSync(join(ui!,file)),headers:{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript','access-control-allow-origin':'*','content-security-policy':`default-src 'none'; script-src ${source}; style-src ${source}; connect-src 'none'; sandbox allow-scripts`}});
 });
 await page.route('**/api/plugins/release-reconcile/call/*',r=>{
  const tool=new URL(r.request().url()).pathname.split('/').at(-1)!;const args=r.request().postDataJSON().args;let result:unknown={};
  if(tool==='profile_resources')result=args.repository?{branches:['develop','release/2.4.0'],tags:['v2.3.0'],remotePath:'/group/billing-api.git'}:args.root?{repositories:[{name:'billing-api',path:'/work/billing-api'}],truncated:false}:{environments:[{id:'hidden-env-id',name:'Workstation',roots:['/work']}],connections:['tracker','git','forge']};
  if(tool==='profile_list')result={profiles:profile?[{id:profile.id,name:profile.name}]:[]};
  if(tool==='audit_list')result={runs:[]};if(tool==='profile_save'){profile=args.profile;result={saved:true,id:profile?.id};}if(tool==='profile_get')result={profile};
  return r.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(result)}]}}});
 });
 await page.goto('/plugins/release-reconcile/audit');const frame=page.frameLocator('[data-testid="plugin-frame"]');
 await frame.getByRole('button',{name:'New profile',exact:true}).click();
 await frame.getByLabel('Profile name', {exact:true}).fill('Billing release');
 await frame.getByLabel('Issue tracker connection').selectOption('tracker');
 await frame.getByLabel('Git connection (for fresh audit refs)').selectOption('git');
 await frame.getByLabel('Project keys').fill('ABC');
 await frame.getByRole('button',{name:'Find repositories',exact:true}).click();
 await frame.getByLabel('Repository to add').selectOption('/work/billing-api');
 await frame.getByRole('button',{name:'Add repository',exact:true}).click();
 await frame.getByLabel('Product name').fill('billing');
 await frame.getByLabel('Release branch',{exact:true}).selectOption('release/2.4.0');
 await frame.getByLabel('Previous release tag').selectOption('v2.3.0');
 await frame.getByLabel('Target version',{exact:true}).fill('2.4.0');
 await frame.getByRole('button',{name:'Save profile',exact:true}).click();
 await expect.poll(()=>profile?.targetVersions).toEqual({billing:'2.4.0'});
 expect(profile?.environmentId).toBe('hidden-env-id');
 expect(profile?.repos).toMatchObject([{path:'billing-api',source:'develop',release:'release/2.4.0',baseline:{tag:'v2.3.0'},fetch:{connection:'git',remotePath:'/group/billing-api.git'}}]);
});
