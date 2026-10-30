import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('secrets / vault page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
    await authenticatedPage.route('**/api/secrets**', (route) =>
      json(route, 200, {
        secrets: [
          { key: 'OPENAI_API_KEY', masked: 'sk-***', provider: 'openai' },
          { key: 'ANTHROPIC_API_KEY', masked: 'ak-***', provider: 'anthropic' },
        ],
      }),
    );
  });

  test('page renders', async ({ authenticatedPage: page }) => {
    await page.goto('/secrets');
    await expect(page.locator('body')).toContainText(/secret|vault|key/i, { timeout: 10_000 });
  });

  test('secret values are masked', async ({ authenticatedPage: page }) => {
    await page.goto('/secrets');
    const body = await page.locator('body').textContent();
    expect(body).not.toContain('sk-FULLKEYHERE');
  });
});

 test('a stored API token can be connected without re-entering or exposing its value', async ({ authenticatedPage: page }) => {
   const secret={id:'11111111-1111-4111-8111-111111111111',name:'SONAR_API_TOKEN',scope:'user',credentialType:'api_key',tags:[],accessCount:'0',allowedAgents:[],isActive:true,metadata:{},apiConnections:[] as unknown[]};
   let settings:Record<string,unknown>|null=null;
   await page.route('**/api/vault?*',route=>json(route,200,{credentials:[secret]}));
   await page.route('**/api/vault',route=>json(route,200,{credentials:[secret]}));
   await page.route('**/api/vault/*/api-connection*',async route=>{
     settings=route.request().postDataJSON();secret.metadata={apiConnection:settings};secret.apiConnections=[{...settings,managedBy:'vault'}];await json(route,200,{connection:settings});
   });
   await page.goto('/secrets');
   await expect(page.getByText(/save the secret, choose/i)).toBeVisible();
   await page.getByRole('button',{name:'Connect API for SONAR_API_TOKEN'}).click();
   await page.getByLabel('Connection name',{exact:true}).fill('sonarqube');
   await page.getByLabel('Server origin',{exact:true}).fill('http://192.0.2.58');
   await page.getByLabel('Allowed path prefix',{exact:true}).fill('/api');
   await page.getByLabel('Authentication',{exact:true}).selectOption('basic-token');
   await expect(page.getByLabel('GET',{exact:true})).toBeChecked();await expect(page.getByLabel('POST',{exact:true})).not.toBeChecked();
   await expect(page.getByRole('button',{name:'Save API connection'})).toBeDisabled();
   await page.getByLabel(/Allow unencrypted HTTP/).check();
   await page.getByRole('button',{name:'Save API connection'}).click();
   await expect(page.getByRole('status')).toContainText('API connection sonarqube saved');
   expect(settings).toMatchObject({id:'sonarqube',origin:'http://192.0.2.58',pathPrefix:'/api',methods:['GET'],auth:{type:'basic-token'},allowInsecureHttp:true});
   expect(JSON.stringify(settings)).not.toContain('value');
   await expect(page.locator('body')).not.toContainText('SYNTHETIC_SECRET_VALUE');
   await expect(page.getByText('API: sonarqube · GET /api')).toBeVisible();
 });

test('saving a new token offers the API setup step immediately', async ({ authenticatedPage: page }) => {
  const secret={id:'22222222-2222-4222-8222-222222222222',name:'NEW_API_TOKEN',scope:'user',credentialType:'api_key',tags:[],accessCount:'0',allowedAgents:[],isActive:true,metadata:{},apiConnections:[]};
  let stored=false;let secretPayload:Record<string,unknown>|null=null;
  await page.route('**/api/vault?*',route=>json(route,200,{credentials:stored?[secret]:[]}));
  await page.route('**/api/vault',async route=>{if(route.request().method()==='POST'){secretPayload=route.request().postDataJSON();stored=true;await json(route,200,secret);}else await json(route,200,{credentials:stored?[secret]:[]});});
  await page.goto('/secrets');await page.getByRole('button',{name:'Add Secret',exact:true}).click();
  await page.getByPlaceholder('my_api_key',{exact:true}).fill('NEW_API_TOKEN');
  await page.getByLabel('Value',{exact:true}).fill('SYNTHETIC_SECRET_VALUE');
  await expect(page.getByLabel(/Set up API access after saving/)).toBeChecked();
  await page.getByRole('button',{name:'Save secret & set up API'}).click();
  await expect(page.getByRole('heading',{name:'connect api',exact:true})).toBeVisible();
  await expect(page.getByLabel('Server origin',{exact:true})).toBeVisible();
  expect(secretPayload).toMatchObject({name:'NEW_API_TOKEN',value:'SYNTHETIC_SECRET_VALUE'});
  await expect(page.getByLabel('Value',{exact:true})).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('SYNTHETIC_SECRET_VALUE');
});

