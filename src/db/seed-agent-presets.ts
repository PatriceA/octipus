import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { presets } from '@/db/schema/presets';
import type { PresetParameters } from '@/db/schema/presets';
import { logger } from '@/utils/logger';

/**
 * Preset agent configurations that ship out-of-the-box.
 * These are inserted with isSystem=true and no userId (available to all users).
 */
const AGENT_PRESETS: Array<{
  name: string;
  description: string;
  icon: string;
  role: string;
  systemPrompt?: string;
  modelPreference?: string;
  skillIds?: string[];
  parameters?: PresetParameters;
}> = [
  {
    name: 'Researcher',
    description: 'Investigates topics using web search and browsing, producing thorough research reports.',
    icon: 'search',
    role: 'research',
  },
  {
    name: 'Coder',
    description: 'Writes, refactors, and debugs code using filesystem and shell tools.',
    icon: 'code',
    role: 'coding',
  },
  {
    name: 'Reviewer',
    description: 'Reviews code for quality, security, performance, and best practices.',
    icon: 'eye',
    role: 'review',
  },
  {
    name: 'Summarizer',
    description: 'Condenses content into clear, structured summaries with key takeaways.',
    icon: 'file-text',
    role: 'general',
    systemPrompt:
      'You are a summarization specialist. Condense content into clear, structured summaries highlighting key facts, insights, and actionable takeaways. Use bullet points and headers for readability.',
  },
  {
    name: 'Data Analyst',
    description: 'Analyzes data sets, identifies trends, and produces analytical reports.',
    icon: 'bar-chart',
    role: 'research',
    systemPrompt:
      'You are a data analysis specialist. Analyze data sets, identify trends and patterns, create visualizations, and produce clear analytical reports with actionable insights.',
  },
  {
    name: 'General',
    description: 'General-purpose assistant for everyday tasks and questions.',
    icon: 'bot',
    role: 'general',
  },
];

/**
 * Seed preset agent configurations into the database.
 * Idempotent -- skips presets that already exist by name.
 */
export async function seedAgentPresets(): Promise<void> {
  const db = getDb();

  for (const preset of AGENT_PRESETS) {
    // Check if this preset already exists
    const existing = await db
      .select({ id: presets.id })
      .from(presets)
      .where(eq(presets.name, preset.name))
      .limit(1);

    if (existing.length > 0) {
      continue;
    }

    await db.insert(presets).values({
      name: preset.name,
      description: preset.description,
      icon: preset.icon,
      role: preset.role,
      systemPrompt: preset.systemPrompt ?? null,
      modelPreference: preset.modelPreference ?? null,
      skillIds: preset.skillIds ?? [],
      parameters: preset.parameters ?? {},
      isSystem: true,
      userId: null as any, // System presets have no owner -- available to all users
    });

    logger.info({ preset: preset.name }, 'Seeded agent preset');
  }
}
