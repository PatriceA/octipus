import { expect, test } from 'vitest';
import { companionBudgetResponse, companionControllerLimits } from './turn-limits';

test('interactive Companion chats inherit normal configured limits, including unlimited budgets', () => {
  expect(companionControllerLimits('user', 16_000)).toEqual({ maxTokenBudget: undefined, maxIterations: undefined });
});
test('unattended controller turns keep their configured caps and bounded iterations', () => {
  expect(companionControllerLimits('monitor', 16_000)).toEqual({ maxTokenBudget: 16_000, maxIterations: 12 });
});
test('an allocated execution reservation remains enforced in either kind of turn', () => {
  expect(companionControllerLimits('user', 16_000, 7_000).maxTokenBudget).toBe(7_000);
  expect(companionControllerLimits('monitor', 16_000, 7_000).maxTokenBudget).toBe(7_000);
});


test('background defaults have headroom for multi-call session inspection and validation permits higher limits',async()=>{
 const {companionSettingsSchema,COMPANION_TOKEN_LIMITS}=await import('@/shared/companion-supervision');
 const defaults=companionSettingsSchema.parse({});
 expect(defaults.turnTokenBudget).toBe(1_000_000);expect(defaults.dailyTokenBudget).toBe(10_000_000);
 expect(companionControllerLimits('monitor',defaults.turnTokenBudget).maxTokenBudget).toBeGreaterThan(135312);
 expect(companionSettingsSchema.parse({turnTokenBudget:5_000_000,dailyTokenBudget:50_000_000}).turnTokenBudget).toBe(5_000_000);
 expect(companionSettingsSchema.safeParse({turnTokenBudget:COMPANION_TOKEN_LIMITS.turnMax+1}).success).toBe(false);
});
test('a budget stop names the limit and settings, rather than claiming the owner stopped work',async()=>{
 const {BudgetExceededError}=await import('@/core/swarm/errors');
 const response=companionBudgetResponse(new BudgetExceededError({agentId:'supervisor',used:135312,cap:100000}),'monitor');
 expect(response).toContain('135312/100000');expect(response).toContain('Resource limits');
 expect(response).not.toContain('Task was stopped');expect(companionBudgetResponse(new Error('stopped by user'),'user')).toBeNull();
});

test('interactive Companion budget errors explain the normal agent limit',async()=>{
 const {BudgetExceededError}=await import('@/core/swarm/errors');
 const response=companionBudgetResponse(new BudgetExceededError({agentId:'direct-chat',used:1100,cap:1000}),'user');
 expect(response).toContain('normal agent token budget');expect(response).not.toContain('Resource limits to adjust');
});
