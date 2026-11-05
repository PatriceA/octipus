import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import type { AgentContext } from '@/core/types';
import { isInside } from '@/security/workspace-fs';
import { maintenanceRuntime, maintenanceDirectory, runMaintenance } from './maintenance';
import { companionMaintenanceProfile } from './permissions';

/** Hash tracked and unignored source, not merely HEAD; proofs expire on edits. */
export async function maintenanceSourceFingerprint(root: string) {
  const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 8 * 1024 * 1024 });
  const hash = createHash('sha256'); let bytes = 0;
  for (const path of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    const file = join(root,path);
    let actual: string;
    try { actual=realpathSync(file); } catch { hash.update(`deleted:${path}\0`); continue; }
    if (!isInside(root,actual) || !statSync(actual).isFile()) continue;
    const data=readFileSync(actual); bytes+=data.length;
    if(bytes>128*1024*1024) throw new Error('Maintenance source exceeds verification limit');
    hash.update(`${path}\0${data.length}\0`);hash.update(data);
  }
  return hash.digest('hex');
}

export async function recordMaintenanceCheck(context: AgentContext, input: { root: string; kind: 'tests'|'build'|'activation'; command: string; activationId?: string }) {
  const runtime=maintenanceRuntime({userId:context.userId,workspaceId:context.workspaceId!});
  input.root=maintenanceDirectory({userId:context.userId,workspaceId:context.workspaceId!},input.root);
  if(!await companionMaintenanceProfile(context)) throw new Error('Unapproved maintenance source');
  if(input.kind==='activation'&&!input.activationId) throw new Error('Activation check needs a receipt');
  const fingerprint=await maintenanceSourceFingerprint(input.root);
  const result=await runMaintenance(context,{command:input.command,cwd:input.root,timeout:1800000,network:true,useShell:true});
  const unchanged=fingerprint===await maintenanceSourceFingerprint(input.root);
  const [evidence]=await getDb().insert(verificationEvidence).values({sessionId:context.sessionId,kind:'adhoc',passed:result.exitCode===0&&!result.killed&&unchanged,
    detail:{checkScope:input.kind==='activation'?`activation:${input.activationId}`:`maintenance:${input.kind}`,root:input.root,fingerprint,binding:runtime.binding,command:input.command,exitCode:result.exitCode}}).returning();
  return {evidenceId:evidence.id,passed:evidence.passed,result};
}

export async function recordMaintenanceReview(context:AgentContext,input:{root:string;passed:boolean;summary:string}) {
  const runtime=maintenanceRuntime({userId:context.userId,workspaceId:context.workspaceId!});
  input.root=maintenanceDirectory({userId:context.userId,workspaceId:context.workspaceId!},input.root);
  if(!await companionMaintenanceProfile(context)) throw new Error('Unapproved maintenance review');
  const [worker]=await getDb().select().from(agents).where(and(eq(agents.id,context.id),eq(agents.sessionId,context.sessionId),eq(agents.userId,context.userId),eq(agents.status,'running')));
  if(context.root||!worker?.parentAgentId) throw new Error('Maintenance review must come from an independent child reviewer');
  const [parent]=await getDb().select({id:agents.id}).from(agents).where(and(eq(agents.id,worker.parentAgentId),eq(agents.sessionId,context.sessionId),eq(agents.userId,context.userId)));
  if(!parent) throw new Error('Reviewer parent is unavailable');
  const [evidence]=await getDb().insert(verificationEvidence).values({sessionId:context.sessionId,kind:'adhoc',passed:input.passed,
    detail:{checkScope:'maintenance:review',root:input.root,fingerprint:await maintenanceSourceFingerprint(input.root),binding:runtime.binding,reviewer:worker.id,parent:worker.parentAgentId,summary:input.summary}}).returning();
  return {evidenceId:evidence.id,passed:evidence.passed};
}

export async function assertMaintenanceAcceptance(sessionId:string,root:string,binding:string) {
  const fingerprint=await maintenanceSourceFingerprint(root);
  const rows=await getDb().select({passed:verificationEvidence.passed,detail:verificationEvidence.detail,createdAt:verificationEvidence.createdAt}).from(verificationEvidence).where(eq(verificationEvidence.sessionId,sessionId));
  for(const scope of ['maintenance:tests','maintenance:build','maintenance:review']) {
    const matching=rows.filter(row=>{const d=row.detail as Record<string,unknown>|null;return d?.checkScope===scope&&d.root===root&&d.binding===binding&&d.fingerprint===fingerprint;}).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime());
    if(!matching[0]?.passed || matching.some(row=>!row.passed&&row.createdAt>=matching[0].createdAt)) throw new Error('Activation needs passing tests, build and independent review for the current source');
  }
  return fingerprint;
}