test('Appwrite setup uses key authentication, public project context and validates before saving', async ({ authenticatedPage: page }) => {
  const secret={id:'11111111-1111-4111-8111-111111111111',name:'APPWRITE_API_KEY',scope:'user',credentialType:'api_key',tags:[],accessCount:'0',allowedAgents:[],isActive:true,metadata:{},apiConnections:[]};
  let settings:Record<string,unknown>|null=null;
  await page.route('**/api/vault?*',route=>json(route,200,{credentials:[secret]}));
  await page.route('**/api/vault',route=>json(route,200,{credentials:[secret]}));
  await page.route('**/api/vault/*/api-connection*',async route=>{settings=route.request().postDataJSON();await json(route,200,{connection:settings});});
  await page.goto('/secrets');
  await page.getByRole('button',{name:'Connect API for APPWRITE_API_KEY'}).click();
  await page.getByLabel('Server origin',{exact:true}).fill('https://appwrite.example.com/v1');
  await page.getByRole('button',{name:'Save API connection'}).click();
  await expect(page.getByRole('alert')).toContainText('without a path');
  expect(settings).toBeNull();
  await page.getByText('Appwrite setup help',{exact:true}).click();
  await page.getByRole('button',{name:'Use Appwrite settings'}).click();
  await expect(page.getByLabel('Server origin',{exact:true})).toHaveValue('https://appwrite.example.com');
  await expect(page.getByLabel('Allowed path prefix',{exact:true})).toHaveValue('/v1');
  await expect(page.getByLabel('Authentication',{exact:true})).toHaveValue('header');
  await expect(page.getByLabel('Header name',{exact:true})).toHaveValue('X-Appwrite-Key');
  await expect(page.getByLabel('Header prefix (optional)',{exact:true})).toHaveValue('');
  await page.getByLabel('Public header 1 value',{exact:true}).fill('synthetic-project');
  await page.getByRole('button',{name:'Save API connection'}).click();
  await expect(page.getByRole('status')).toContainText('API connection appwrite saved');
  expect(settings).toMatchObject({origin:'https://appwrite.example.com',pathPrefix:'/v1',auth:{type:'header',name:'X-Appwrite-Key',prefix:''},headers:{'X-Appwrite-Project':'synthetic-project'},methods:['GET']});
});

test('trusting a device certificate requires inspection and consent, and changing origin clears it', async ({ authenticatedPage: page }) => {
 const secret={id:'11111111-1111-4111-8111-111111111111',name:'OPNsense_SECRET',scope:'user',credentialType:'api_key',tags:[],accessCount:'0',allowedAgents:[],isActive:true,metadata:{},apiConnections:[]};
 let settings:Record<string,unknown>|null=null;
 await page.route('**/api/vault?*',route=>json(route,200,{credentials:[secret]}));
 await page.route('**/api/vault',route=>json(route,200,{credentials:[secret]}));
 await page.route('**/api/vault/*/api-connection*',async route=>{settings=route.request().postDataJSON();await json(route,200,{connection:settings});});
 await page.route('**/api/vault/*/api-certificate*',route=>json(route,200,{certificate:{origin:'https://192.0.2.1',certificateSha256:'a'.repeat(64),commonName:'synthetic-device',issuer:'synthetic-device',validFrom:'Jan 1 2012 GMT',validTo:'Feb 1 2013 GMT',verificationError:'CERT_HAS_EXPIRED'}}));
 await page.goto('/secrets');await page.getByRole('button',{name:'Connect API for OPNsense_SECRET'}).click();
 await page.getByLabel('Connection name',{exact:true}).fill('opnsense');
 await page.getByLabel('Server origin',{exact:true}).fill('https://192.0.2.1');
 await expect(page.getByLabel('Certificate trust',{exact:true})).toHaveValue('system');
 await page.getByLabel('Authentication',{exact:true}).selectOption('basic');
 await page.getByLabel('Or username vault entry',{exact:true}).fill('OPNsense_KEY');
 await page.getByLabel('Certificate trust',{exact:true}).selectOption('pinned');
 await expect(page.getByRole('button',{name:'Save API connection'})).toBeDisabled();
 await page.getByRole('button',{name:'Inspect server certificate'}).click();
 await expect(page.getByText(/CERT_HAS_EXPIRED/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Save API connection'})).toBeDisabled();
 await page.getByLabel(/I trust this exact certificate/).check();
 await expect(page.getByRole('button',{name:'Save API connection'})).toBeEnabled();
 await page.getByLabel('Server origin',{exact:true}).fill('https://other-device.example.com');
 await expect(page.getByLabel('Certificate trust',{exact:true})).toHaveValue('system');
 await expect(page.getByLabel(/I trust this exact certificate/)).toHaveCount(0);
 await page.getByLabel('Server origin',{exact:true}).fill('https://192.0.2.1');
 await page.getByLabel('Certificate trust',{exact:true}).selectOption('pinned');
 await page.getByRole('button',{name:'Inspect server certificate'}).click();
 await page.getByLabel(/I trust this exact certificate/).check();
 await page.getByRole('button',{name:'Save API connection'}).click();
 await expect(page.getByRole('status')).toContainText('API connection opnsense saved');
 expect(settings).toMatchObject({id:'opnsense',tls:{mode:'pinned',certificateSha256:'a'.repeat(64)},auth:{type:'basic',usernameCredential:'OPNsense_KEY'}});
 expect(JSON.stringify(settings)).not.toContain('SYNTHETIC_TLS_CANARY');
});
