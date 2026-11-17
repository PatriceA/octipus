import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import { HASH, perms, preview, consentView } from './fixtures/plugin-consent';
import type { PluginSetupConfiguration, PluginSetupDraft } from '../../src/shared/plugin-setup';

async function scenario(page: Page, options: { installed?: boolean; loseReply?: boolean } = {}) {
  await stubAllDefaults(page);
  const configuration: PluginSetupConfiguration = { fields: [{ key: 'folders', label: 'Repositories', type: 'text', required: true }, { key: 'connections', label: 'Connections', type: 'text', required: true }, { key: 'level', label: 'Evidence classification', type: 'select', options: ['1','2','3','4'], required: true }], resources: [{ setting: 'folders', kind: 'folder', multiple: true }, { setting: 'connections', kind: 'connection', multiple: true }, { setting: 'level', kind: 'protection' }], secrets: [{ key: 'API_TOKEN', label: 'Service credential', required: true, configured: !!options.installed }], settings: options.installed ? { folders: '/projects', connections: 'tracker', level: '1' } : {}, maxProtection: 1, check: { tool: 'health' }, installed: !!options.installed, enabled: !!options.installed };
  const summary=perms('guided-test');
  const state = { installs: 0, consents: 0, tests: 0, draft: null as PluginSetupDraft | null, payload: null as Record<string, unknown> | null, installed: !!options.installed };
  await page.route(/\/api\/plugin-packages(\/.*)?(\?.*)?$/, async route => {
    const path=new URL(route.request().url()).pathname.replace('/api/plugin-packages','');
    const body=route.request().postData()?route.request().postDataJSON():undefined;
    if(path==='/preview') return json(route,200,preview(summary,{configuration:{...configuration,installed:state.installed}}));
    if(path==='/setup/resources') return json(route,200,{environments:[{id:'private-env-id',name:'Workstation',backend:'host',roots:['/projects']}],connections:[{id:'tracker',origin:'https://example.com',pathPrefix:'/api',git:false}]});
    if(path==='/setup/guided-test/draft') {
      if(route.request().method()==='GET') return json(route,200,{draft:state.draft});
      expect(JSON.stringify(body)).not.toContain('SYNTHETIC_PASSWORD');
      state.draft={contentHash:HASH,settings:body.settings,revision:(state.draft?.revision??0)+1,stage:body.stage,updatedAt:new Date().toISOString()};
      return json(route,200,{draft:state.draft});
    }
    if(path==='/setup/guided-test/preflight') return body.settings.level==='1'?json(route,200,{ok:true}):json(route,409,{error:'Keep the classification; this interface only supports level 1.'});
    if(path==='/install') {state.installs++;state.payload=body;state.installed=true;if(options.loseReply)return json(route,502,{error:'Response lost after installation'});return json(route,200,{name:'guided-test',version:'1.0.0',contentHash:HASH,enabled:true,enableProblem:null,warnings:[]});}
    if(path==='/guided-test/consent') {
      if(route.request().method()==='GET')return json(route,200,consentView(summary,{configuration:{...configuration,installed:true,secrets:[{...configuration.secrets[0],configured:true}]},declarations:preview(summary).declarations.map(i=>({...i,carried:true}))}));
      state.consents++;return json(route,200,{name:'guided-test',version:'1.0.0',contentHash:HASH,enabled:true,enableProblem:null,warnings:[]});
    }
    if(path==='/setup/guided-test/check'){state.tests++;return json(route,200,{ok:state.tests>1,message:state.tests>1?'Service verified':'Service unavailable. Retry when it is reachable.',checkedAt:new Date().toISOString()});}
    if(path==='/sandbox')return json(route,200,{setting:'required',runner:'bwrap',unavailable:null,platform:'linux',summary:'active runner bwrap'});
    return json(route,200,[]);
  });
  await page.goto('/admin/plugins');
  await page.getByLabel('Package directory or https URL').fill('/projects/guided-test');
  await page.getByRole('form',{name:'Install a plugin package'}).getByRole('button',{name:'Install',exact:true}).click();
  const dialog=page.getByTestId('plugin-consent');
  await expect(dialog.getByRole('button',{name:'Continue to review'})).toBeEnabled();
  return {state,dialog};
}

test('one guided setup checks compatibility, saves no secret in drafts, and retries only the connection test',async({authenticatedPage:page})=>{
 const {state,dialog}=await scenario(page);
 await dialog.getByRole('checkbox',{name:'/projects',exact:true}).check();
 await dialog.getByRole('checkbox',{name:'tracker · https://example.com'}).check();
 await dialog.getByLabel('Evidence classification').selectOption('2');
 await dialog.getByLabel('Service credential').fill('SYNTHETIC_PASSWORD');
 await dialog.getByRole('button',{name:'Continue to review'}).click();
 await expect(dialog.getByRole('alert')).toContainText('Keep the classification');expect(state.installs).toBe(0);
 await dialog.getByLabel('Evidence classification').selectOption('1');
 await dialog.getByRole('button',{name:'Continue to review'}).click();
 await dialog.getByRole('checkbox',{name:'Approve all required access described below for this package'}).check();
 await dialog.getByRole('button',{name:'Install',exact:true}).click();
 await expect(dialog).toContainText('Service unavailable');
 expect(state.installs).toBe(1);expect(state.payload?.secrets).toEqual({API_TOKEN:'SYNTHETIC_PASSWORD'});
 await dialog.getByRole('button',{name:'Retry connection test'}).click();
 await expect(dialog).toContainText('Service verified');expect(state.installs).toBe(1);expect(state.tests).toBe(2);
 await dialog.getByRole('button',{name:'Done',exact:true}).click();await expect(dialog).toHaveCount(0);
});

test('same installed content resumes configuration without another installation',async({authenticatedPage:page})=>{
 const {state,dialog}=await scenario(page,{installed:true});
 await dialog.getByRole('button',{name:'Continue to review'}).click();
 await dialog.getByRole('checkbox',{name:'Approve all required access described below for this package'}).check();
 await dialog.getByRole('button',{name:'Apply and enable',exact:true}).click();
 await expect(dialog).toContainText('Service unavailable');expect(state.installs).toBe(0);expect(state.consents).toBe(1);
});


test('a lost response is reconciled before retrying and never installs the same package twice',async({authenticatedPage:page})=>{
 const {state,dialog}=await scenario(page,{loseReply:true});
 await dialog.getByRole('checkbox',{name:'/projects',exact:true}).check();
 await dialog.getByRole('checkbox',{name:'tracker · https://example.com'}).check();
 await dialog.getByLabel('Evidence classification').selectOption('1');
 await dialog.getByLabel('Service credential').fill('SYNTHETIC_PASSWORD');
 await dialog.getByRole('button',{name:'Continue to review'}).click();
 await dialog.getByRole('checkbox',{name:'Approve all required access described below for this package'}).check();
 await dialog.getByRole('button',{name:'Install',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Install',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'Check whether installation already finished'}).click();
 await expect(dialog.getByRole('button',{name:'Continue to review'})).toBeEnabled();
 await dialog.getByRole('button',{name:'Continue to review'}).click();
 await dialog.getByRole('button',{name:'Apply and enable',exact:true}).click();
 await expect(dialog).toContainText('Service unavailable');
 expect(state.installs).toBe(1);expect(state.consents).toBe(1);
});
