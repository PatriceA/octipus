import { afterAll,beforeAll,expect,test } from 'vitest';
import { mkdtempSync } from 'node:fs';import {tmpdir} from 'node:os';import{join}from'node:path';
process.env.MASTER_KEY??='synthetic-api-setup-master';process.env.JWT_SECRET??='synthetic-api-setup-jwt';process.env.SESSION_SECRET??='synthetic-api-setup-session';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',ws='33333333-3333-4333-8333-333333333333';
let id='',second='',workspaceSecret='';const saved=process.env.OCTIPUS_CONNECTIONS_FILE;
beforeAll(async()=>{
 process.env.STORAGE_MODE='embedded';process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'octi-vault-api-'));process.env.OCTIPUS_CONNECTIONS_FILE=join(process.env.DATA_DIR,'operator-missing.json');
 const pg=await import('@/db/postgres');await pg.initializeDb();await(await import('@/db/migrate')).runMigrations();
 await pg.queryRaw('INSERT INTO users (id,username) VALUES ($1,$2),($3,$4)',[owner,'api-owner',other,'api-other']);
 await pg.queryRaw('INSERT INTO workspaces (id,user_id,name,slug,files_dir) VALUES ($1,$2,$3,$4,$5)',[ws,owner,'API workspace','api-workspace',ws]);
 const {initializeVault,getVault}=await import('@/security/vault');await initializeVault();
 id=(await getVault().store(owner,'SONAR_API_TOKEN','SYNTHETIC_CANARY_93x',{credentialType:'api_key',metadata:{service:'preserve-me'}})).id;
 second=(await getVault().store(owner,'ANOTHER_TOKEN','SYNTHETIC_OTHER_39x',{credentialType:'api_key'})).id;
 workspaceSecret=(await getVault().store(owner,'WORKSPACE_TOKEN','WORKSPACE_CANARY',{credentialType:'api_key',scope:'workspace',workspaceId:ws})).id;
});
afterAll(async()=>{await(await import('@/db/postgres')).closeDb();if(saved===undefined)delete process.env.OCTIPUS_CONNECTIONS_FILE;else process.env.OCTIPUS_CONNECTIONS_FILE=saved;});
const config={id:'sonarqube',origin:'http://192.0.2.58',pathPrefix:'/api',auth:{type:'basic-token' as const},methods:['GET' as const],allowInsecureHttp:true};
test('an owner can approve an API destination without decrypting or rewriting the token',async()=>{
 const {saveVaultApiConnection}=await import('./vault-api-connection');const{getVault}=await import('@/security/vault');
 const before=(await getVault().list(owner)).find(e=>e.id===id)!;
 expect(await saveVaultApiConnection(owner,id,null,config,{allowPrivateOrigins:true})).toEqual(config);
 const after=(await getVault().list(owner)).find(e=>e.id===id)!;
 expect(after.accessCount).toBe(before.accessCount);expect(after.metadata?.service).toBe('preserve-me');
 expect(JSON.stringify(after.metadata)).not.toContain('SYNTHETIC_CANARY_93x');
 const{connectionFor}=await import('@/security/credential-connections');const p=await connectionFor('sonarqube',{userId:owner,workspaceId:ws});
 expect(p.credential).toBe('SONAR_API_TOKEN');expect(p.workspaceId).toBeNull();expect(p.http?.methods).toEqual(['GET']);
 await expect(connectionFor('sonarqube',{userId:other,workspaceId:ws})).rejects.toThrow(/unavailable/);
 await expect(connectionFor('sonarqube',{userId:owner,workspaceId:ws,space:{id:ws}})).rejects.toThrow(/unavailable/);
});
test('foreign owners and missing/wrong workspace context cannot change a binding',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 await expect(saveVaultApiConnection(other,id,null,config)).rejects.toMatchObject({code:'not_found'});
 await expect(saveVaultApiConnection(owner,workspaceSecret,null,{...config,id:'workspace-api'})).rejects.toMatchObject({code:'not_found'});
 await saveVaultApiConnection(owner,workspaceSecret,ws,{...config,id:'workspace-api'},{allowPrivateOrigins:true});
 const{connectionFor}=await import('@/security/credential-connections');
 await expect(connectionFor('workspace-api',{userId:owner,workspaceId:'44444444-4444-4444-8444-444444444444'})).rejects.toThrow(/unavailable/);
 expect((await connectionFor('workspace-api',{userId:owner,workspaceId:ws})).workspaceId).toBe(ws);
});
test('duplicate connection names fail and removal leaves the vault value intact',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');const{getVault}=await import('@/security/vault');
 await expect(saveVaultApiConnection(owner,second,null,config,{allowPrivateOrigins:true})).rejects.toMatchObject({code:'duplicate_name'});
 await saveVaultApiConnection(owner,id,null,null);
 expect((await getVault().list(owner)).find(e=>e.id===id)?.metadata?.service).toBe('preserve-me');
 expect(await getVault().getByName(owner,'SONAR_API_TOKEN')).toBe('SYNTHETIC_CANARY_93x');
});
test('settings cannot smuggle plaintext template expansion, ownership, Git, or MCP grants',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 await expect(saveVaultApiConnection(owner,id,null,{...config,origin:'https://{{secret:OTHER}}'})).rejects.toThrow(/credential/);
 for(const extra of [{userId:other},{credential:'OTHER_TOKEN'},{git:true},{mcpServers:['private']},{networkPolicy:'operator'}])await expect(saveVaultApiConnection(owner,id,null,{...config,...extra})).rejects.toThrow();
 await expect(saveVaultApiConnection(owner,id,null,{...config,allowInsecureHttp:false})).rejects.toThrow();
});

