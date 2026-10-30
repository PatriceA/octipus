import { z } from 'zod';

/** A login belongs to one exact origin, not its subdomains or lookalikes. */
export const loginDomainSchema=z.string().trim().min(1).max(2048).transform((input,ctx)=>{
  try{
    const url=new URL(input.includes('://')?input:`https://${input}`);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.hostname.includes('*'))throw new Error();
    return url.origin;
  }catch{ctx.addIssue({code:'custom',message:'Use a domain or HTTP(S) origin without a path, wildcard or credentials'});return z.NEVER;}
});
export const loginRecordSchema=z.object({
  version:z.literal(1),origin:loginDomainSchema,username:z.string().min(1).max(2000),password:z.string().min(1).max(20000),allowInsecureHttp:z.boolean().default(false),
}).strict().superRefine((login,ctx)=>{if(login.origin.startsWith('http:')&&!login.allowInsecureHttp)ctx.addIssue({code:'custom',message:'Explicitly allow unencrypted HTTP for this login'});});
export type LoginRecord=z.infer<typeof loginRecordSchema>;
export const loginInputSchema=z.object({username:z.string().min(1).max(2000),password:z.string().min(1).max(20000),domain:loginDomainSchema,allowInsecureHttp:z.boolean().default(false)}).strict();
export function parseLoginRecord(value:string):LoginRecord|null {
  try{const parsed=loginRecordSchema.safeParse(JSON.parse(value));return parsed.success?parsed.data:null;}catch{return null;}
}
