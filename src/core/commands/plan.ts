import { registerCommand } from './registry';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getOrchestratorService } from '@/core/orchestrator';
import { coreLogger } from '@/utils/logger';
import type { SessionContext, PlanningState } from '@/db/schema/sessions';

const AREAS = [
  'Development', 'Finance', 'Communication', 'Research',
  'Automation', 'Data Analysis', 'Design', 'DevOps',
  'Security', 'Writing', 'Other',
];

const AREA_QUESTIONS: Record<string, string[]> = {
  Development: [
    'What do you want to build? (app, library, API, script, etc.)',
    'What programming language or framework should be used?',
    'Are there specific integrations or APIs involved?',
    'What is the expected output or deliverable?',
  ],
  Finance: [
    'What financial task do you need help with? (analysis, report, tracking, etc.)',
    'What data sources or accounts are involved?',
    'What format should the output be in?',
    'Is there a deadline or reporting period?',
  ],
  Communication: [
    'What communication task is this? (email campaign, report, announcement, etc.)',
    'Who is the target audience?',
    'What channels should be used? (email, Slack, Teams, etc.)',
    'What is the key message or goal?',
  ],
  Research: [
    'What topic do you want to research?',
    'What specific questions need answering?',
    'What sources should be consulted? (web, papers, internal docs, etc.)',
    'What format should the findings be in?',
  ],
  Automation: [
    'What process do you want to automate?',
    'How often should it run? (once, daily, weekly, on trigger, etc.)',
    'What systems or tools are involved?',
    'What should happen with the output?',
  ],
  'Data Analysis': [
    'What data do you want to analyze?',
    'Where is the data located? (database, files, API, etc.)',
    'What insights or metrics are you looking for?',
    'How should results be presented? (report, chart, dashboard, etc.)',
  ],
  Design: [
    'What do you want to design? (UI, logo, layout, wireframe, etc.)',
    'Who is the target user or audience?',
    'Are there brand guidelines or style preferences?',
    'What deliverables do you need?',
  ],
  DevOps: [
    'What infrastructure task is this? (deploy, monitor, configure, etc.)',
    'What platforms or services are involved? (Docker, AWS, K8s, etc.)',
    'What is the current setup?',
    'What is the desired end state?',
  ],
  Security: [
    'What security task is this? (audit, scan, policy, review, etc.)',
    'What systems or code should be evaluated?',
    'Are there specific compliance requirements?',
    'What deliverables do you need?',
  ],
  Writing: [
    'What do you want to write? (docs, blog post, report, README, etc.)',
    'Who is the target audience?',
    'What tone or style should it have?',
    'Are there source materials or references to use?',
  ],
  Other: [
    'Describe your project in a few sentences.',
    'What is the main goal?',
    'What tools, systems, or resources are involved?',
    'What does success look like?',
  ],
};

function getState(session: { context: unknown } | null): PlanningState | null {
  const ctx = (session?.context as SessionContext) || {};
  return ctx.planningState || null;
}

async function saveState(sessionId: string, state: PlanningState): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  const ctx = (session?.context as SessionContext) || {};
  await sessionRepository.update(sessionId, {
    context: { ...ctx, planningState: state },
  });
}