test('non-admin owners cannot approve host-internal or metadata-service origins',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 for(const origin of ['http://127.0.0.1:3005','http://169.254.169.254','http://192.168.200.58'])await expect(saveVaultApiConnection(owner,id,null,{...config,origin})).rejects.toMatchObject({code:'public_destination_required'});
});
test('vault names with spaces and dots are usable as exact named selectors',async()=>{
 const{getVault}=await import('@/security/vault');const{saveVaultApiConnection}=await import('./vault-api-connection');
 const token=await getVault().store(owner,'sonar.api token','SYNTHETIC_DOTTED',{credentialType:'api_key'});
 await saveVaultApiConnection(owner,token.id,null,{...config,id:'dotted-token'},{allowPrivateOrigins:true});
 const{connectionFor,resolveConnectionCredential}=await import('@/security/credential-connections');const caller={userId:owner,agentId:'test'};
 expect(await resolveConnectionCredential(await connectionFor('dotted-token',caller),caller)).toBe('SYNTHETIC_DOTTED');
});
test('ordinary owners receive a pinned public-network grant, not operator network access',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 await saveVaultApiConnection(owner,id,null,{...config,id:'public-api',origin:'https://93.184.216.34',allowInsecureHttp:false});
 const{connectionFor}=await import('@/security/credential-connections');
 expect((await connectionFor('public-api',{userId:owner})).http?.networkPolicy).toBe('public');
 const{getVault}=await import('@/security/vault');expect((await getVault().list(owner)).find(e=>e.id===id)?.metadata?.apiConnectionNetwork).toBe('public');
});

test('space secret metadata cannot be changed or inferred through personal connection naming',async()=>{
 const{getVault}=await import('@/security/vault');const{queryRaw}=await import('@/db/postgres');const{saveVaultApiConnection}=await import('./vault-api-connection');
 const shared=await getVault().store(owner,'space-row-fixture','SPACE_SYNTHETIC',{credentialType:'api_key'});
 await queryRaw("UPDATE vault SET scope='space', workspace_id=$1, metadata=$2::jsonb WHERE id=$3",[ws,JSON.stringify({apiConnection:{...config,id:'space-only-name'}}),shared.id]);
 await expect(saveVaultApiConnection(owner,shared.id,ws,config,{allowPrivateOrigins:true})).rejects.toMatchObject({code:'not_found'});
 await expect(saveVaultApiConnection(owner,second,null,{...config,id:'space-only-name'},{allowPrivateOrigins:true})).resolves.toMatchObject({id:'space-only-name'});
});

