import { readConnectionProfiles } from '@/security/credential-connections';
import { ToolPolicyRefusalError } from '@/core/tool-execution-error';
import { apiConnectionSchema, apiConnectionValidationMessage } from '@/shared/api-connection';
import { saveVaultApiConnection, VaultConnectionError } from '@/db/repositories/vault-api-connection';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { getVault, VaultLoginError, isReservedSecretName } from '@/security/vault';
import { apiLogger, coreLogger } from '@/utils/logger';
import { inspectConnectionCertificate,PublicCertificateDestinationError } from '@/security/connection-tls';

/** Secret names that, when changed, require a telephony provider cache reset. */
const TELEPHONY_SECRET_NAMES = new Set([
  'twilio_account_sid', 'twilio_auth_token', 'twilio_phone_number',
  'telnyx_api_key', 'telnyx_connection_id', 'telnyx_phone_number', 'telnyx_public_key',
  'plivo_auth_id', 'plivo_auth_token', 'plivo_phone_number',
]);

/** Reset telephony provider cache when a telephony credential changes. */
function resetTelephonyIfNeeded(secretName: string): void {
  if (TELEPHONY_SECRET_NAMES.has(secretName)) {
    import('@/voice/telephony').then(m => m.resetTelephonyProvider()).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in vault'));
    apiLogger.info({ secretName }, 'Telephony provider cache reset after credential change');
  }
}