registerCommand({
  name: 'plan',
  description: 'Start an interactive project planning questionnaire',
  async execute(ctx) {
    const session = await sessionRepository.findById(ctx.sessionId);
    let state = getState(session);

    // New plan or first call
    if (!state || !state.active) {
      state = {
        active: true,
        step: 0,
        area: null,
        answers: [],
        brief: null,
        createdAt: new Date().toISOString(),
      };
      await saveState(ctx.sessionId, state);

      const areaList = AREAS.map((a, i) => `${i + 1}. ${a}`).join('\n');
      return {
        response: [
          "**Let's plan your project!**\n",
          'What area is your project in?\n',
          areaList,
          '',
          'Reply with a number or type the area name. Send `/cancel` to abort.',
        ].join('\n'),
        continueCommand: true,
      };
    }

    const input = ctx.args.trim();

    // Step 0: parse area selection
    if (state.step === 0) {
      let area: string | null = null;
      const num = parseInt(input, 10);
      if (num >= 1 && num <= AREAS.length) {
        area = AREAS[num - 1];
      } else {
        // Fuzzy match by name
        area = AREAS.find(a => a.toLowerCase() === input.toLowerCase())
            || AREAS.find(a => a.toLowerCase().includes(input.toLowerCase()))
            || null;
      }

      if (!area) {
        return {
          response: `I didn't recognize that area. Please pick a number (1-${AREAS.length}) or type the area name.`,
          continueCommand: true,
        };
      }

      state.area = area;
      state.step = 1;
      await saveState(ctx.sessionId, state);

      const questions = AREA_QUESTIONS[area] || AREA_QUESTIONS.Other;
      return {
        response: `**Area: ${area}**\n\n${questions[0]}`,
        continueCommand: true,
      };
    }

    // Steps 1+: collect answers to area-specific questions
    const questions = AREA_QUESTIONS[state.area || 'Other'] || AREA_QUESTIONS.Other;
    const questionIndex = state.step - 1;

    if (questionIndex < questions.length) {
      state.answers.push({
        question: questions[questionIndex],
        answer: input,
        step: state.step,
      });
      state.step++;
      await saveState(ctx.sessionId, state);

      // More questions?
      const nextIndex = state.step - 1;
      if (nextIndex < questions.length) {
        return {
          response: questions[nextIndex],
          continueCommand: true,
        };
      }

      // All area questions done — ask "anything else?"
      return {
        response: 'Anything else you\'d like to add? (Type your details, or say **no** to finalize)',
        continueCommand: true,
      };
    }

    // "Anything else?" step
    const isNo = /^(no|nope|nah|nothing|that'?s? ?(all|it)|done|finish|finalize)$/i.test(input);

    if (!isNo) {
      state.answers.push({
        question: 'Additional details',
        answer: input,
        step: state.step,
      });
      state.step++;
      await saveState(ctx.sessionId, state);
      return {
        response: 'Got it. Anything else? (say **no** to finalize)',
        continueCommand: true,
      };
    }

    // Compile the brief
    const brief = await compileBrief(state);
    state.brief = brief;
    state.active = false;
    await saveState(ctx.sessionId, state);

    // Clear activeCommand — the plan is done
    const sessionData = await sessionRepository.findById(ctx.sessionId);
    const sessionCtx = (sessionData?.context as SessionContext) || {};
    await sessionRepository.update(ctx.sessionId, {
      context: { ...sessionCtx, activeCommand: undefined },
    });

    return {
      response: [
        '**Project Brief**\n',
        brief,
        '',
        '---',
        'Reply **go** to start executing this plan, or continue chatting to refine it.',
      ].join('\n'),
      continueCommand: false,
    };
  },
});

async function compileBrief(state: PlanningState): Promise<string> {
  const qa = state.answers
    .map(a => `**Q:** ${a.question}\n**A:** ${a.answer}`)
    .join('\n\n');

  // Try to use LLM to compile a structured brief
  try {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      return fallbackBrief(state, qa);
    }

    const client = getLiteLLMClient();
    const result = await client.complete({
      model: defaultModel.modelId,
      messages: [
        {
          role: 'system',
          content: `You compile project planning answers into a structured project brief. Be concise and actionable. Output a markdown brief with these sections: Goal, Scope, Approach, Expected Output, and any relevant details. Do NOT add information the user didn't provide.`,
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: `Project area: ${state.area}\n\nPlanning answers:\n${qa}\n\nCompile this into a structured project brief.`,
          timestamp: new Date(),
        },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });

    return result.content;
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to compile brief with LLM, using fallback');
    return fallbackBrief(state, qa);
  }
}

function fallbackBrief(state: PlanningState, qa: string): string {
  return [
    `**Area:** ${state.area}`,
    '',
    qa,
  ].join('\n');
}
