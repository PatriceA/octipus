import {z} from 'zod';

const field=z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/).refine(v=>!['__proto__','prototype','constructor'].includes(v));
const endpoint=z.string().min(1).max(1000).regex(/^\/(?!\/)[a-zA-Z0-9_/-]+$/).refine(v=>!v.includes('//')&&!v.split('/').some(p=>p==='.'||p==='..'));
/** Named fields only. No templates, scripts, arbitrary URLs or credential literals. */
export const loginTokenAuthSchema=z.object({
  type:z.literal('login-token'),
  loginPath:endpoint,
  refreshPath:endpoint.optional(),
  usernameField:field.default('username'),passwordField:field.default('password'),
  language:z.string().regex(/^[a-zA-Z_-]{2,20}$/).optional(),
  accessTokenField:field.default('access_token'),refreshTokenField:field.default('refresh_token'),
  expiresInField:field.default('expires_in'),
  refreshTokenRequestField:field.default('refreshToken'),
  sessionTtlSeconds:z.number().int().min(15).max(3600).default(240),
  csrf:z.object({query:field,header:z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).max(100)
    .refine(name=>/^X-/i.test(name)&&!/(?:authorization|cookie|host|api[-_]?key)/i.test(name))}).strict().optional(),
}).strict().superRefine((a,ctx)=>{
  if(a.usernameField===a.passwordField||[a.usernameField,a.passwordField].includes('language')&&a.language!==undefined)
    ctx.addIssue({code:'custom',message:'Login body field names must be distinct'});
  if(a.refreshPath===a.loginPath)ctx.addIssue({code:'custom',message:'Login and refresh paths must differ'});
  if(a.accessTokenField===a.refreshTokenField||a.accessTokenField===a.expiresInField||a.refreshTokenField===a.expiresInField)
    ctx.addIssue({code:'custom',message:'Token response field names must be distinct'});
});
export type LoginTokenAuth=z.infer<typeof loginTokenAuthSchema>;