test('does not report settings saved when the authorized write no longer applies',async()=>{
 const{queryRaw}=await import('@/db/postgres');const{saveVaultApiConnection}=await import('./vault-api-connection');
 await queryRaw("CREATE FUNCTION skip_vault_api_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
 await queryRaw("CREATE TRIGGER skip_vault_api_fixture BEFORE UPDATE OF metadata ON vault FOR EACH ROW EXECUTE FUNCTION skip_vault_api_fixture()");
 try{await expect(saveVaultApiConnection(owner,id,null,{...config,id:'not-applied'},{allowPrivateOrigins:true})).rejects.toMatchObject({code:'not_found'});}
 finally{await queryRaw('DROP TRIGGER skip_vault_api_fixture ON vault');await queryRaw('DROP FUNCTION skip_vault_api_fixture()');}
});

test('a public project header survives persistence and scoped connection discovery',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 const appwrite={...config,id:'appwrite-project',origin:'https://appwrite.example.test',pathPrefix:'/v1',allowInsecureHttp:false,
  auth:{type:'header' as const,name:'X-Appwrite-Key',prefix:''},headers:{'X-Appwrite-Project':'synthetic-project'}};
 await saveVaultApiConnection(owner,id,null,appwrite,{allowPrivateOrigins:true});
 const{connectionFor}=await import('@/security/credential-connections');
 expect((await connectionFor('appwrite-project',{userId:owner})).http).toMatchObject({headers:appwrite.headers,auth:appwrite.auth});
});
test('owners can save public certificate pins and retain existing internal grants without broadening them',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');
 const pinned={...config,id:'pinned-device',origin:'https://93.184.216.34',allowInsecureHttp:false,tls:{mode:'pinned' as const,certificateSha256:'a'.repeat(64)}};
 await saveVaultApiConnection(owner,id,null,pinned);
 const{getVault}=await import('@/security/vault');expect((await getVault().list(owner)).find(e=>e.id===id)?.metadata?.apiConnectionNetwork).toBe('public');
 await saveVaultApiConnection(owner,id,null,pinned,{allowPrivateOrigins:true});
 const{connectionFor}=await import('@/security/credential-connections');
 expect((await connectionFor('pinned-device',{userId:owner})).http).toMatchObject({tls:pinned.tls,networkPolicy:'operator'});
 await saveVaultApiConnection(owner,id,null,{...pinned,tls:{mode:'system'}},{allowPrivateOrigins:true});
 expect((await connectionFor('pinned-device',{userId:owner})).http?.tls?.mode).toBe('system');
 const internal={...pinned,origin:'https://192.168.1.10:8006'};
 await saveVaultApiConnection(owner,id,null,{...internal,tls:{mode:'system'}},{allowPrivateOrigins:true});
 await saveVaultApiConnection(owner,id,null,internal);
 expect((await connectionFor('pinned-device',{userId:owner})).http).toMatchObject({networkPolicy:'operator',tls:internal.tls});
 for(const changed of [{...internal,origin:'https://192.168.1.11:8006'},{...internal,methods:['GET','POST','DELETE'] as const},{...internal,pathPrefix:'/'},{...internal,auth:{type:'bearer' as const}}])await expect(saveVaultApiConnection(owner,id,null,changed as typeof internal)).rejects.toMatchObject({code:'public_destination_required'});

});

test('Login API consent requires the encrypted entry domain and Login authentication',async()=>{
 const {getVault}=await import('@/security/vault');const {saveVaultApiConnection}=await import('./vault-api-connection');
 const row=await getVault().saveLogin(owner,{name:'basic-login',domain:'http://192.168.200.58',allowInsecureHttp:true,username:'canary-user',password:'canary-password'});
 const settings={...config,id:'saved-login',origin:'http://192.168.200.58',auth:{type:'login' as const}};
 await expect(saveVaultApiConnection(owner,row.id,null,{...settings,origin:'http://192.168.200.59'},{allowPrivateOrigins:true})).rejects.toMatchObject({code:'login_domain_required'});
 await expect(saveVaultApiConnection(owner,row.id,null,{...settings,auth:{type:'bearer'}},{allowPrivateOrigins:true})).rejects.toMatchObject({code:'login_domain_required'});
 await expect(saveVaultApiConnection(owner,second,null,settings,{allowPrivateOrigins:true})).rejects.toMatchObject({code:'login_domain_required'});
 await saveVaultApiConnection(owner,row.id,null,settings,{allowPrivateOrigins:true});
 const {connectionFor}=await import('@/security/credential-connections');expect((await connectionFor('saved-login',{userId:owner})).http?.auth.type).toBe('login');
});

test('two-entry authentication header templates remain named references in durable settings',async()=>{
 const{saveVaultApiConnection}=await import('./vault-api-connection');const{getVault}=await import('@/security/vault');
 const template={...config,id:'two-entry-header',auth:{type:'header-template' as const,name:'Authorization',template:'Prefix=<SONAR_API_TOKEN>=<ANOTHER_TOKEN>'}};
 await saveVaultApiConnection(owner,id,null,template,{allowPrivateOrigins:true});
 const stored=(await getVault().list(owner)).find(row=>row.id===id);
 expect(stored?.metadata?.apiConnection?.auth).toEqual(template.auth);
 expect(JSON.stringify(stored)).not.toContain('SYNTHETIC_CANARY_93x');expect(JSON.stringify(stored)).not.toContain('SYNTHETIC_OTHER_39x');
 await expect(saveVaultApiConnection(owner,id,null,{...template,auth:{...template.auth,template:'Prefix=<UNRELATED>=<ANOTHER_TOKEN>'}},{allowPrivateOrigins:true})).rejects.toMatchObject({code:'header_reference_required'});
});
