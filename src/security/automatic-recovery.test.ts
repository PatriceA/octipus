import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { userRepository } from '@/db/repositories/user-repository';
import { automaticRecoveryAllowed } from './automatic-recovery';
const userId=randomUUID();
afterEach(()=>vi.restoreAllMocks());
test('automatic recovery requires an active local account that explicitly enabled it',async()=>{
 const lookup=vi.spyOn(userRepository,'findById');
 for(const row of [null,{isActive:true,kind:'local',preferences:{}},{isActive:false,kind:'local',preferences:{autoApproveRecovery:true}},{isActive:true,kind:'remote',preferences:{autoApproveRecovery:true}}]){
  lookup.mockResolvedValue(row as never);
  expect(await automaticRecoveryAllowed({userId,space:null,trigger:'user'})).toBe(false);
 }
 lookup.mockResolvedValue({isActive:true,kind:'local',preferences:{autoApproveRecovery:true}} as never);
 expect(await automaticRecoveryAllowed({userId,space:null,trigger:'user'})).toBe(true);
 expect(lookup).toHaveBeenLastCalledWith(userId);
});
test('personal recovery consent never applies to shared or remote runs',async()=>{
 const lookup=vi.spyOn(userRepository,'findById');
 for(const context of [{userId,space:{}},{userId,trigger:'remote'},{userId,audienceFederated:true},{userId:'system'}]){
  expect(await automaticRecoveryAllowed(context as never)).toBe(false);
 }
 expect(lookup).not.toHaveBeenCalled();
});
