import { CompanionSupervisionRepository } from '@/db/repositories/companion-supervision-repository';
import type { CompanionScope } from '@/shared/companion-supervision';

/** Durable responsibility only. Starting/stopping execution requires the M2 dispatcher. */
export class CompanionService {
  private readonly repo: CompanionSupervisionRepository;
  constructor(scope: CompanionScope, repo?: CompanionSupervisionRepository) {
    this.repo = repo ?? new CompanionSupervisionRepository(scope);
    if (this.repo.scope.userId !== scope.userId || this.repo.scope.workspaceId !== scope.workspaceId) throw new Error('Companion repository scope mismatch');
  }
  createGoal(input: unknown) { return this.repo.create(input); }
  listGoals(limit?: number) { return this.repo.list(limit); }
  readGoal(id: string) { return this.repo.read(id); }
  adoptExecution(id: string, input: unknown) { return this.repo.adopt(id, input); }
  updateGoal(id: string, input: unknown) { return this.repo.update(id, input); }
}
