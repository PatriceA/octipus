import {z} from 'zod';

/** References are allowed only in the dedicated authentication-header field. */
export function headerTemplateReferences(template:string):string[]{
  if(/\{\{|\$\{/.test(template)||template.length>2000||/[\x00-\x1f\x7f-\uffff]/.test(template))throw new Error('Use a printable authentication header template');
  const references=[...template.matchAll(/<([^<>]+)>/g)].map(match=>match[1]);
  if(references.length!==2||new Set(references).size!==2||references.some(name=>name.trim()!==name||! /^[a-zA-Z0-9_ .-]{1,128}$/.test(name))
    ||/[<>]/.test(template.replace(/<([^<>]+)>/g,'')))throw new Error('Use exactly two different vault entry names in <NAME> references');
  return references;
}
export const headerTemplateAuthSchema=z.object({
  type:z.literal('header-template'),
  name:z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  template:z.string().max(2000),
}).strict().superRefine((auth,ctx)=>{
  try{headerTemplateReferences(auth.template);}catch{ctx.addIssue({code:'custom',message:'Use exactly two named vault references, for example Prefix=<ENTRY_ID>=<ENTRY_SECRET>'});}
});
export function renderHeaderTemplate(template:string,values:ReadonlyMap<string,string>):string{
  headerTemplateReferences(template);
  return template.replace(/<([^<>]+)>/g,(_match,name:string)=>{
    const value=values.get(name);if(value===undefined)throw new Error('Authentication header credential unavailable');return value;
  });
}
