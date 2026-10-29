import { z } from 'zod';

export const connectionAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }).strict(),
  z.object({ type: z.literal('basic-token') }).strict(),
  z.object({ type: z.literal('basic'), username: z.string().min(1).optional(), usernameCredential: z.string().min(1).optional() }).strict().refine(a => Number(!!a.username) + Number(!!a.usernameCredential) === 1),
  z.object({ type: z.literal('header'), name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), prefix: z.string().default('') }).strict(),
]);
/** User consent for one HTTP API destination; ownership and credential identity are supplied by the server. */
export const apiConnectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  origin: z.string().url(),
  pathPrefix: z.string().startsWith('/').default('/'),
  auth: connectionAuthSchema,
  methods: z.array(z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE'])).min(1),
  allowInsecureHttp: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
  let u: URL; try { u = new URL(c.origin); } catch { ctx.addIssue({code:'custom',message:'Use a valid service origin'}); return; }
  if (u.origin !== c.origin || !['https:','http:'].includes(u.protocol) || u.username || u.password || (u.protocol === 'http:' && !c.allowInsecureHttp)) ctx.addIssue({code:'custom',message:'Use an HTTPS origin without a path, or explicitly allow unencrypted HTTP'});
  if (/[\\?#%\0\r\n]/.test(c.pathPrefix) || c.pathPrefix.split('/').some(p => p === '..' || p === '.')) ctx.addIssue({code:'custom',message:'Use a plain API path prefix, such as /api'});
  if (c.auth.type === 'header' && /^(?:host|cookie|content-length|transfer-encoding|connection|upgrade|proxy-authorization)$/i.test(c.auth.name)) ctx.addIssue({code:'custom',message:'This header cannot carry credentials'});
});
export type ApiConnectionConfig = z.infer<typeof apiConnectionSchema>;