const RESERVED_ERROR = 'This secret is reserved for the install itself';
const connectionParams=t.Object({id:t.String({pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'})});
const connectionQuery=t.Object({workspaceId:t.Optional(t.String({pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'}))});

/**
 * The name of credential `id` as `user` addresses it: their own row, or a
 * system row for an admin (cache invalidation after a rotate).
 */
async function credentialName(user: { id: string; isAdmin: boolean }, id: string): Promise<string | undefined> {
  const vault = getVault();
  const own = (await vault.list(user.id)).find((e) => e.id === id);
  if (own) return own.name;
  if (!user.isAdmin) return undefined;
  return (await vault.list('system')).find((e) => e.id === id)?.name;
}

export const vaultRoutes = new Elysia({ prefix: '/vault' })
  .use(apiContext)
  // List credentials (metadata only)
  .get(
    '/',
    async ({ user, query, set }) => {
      if (!user) {
        set.status=401;return { error: 'Not authenticated' };
      }

      const vault = getVault();
      const entries = await vault.list(user.id, {
        workspaceId: query.workspaceId ?? null,
      });
      // Admins also see system-level credentials, but avoid duplicates if user IS system
      const systemEntries = (user.isAdmin && user.id !== 'system') ? await vault.list('system') : [];
      let operatorProfiles: Awaited<ReturnType<typeof readConnectionProfiles>> = [];
      try { operatorProfiles = await readConnectionProfiles(); } catch { apiLogger.warn('API connection configuration unavailable while listing vault metadata'); }
      return { credentials: [...entries, ...systemEntries].filter((e) => !isReservedSecretName(e.name)).map(e => ({ ...e,
        apiConnections: [
          ...operatorProfiles.filter(p => p.http && p.userId === user.id && e.userId === user.id && p.credential === e.name && p.workspaceId === (e.scope === 'workspace' ? e.workspaceId : null)).map(p => ({ id:p.id,origin:p.http!.origin,pathPrefix:p.http!.pathPrefix,methods:p.http!.methods,managedBy:'operator' })),
          ...(apiConnectionSchema.safeParse(e.metadata?.apiConnection).success ? [{...e.metadata!.apiConnection!,managedBy:'vault'}] : []),
        ],
      })) };
    },
    {
      query: t.Object({
        workspaceId: t.Optional(t.String()),
      }),
      detail: { tags: ['vault'] },
    }
  )

  // The owner explicitly approves the destination and methods; never an agent tool.
  .put('/:id/api-connection', async ({ user, params, query, body, set }) => {
    if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
    const parsed = body === null ? { success: true as const, data: null } : apiConnectionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: `Invalid API connection settings: ${apiConnectionValidationMessage(parsed.error)}` };
    }
    try {
      return { connection: await saveVaultApiConnection(user.id, params.id, query.workspaceId ?? null, parsed.data, { allowPrivateOrigins: user.isAdmin }) };
    } catch (error) {
      if (error instanceof VaultConnectionError) { set.status = error.code === 'not_found' ? 404 : ['login_domain_required','header_reference_required'].includes(error.code) ? 400 : error.code==='public_destination_required' ? 403 : 409; return { error: error.message }; }
      if (error instanceof ToolPolicyRefusalError) { set.status = 400; return { error: 'Use connection settings only; secret values and templates are not allowed.' }; }
      apiLogger.warn({ errorClass: error instanceof Error ? error.name : 'unknown' }, 'API connection settings could not be saved');
      set.status = 503; return { error: 'API connection settings could not be saved. Please try again or check the server connection configuration.' };
    }
  }, { params: connectionParams, query: connectionQuery, body: t.Unknown(), detail: { tags: ['vault'] } })

  .post('/:id/api-certificate',async({user,params,query,body,set})=>{
    if(!user){set.status=401;return{error:'Not authenticated'};}
    const owned=(await getVault().list(user.id,{workspaceId:query.workspaceId})).find(row=>row.id===params.id&&row.isActive
      &&(row.scope==='user'||(row.scope==='workspace'&&row.workspaceId===query.workspaceId)));
    if(!owned){set.status=404;return{error:'Secret not found in this workspace'};}
    const parsed=apiConnectionSchema.safeParse({id:'inspection',origin:body.origin,pathPrefix:'/',auth:{type:'bearer'},methods:['GET'],allowInsecureHttp:false});
    if(!parsed.success||!body.origin.startsWith('https:')){set.status=400;return{error:'Use an HTTPS origin without a path or credentials'};}
    const previous=apiConnectionSchema.safeParse(owned.metadata?.apiConnection);
    const approvedInternal=owned.metadata?.apiConnectionNetwork==='operator'&&previous.success&&previous.data.origin===body.origin;
    try{return{certificate:await inspectConnectionCertificate(body.origin,{publicOnly:!user.isAdmin&&!approvedInternal})};}
    catch(error){if(error instanceof PublicCertificateDestinationError){set.status=403;return {error:error.message};}set.status=502;return{error:'Could not inspect the server certificate. Check the HTTPS address and service availability.'};}
  },{params:connectionParams,query:connectionQuery,body:t.Object({origin:t.String({minLength:1,maxLength:2048})}),detail:{tags:['vault']}})

  .put('/:id/login', async ({user,params,query,body,set}) => {
    if(!user){set.status=401;return {error:'Not authenticated'};}
    try {
      const entry=await getVault().saveLogin(user.id,body,{id:params.id,workspaceId:query.workspaceId});
      const {encryptedValue,encryptionIv,encryptionAuthTag,...safe}=entry;
      return safe;
    } catch(error) {
      if(error instanceof VaultLoginError){set.status=error.code==='not_found'?404:error.code==='duplicate_name'?409:400;return {error:error.message};}
      set.status=503;return {error:'Could not save Login settings'};
    }
  },{params:connectionParams,query:connectionQuery,body:t.Object({
    domain:t.String({minLength:1,maxLength:2048}),username:t.Optional(t.String({minLength:1,maxLength:2000})),
    password:t.Optional(t.String({minLength:1,maxLength:20000})),allowInsecureHttp:t.Optional(t.Boolean()),
  }),detail:{tags:['vault']}})

  // Create credential
  .post(
    '/',
    async ({ user, body, set }) => {
      if (!user) {
        set.status=401;return { error: 'Not authenticated' };
      }

      // System-scoped secrets are instance-wide (channel bot tokens, provider
      // keys). Only admins may write them — otherwise any user could create or
      // overwrite e.g. telegram_bot_token. Reads are already admin-only.
      if ((body.systemLevel || body.scope === 'system') && !user.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required to write a system-scoped secret' };
      }

      if (isReservedSecretName(body.name)) {
        set.status = 403;
        return { error: RESERVED_ERROR };
      }

      const vault = getVault();
      // System-level credentials (e.g. OAuth client IDs) are stored under 'system' user
      const ownerId = body.systemLevel ? 'system' : user.id;
      const scope = body.scope ?? (body.systemLevel ? 'system' : 'user');
      const workspaceId = scope === 'workspace' ? body.workspaceId ?? null : null;

      if(body.credentialType==='login'){
        if(scope==='system'||body.systemLevel){set.status=400;return {error:'Logins belong to a user or workspace'};}
        try {
          const entry=await vault.saveLogin(user.id,{name:body.name,username:body.username,password:body.password,
            domain:body.domain??'',allowInsecureHttp:body.allowInsecureHttp},
            {scope,workspaceId,description:body.description,tags:body.tags,allowedTools:body.allowedTools,
              allowedAgents:body.allowedAgents,expiresAt:body.expiresAt?new Date(body.expiresAt):undefined});
          const {encryptedValue,encryptionIv,encryptionAuthTag,...safe}=entry;
          return safe;
        }catch(error){
          if(error instanceof VaultLoginError){set.status=error.code==='duplicate_name'?409:400;return {error:error.message};}
          set.status=503;return {error:'Could not save Login settings'};
        }
      }
      if(!body.value){set.status=400;return {error:'A secret value is required'};}
      if(body.username!==undefined||body.password!==undefined||body.domain!==undefined){set.status=400;return {error:'Choose Login to save a username, password and domain'};}

      const collision=(await vault.list(ownerId,{workspaceId})).find(row=>row.name===body.name&&row.scope===scope&&(scope!=='workspace'||row.workspaceId===workspaceId));
      if(collision?.credentialType==='login'){set.status=409;return {error:'This name belongs to a Login. Use Login settings to edit it.'};}
      // Check if credential already exists — update instead of creating duplicate
      const existing = await vault.getByName(ownerId, body.name);
      if (existing !== null) {
        // Find the entry to get its ID for update
        const entries = await vault.list(ownerId);
        const existingEntry = entries.find((e) => e.name === body.name);
        if (existingEntry) {
          const updated = await vault.update(ownerId, existingEntry.id, {
            value: body.value,
            description: body.description,
            tags: body.tags,
          });
          if (updated) {
            resetTelephonyIfNeeded(body.name);
            const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = updated;
            return safe;
          }
        }
      }

      const entry = await vault.store(ownerId, body.name, body.value, {
        credentialType: body.credentialType,
        description: body.description,
        tags: body.tags,
        allowedTools: body.allowedTools,
        allowedAgents: body.allowedAgents,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        scope,
        workspaceId,
      }).catch(error=>{if(error instanceof VaultLoginError)return null;throw error;});
      if(!entry){set.status=409;return {error:'This name belongs to a Login. Use Login settings to edit it.'};}

      resetTelephonyIfNeeded(body.name);

      // Strip encryption fields
      const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = entry;

      return safe;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        value: t.Optional(t.String({ minLength: 1 })),
        username:t.Optional(t.String({minLength:1,maxLength:2000})),
        password:t.Optional(t.String({minLength:1,maxLength:20000})),
        domain:t.Optional(t.String({minLength:1,maxLength:2048})),
        allowInsecureHttp:t.Optional(t.Boolean()),
        credentialType: t.Union([
          t.Literal('api_key'),
          t.Literal('oauth_token'),
          t.Literal('password'),
          t.Literal('login'),
          t.Literal('ssh_key'),
          t.Literal('certificate'),
          t.Literal('other'),
        ]),
        description: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        allowedTools: t.Optional(t.Array(t.String())),
        allowedAgents: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
        systemLevel: t.Optional(t.Boolean()),
        scope: t.Optional(t.Union([
          t.Literal('system'),
          t.Literal('user'),
          t.Literal('workspace'),
        ])),
        workspaceId: t.Optional(t.String()),
      }),
      detail: { tags: ['vault'] },
    }
  )

  // Update credential
  .patch(
    '/:id',
    async ({ user, params, body, set }) => {
      if (!user) {
        set.status=401;return { error: 'Not authenticated' };
      }

      // The vault refuses it too; answering 403 here says why.
      if (await getVault().isReservedSystemCredential(params.id)) {
        set.status = 403;
        return { error: RESERVED_ERROR };
      }

      const vault = getVault();
      const entry = await vault.update(user.id, params.id, {
        value: body.value,
        description: body.description,
        tags: body.tags,
        allowedTools: body.allowedTools,
        allowedAgents: body.allowedAgents,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      }).catch(error=>{if(error instanceof VaultLoginError)return null;throw error;});

      if (!entry) {
        set.status=400;return { error: 'Credential not found or requires Login settings' };
      }

      resetTelephonyIfNeeded(entry.name);
      const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = entry;

      return safe;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        value: t.Optional(t.String()),
        description: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        allowedTools: t.Optional(t.Array(t.String())),
        allowedAgents: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
      }),
      detail: { tags: ['vault'] },
    }
  )

  // Delete credential
  .delete(
    '/:id',
    async ({ user, params, set }) => {
      if (!user) {
        set.status=401;return { error: 'Not authenticated' };
      }

      // The vault refuses it too; answering 403 here says why.
      if (await getVault().isReservedSystemCredential(params.id)) {
        set.status = 403;
        return { error: RESERVED_ERROR };
      }

      const vault = getVault();
      // Try user's own credentials first, then system credentials for admins
      let deleted = await vault.delete(user.id, params.id);
      if (!deleted && user.isAdmin) {
        deleted = await vault.delete('system', params.id);
      }

      if (!deleted) {
        return { error: 'Credential not found' };
      }

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['vault'] },
    }
  )

  // Rotate credential
  .post(
    '/:id/rotate',
    async ({ user, params, body, set }) => {
      if (!user) {
        set.status=401;return { error: 'Not authenticated' };
      }

      const vault = getVault();

      // Look up the credential name before rotating (for cache invalidation)
      if (await vault.isReservedSystemCredential(params.id)) {
        set.status = 403;
        return { error: RESERVED_ERROR };
      }
      const secretName = await credentialName(user, params.id);

      let rotated = await vault.rotate(user.id, params.id, body.value).catch(error=>{if(error instanceof VaultLoginError)return false;throw error;});
      if (!rotated && user.isAdmin) {
        rotated = await vault.rotate('system', params.id, body.value);
      }

      if (!rotated) {
        set.status=400;return { error: 'Credential not found or requires Login settings' };
      }

      if (secretName) resetTelephonyIfNeeded(secretName);

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        value: t.String({ minLength: 1 }),
      }),
      detail: { tags: ['vault'] },
    }
  );
