import { registerCommand } from './registry';

registerCommand({
  name: 'experts',
  description: 'List available expert personas',
  async execute() {
    try {
      const { getDb } = await import('@/db/postgres');
      const { experts } = await import('@/db/schema/experts');
      const db = getDb();
      const allExperts = await db.select({
        name: experts.name,
        role: experts.role,
        description: experts.description,
        isSystem: experts.isSystem,
      }).from(experts);

      if (allExperts.length === 0) {
        return { response: 'No experts configured. Add experts via the web UI or API.' };
      }

      const rows = allExperts.map(e =>
        `| ${e.name} | ${e.role} | ${(e.description || '').slice(0, 60)} | ${e.isSystem ? 'System' : 'Custom'} |`
      ).join('\n');

      return {
        response: [
          `**Available Experts** (${allExperts.length})\n`,
          '| Name | Role | Description | Type |',
          '|------|------|-------------|------|',
          rows,
          '',
          'To chat with a specific expert, select them in the Experts panel.',
        ].join('\n'),
      };
    } catch {
      return { response: 'Failed to load experts. Check the backend logs.' };
    }
  },
});
