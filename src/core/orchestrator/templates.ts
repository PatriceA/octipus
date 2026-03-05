import type { AgentRole } from './types';
import { getRoleConfig } from './roles';

export interface StageTemplate {
  name: string;
  role: AgentRole;
  requiresApproval: boolean;
  promptTemplate: string;
}

export interface PipelineTemplate {
  type: string;
  stages: StageTemplate[];
}

/**
 * Development pipeline: full dev cycle with approval checkpoint after planning.
 */
const developmentTemplate: PipelineTemplate = {
  type: 'development',
  stages: [
    {
      name: 'Research',
      role: 'research',
      requiresApproval: false,
      promptTemplate: `Research the following development task. Find relevant documentation, existing implementations, best practices, and potential libraries or tools.

Task: {{description}}

Provide a structured summary with:
1. Key findings and relevant documentation
2. Recommended approach and architecture
3. Libraries/packages to use (with rationale)
4. Potential risks or challenges`,
    },
    {
      name: 'Architecture Plan',
      role: 'coding',
      requiresApproval: true, // User reviews plan before coding starts
      promptTemplate: `Based on the research findings, create a detailed implementation plan.

Task: {{description}}

Research findings:
{{previousOutput}}

Create a plan with:
1. File-by-file changes (new files, modifications)
2. Data model / schema changes (if any)
3. API endpoints or interfaces
4. Implementation order (dependencies)
5. Testing strategy`,
    },
    {
      name: 'Implementation',
      role: 'coding',
      requiresApproval: false,
      promptTemplate: `Implement the following plan. Write clean, well-documented code following project conventions.

Task: {{description}}

Implementation plan:
{{previousOutput}}

Execute the plan step by step. After each file change, verify it works.`,
    },
    {
      name: 'Code Review',
      role: 'review',
      requiresApproval: false,
      promptTemplate: `Review the implementation for quality, bugs, security, and adherence to the plan.

Task: {{description}}

Implementation details:
{{previousOutput}}

Check for:
1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Missing error handling
5. Code style and conventions
6. Test coverage`,
    },
    {
      name: 'QA Testing',
      role: 'qa',
      requiresApproval: false,
      promptTemplate: `Test the implementation. Run unit tests, integration tests, and if applicable, UI tests.

Task: {{description}}

Implementation and review:
{{previousOutput}}

Run tests and report:
1. Test results (pass/fail)
2. Any bugs found
3. UI/UX issues (if applicable)
4. Performance observations`,
    },
  ],
};

/**
 * Research pipeline: investigation + analysis.
 */
const researchTemplate: PipelineTemplate = {
  type: 'research',
  stages: [
    {
      name: 'Investigation',
      role: 'research',
      requiresApproval: false,
      promptTemplate: `Investigate the following topic thoroughly. Search the web, find documentation, examples, and expert opinions.

Topic: {{description}}

Provide detailed findings with sources.`,
    },
    {
      name: 'Analysis',
      role: 'general',
      requiresApproval: false,
      promptTemplate: `Analyze the research findings and produce a clear, actionable summary.

Topic: {{description}}

Research findings:
{{previousOutput}}

Produce:
1. Executive summary
2. Key insights
3. Recommendations
4. Next steps`,
    },
  ],
};

/**
 * General pipeline: single worker stage.
 */
const generalTemplate: PipelineTemplate = {
  type: 'general',
  stages: [
    {
      name: 'Execute',
      role: 'general',
      requiresApproval: false,
      promptTemplate: `Complete the following task:

{{description}}`,
    },
  ],
};

const TEMPLATES: Record<string, PipelineTemplate> = {
  development: developmentTemplate,
  research: researchTemplate,
  general: generalTemplate,
};

/**
 * Get a pipeline template by type.
 */
export function getPipelineTemplate(type: string): PipelineTemplate {
  return TEMPLATES[type] || TEMPLATES.general;
}

/**
 * Expand a stage's prompt template with context variables.
 */
export function expandPromptTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Build stage configs from a template for a specific pipeline description.
 */
export function buildStagesFromTemplate(
  template: PipelineTemplate,
  description: string,
) {
  return template.stages.map((stage, index) => {
    const roleConfig = getRoleConfig(stage.role);
    return {
      name: stage.name,
      role: stage.role,
      toolIds: roleConfig.toolIds,
      systemPrompt: roleConfig.systemPromptTemplate,
      requiresApproval: stage.requiresApproval,
      stageIndex: index,
      promptTemplate: stage.promptTemplate,
    };
  });
}
