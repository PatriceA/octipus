import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import type { ExpertParameters } from '@/db/schema/experts';
import { logger } from '@/utils/logger';

const SYSTEM_EXPERTS: Array<{
  name: string;
  description: string;
  icon: string;
  role: string;
  systemPrompt?: string;
  modelPreference?: string;
  toolIds?: string[];
  skillIds?: string[];
  parameters?: ExpertParameters;
}> = [
  {
    name: 'Coder',
    description: 'Writes, refactors, and debugs code with architectural awareness.',
    icon: 'code',
    role: 'coding',
    skillIds: ['software-architecture', 'data-structures', 'database-design', 'api-design'],
  },
  {
    name: 'Reviewer',
    description: 'Reviews code for quality, security, performance, and test coverage.',
    icon: 'eye',
    role: 'review',
    skillIds: ['software-architecture', 'test-automation', 'security-practices', 'performance-engineering'],
  },
  {
    name: 'Researcher',
    description: 'Investigates topics using web search, producing thorough research reports.',
    icon: 'search',
    role: 'research',
    skillIds: ['technical-writing'],
  },
  {
    name: 'UI/UX Designer',
    description: 'Designs and evaluates user interfaces with modern design principles.',
    icon: 'palette',
    role: 'design',
    skillIds: ['design-principles', 'design-frameworks'],
  },
  {
    name: 'DevOps Engineer',
    description: 'Manages CI/CD, infrastructure, containers, and deployment automation.',
    icon: 'server',
    role: 'devops',
    skillIds: ['devops-practices', 'container-orchestration', 'cloud-platforms', 'networking'],
  },
  {
    name: 'Security Analyst',
    description: 'Assesses vulnerabilities, performs threat modeling, and hardens systems.',
    icon: 'shield',
    role: 'security',
    skillIds: ['security-practices', 'networking', 'cloud-platforms'],
  },
  {
    name: 'Data Engineer',
    description: 'Designs schemas, optimizes queries, and builds data pipelines.',
    icon: 'database',
    role: 'data',
    skillIds: ['database-design', 'data-engineering', 'performance-engineering'],
  },
  {
    name: 'AI Engineer',
    description: 'Builds AI/ML systems, RAG pipelines, and intelligent agents.',
    icon: 'brain',
    role: 'ai',
    skillIds: ['ai-engineering', 'machine-learning', 'data-structures'],
  },
  {
    name: 'QA Engineer',
    description: 'Tests applications end-to-end with automation and manual QA.',
    icon: 'check-circle',
    role: 'qa',
    skillIds: ['test-automation', 'performance-engineering'],
  },
  {
    name: 'Financial Analyst',
    description: 'Analyzes markets, investments, and financial data.',
    icon: 'trending-up',
    role: 'finance',
    skillIds: ['financial-analysis'],
  },
  {
    name: 'Automation Engineer',
    description: 'Designs workflow automations and process orchestrations.',
    icon: 'workflow',
    role: 'automation',
    skillIds: ['automation-patterns', 'devops-practices'],
  },
  {
    name: 'Project Manager',
    description: 'Plans projects, estimates effort, tracks progress, and manages risks.',
    icon: 'clipboard',
    role: 'pm',
    skillIds: ['project-management', 'technical-writing'],
  },
  {
    name: 'Technical Writer',
    description: 'Produces clear documentation, API docs, ADRs, and runbooks.',
    icon: 'book-open',
    role: 'writing',
    skillIds: ['technical-writing', 'api-design'],
  },
  {
    name: 'Communicator',
    description: 'Handles email, calendar, contacts, and documents.',
    icon: 'mail',
    role: 'communication',
  },
  {
    name: 'General',
    description: 'General-purpose assistant for everyday tasks and questions.',
    icon: 'bot',
    role: 'general',
  },
];

/**
 * Seed expert configurations into the database.
 * Idempotent — skips experts that already exist by name.
 */
export async function seedExperts(): Promise<void> {
  const db = getDb();

  for (const expert of SYSTEM_EXPERTS) {
    const existing = await db
      .select({ id: experts.id })
      .from(experts)
      .where(eq(experts.name, expert.name))
      .limit(1);

    if (existing.length > 0) {
      continue;
    }

    await db.insert(experts).values({
      name: expert.name,
      description: expert.description,
      icon: expert.icon,
      role: expert.role,
      systemPrompt: expert.systemPrompt ?? null,
      modelPreference: expert.modelPreference ?? null,
      toolIds: expert.toolIds ?? [],
      skillIds: expert.skillIds ?? [],
      parameters: expert.parameters ?? {},
      isSystem: true,
      userId: null as any,
    });

    logger.info({ expert: expert.name }, 'Seeded expert');
  }
}
