import { z } from 'zod';

export const connectionTlsSchema = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('system')}).strict(),
  z.object({mode:z.literal('pinned'),certificateSha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value=>value.toLowerCase())}).strict(),
]);

/** Public routing context, never another place to enter a credential. */
export const publicConnectionHeadersSchema = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  z.string().max(2000).regex(/^[\x20-\x7e]*$/),
).superRefine((headers, ctx) => {
  const names = Object.keys(headers).map(name => name.toLowerCase());
  if (names.length > 16 || new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Use at most 16 unique public headers' });
  if (names.some(name => /^(?:authorization|proxy-authorization|cookie|set-cookie|host|content-length|transfer-encoding|connection|upgrade|trailer|te|expect)$/i.test(name) || /(?:^|[-_])(?:key|token|secret)$|^api[-_]?key$/i.test(name))) ctx.addIssue({ code: 'custom', message: 'Put authentication in the Authentication fields; request routing headers are not allowed here' });
});

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
  headers: publicConnectionHeadersSchema.optional(),
  tls: connectionTlsSchema.optional(),
  methods: z.array(z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE'])).min(1),
  allowInsecureHttp: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
  let u: URL; try { u = new URL(c.origin); } catch { ctx.addIssue({code:'custom',message:'Use a valid service origin'}); return; }
  if (u.origin !== c.origin || !['https:','http:'].includes(u.protocol) || u.username || u.password || (u.protocol === 'http:' && !c.allowInsecureHttp)) ctx.addIssue({code:'custom',message:'Use an HTTPS origin without a path, or explicitly allow unencrypted HTTP'});
  if (/[\\?#%\0\r\n]/.test(c.pathPrefix) || c.pathPrefix.split('/').some(p => p === '..' || p === '.')) ctx.addIssue({code:'custom',message:'Use a plain API path prefix, such as /api'});
  if (c.auth.type === 'header' && /^(?:host|cookie|content-length|transfer-encoding|connection|upgrade|proxy-authorization)$/i.test(c.auth.name)) ctx.addIssue({code:'custom',message:'This header cannot carry credentials'});
  const auth = c.auth;
  if (c.tls?.mode === 'pinned' && u.protocol !== 'https:') ctx.addIssue({code:'custom',message:'Certificate trust requires an HTTPS origin'});
  if (auth.type === 'header' && Object.keys(c.headers ?? {}).some(name => name.toLowerCase() === auth.name.toLowerCase())) ctx.addIssue({code:'custom',message:'The authentication header cannot also be a public header'});
});
export type ApiConnectionConfig = z.infer<typeof apiConnectionSchema>;

/** Do not echo unknown object keys or rejected values into diagnostics. */
export function apiConnectionValidationMessage(error: z.ZodError): string {
  const labels: Record<string,string> = {id:'Connection name',origin:'Server origin',pathPrefix:'Allowed path prefix',auth:'Authentication',headers:'Public request headers',tls:'TLS certificate trust',methods:'Allowed requests',allowInsecureHttp:'Unencrypted HTTP'};
  return [...new Set(error.issues.map(issue => issue.code === 'custom' ? issue.message : `${labels[String(issue.path[0])] ?? 'Connection settings'}: invalid or unsupported value`))].join('; ');
}
