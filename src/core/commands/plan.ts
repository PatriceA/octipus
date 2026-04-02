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
    "In simple terms, what should this software do? Describe it like you're explaining it to a friend.\n\n_Example: \"An app where people can order food from local restaurants and track delivery\"_",
    "Who will use this? Think about the different types of people who'll interact with it.\n\n_Example: \"Customers ordering food, restaurant owners managing menus, and delivery drivers\"_",
    "Where should it run? Pick what fits best:\n\n• **Mobile app** — on phones (Android, iPhone, or both)\n• **Web app** — in a browser on any device\n• **Desktop app** — installed on a computer\n• **Backend/API** — runs behind the scenes, no visible interface\n• **Script/tool** — a small utility that does one job\n• **Not sure** — I'll help you decide\n\n_You can combine these, e.g. \"web app + mobile app\"_",
    "Do you have a preference for the technology? If not, just say **no preference** and I'll recommend one based on your needs.\n\n_Examples: \"React\", \"Flutter\", \"Python\", \"no preference\"_",
    "What are the most important features? List the top 3-5 things users must be able to do.\n\n_Example:\n1. Sign up and log in\n2. Browse restaurant menus\n3. Place an order and pay\n4. Track delivery in real time_",
    "Does it need to connect to anything? Think about:\n\n• **Existing systems** you already use (databases, services, other apps)\n• **External services** like payment, maps, email, social login\n• **Hardware** like cameras, sensors, printers\n• Say **nothing** if it's standalone\n\n_Example: \"Needs to connect to Stripe for payments and Google Maps for tracking\"_",
    "How should it look and feel? Share any preferences:\n\n• An app or website you like the style of\n• Colors, themes, or branding you want\n• **Simple/minimal** vs **feature-rich**\n• Say **no preference** if you don't mind\n\n_Example: \"Clean and modern like the Airbnb app, with our brand colors blue and white\"_",
  ],
  Finance: [
    "What would you like to accomplish? Describe your goal in plain language.\n\n_Examples:\n• \"I want to understand where my business money is going each month\"\n• \"I need to create a budget for a new project\"\n• \"I want to forecast revenue for next quarter\"_",
    "What kind of money or numbers are we working with?\n\n• **Personal finances** — your own income, expenses, savings\n• **Business finances** — company revenue, costs, profit\n• **Project budget** — costs for a specific initiative\n• **Investment** — tracking returns, portfolio, assets\n• **Other** — describe it\n\n_Example: \"Business finances — monthly expenses across 3 departments\"_",
    "Where does the financial data come from? Pick all that apply:\n\n• **Bank statements** or exports (CSV, PDF)\n• **Accounting software** (QuickBooks, Xero, etc.)\n• **Spreadsheets** you've been maintaining\n• **Invoices or receipts** you need to organize\n• **Starting from scratch** — no existing data yet\n\n_Example: \"I have bank CSV exports and some Excel spreadsheets\"_",
    "What do you want as the end result?\n\n• **A report** — summary document with findings\n• **A dashboard** — live view I can check regularly\n• **A spreadsheet** — organized data I can work with\n• **A plan or budget** — forward-looking financial plan\n• **Recommendations** — advice on what to do\n\n_Example: \"A monthly report showing spending by category with a chart\"_",
    "Is there a deadline or timeframe?\n\n• When do you need this by?\n• What time period should the analysis cover?\n• Is this a one-time thing or ongoing?\n\n_Example: \"Need it by end of month, covering the last 6 months of expenses, and then updated monthly\"_",
  ],
  Communication: [
    "What do you want to communicate? Describe the situation.\n\n_Examples:\n• \"We're launching a new product and need to tell our customers\"\n• \"I need to send a weekly update to my team\"\n• \"We need to announce a company policy change\"_",
    "Who needs to receive this message? Describe them:\n\n• How many people roughly?\n• What's their relationship to you? (customers, employees, partners, public)\n• What do they already know about this topic?\n\n_Example: \"About 500 existing customers who have used our old product — they know us but not the new features\"_",
    "What's the main thing you want people to **do** or **feel** after receiving this?\n\n_Examples:\n• \"Sign up for the new service\"\n• \"Feel informed and reassured about the change\"\n• \"Reply with their availability for a meeting\"_",
    "How should the message reach them? Pick what fits:\n\n• **Email** — formal or marketing messages\n• **Chat message** (Slack, Teams, WhatsApp) — quick, informal\n• **Social media** — public announcement\n• **Newsletter** — regular updates\n• **Presentation** — in-person or virtual meeting\n• **Not sure** — I'll recommend based on your audience\n\n_You can pick multiple: \"Email first, then a Slack reminder\"_",
    "What tone fits best?\n\n• **Professional/formal** — corporate, serious\n• **Friendly/casual** — warm, approachable\n• **Urgent** — time-sensitive, action needed now\n• **Celebratory** — exciting news, achievements\n• **Empathetic** — sensitive topic, needs care\n\n_Example: \"Friendly but professional — we want to sound excited but not pushy\"_",
  ],
  Research: [
    "What do you want to find out? Describe your question or topic in everyday language.\n\n_Examples:\n• \"What's the best way to accept payments online for a small business?\"\n• \"How are other companies solving remote team communication?\"\n• \"What are the pros and cons of electric vehicles for a delivery fleet?\"_",
    "Why do you need this information? Understanding the purpose helps focus the research.\n\n• **Making a decision** — choosing between options\n• **Learning** — understanding a new topic\n• **Solving a problem** — finding fixes or workarounds\n• **Comparing** — evaluating competitors, tools, or approaches\n• **Due diligence** — verifying claims or assessing risk\n\n_Example: \"We're deciding between 3 payment providers and need to compare them\"_",
    "How deep should the research go?\n\n• **Quick overview** — key facts and a summary (30 min read)\n• **Detailed analysis** — thorough coverage with pros/cons\n• **Comprehensive report** — in-depth with data, sources, and recommendations\n\n_Example: \"Detailed analysis — I need enough to present to my team and make a decision\"_",
    "Are there specific aspects you care about most? Pick any that apply:\n\n• **Cost** — pricing, budget impact\n• **Quality/reliability** — how well it works\n• **Ease of use** — learning curve, simplicity\n• **Speed** — how fast to implement or get results\n• **Risk** — what could go wrong\n• **Other** — describe what matters to you\n\n_Example: \"Cost and ease of use are the top priorities — we're a small team with limited budget\"_",
  ],
  Automation: [
    "What task or process takes too much of your time? Describe what you (or your team) currently do manually.\n\n_Examples:\n• \"Every Monday I download a report, copy numbers into a spreadsheet, and email it to the team\"\n• \"I have to check 5 different websites for price changes every day\"\n• \"When a new customer signs up, I manually create accounts in 3 different systems\"_",
    "Walk me through the steps. What happens from start to finish?\n\n_List the steps as you do them now, even if they seem obvious:\n1. First I...\n2. Then I...\n3. After that..._",
    "How often does this need to happen?\n\n• **On a schedule** — daily, weekly, monthly, etc.\n• **When something happens** — a new email arrives, a file is uploaded, etc.\n• **On demand** — when I press a button or ask for it\n• **Continuously** — it should always be running/monitoring\n\n_Example: \"Every weekday morning at 9am, and also whenever a new order comes in\"_",
    "What should happen with the results?\n\n• **Send a notification** — email, message, alert\n• **Update a file or spreadsheet** — save data somewhere\n• **Trigger another action** — start the next step automatically\n• **Create a report** — summary of what happened\n• **Just do it silently** — no notification needed\n\n_Example: \"Email me a summary and update the shared Google Sheet\"_",
    "What tools or systems are involved? List anything the automation would need to touch:\n\n• Websites, apps, or services you use\n• Files or folders (local or cloud)\n• Databases or APIs\n• Say **not sure** if you need help figuring this out\n\n_Example: \"Gmail, Google Sheets, and our Shopify store\"_",
  ],
  'Data Analysis': [
    "What question are you trying to answer with data?\n\n_Examples:\n• \"Which of our products sells best and in which regions?\"\n• \"Are we spending more this year compared to last year?\"\n• \"What patterns are there in customer complaints?\"_",
    "What data do you have? Describe it in plain terms:\n\n• **What kind of information** is it? (sales numbers, survey responses, website traffic, etc.)\n• **How much** data is there? (a few rows, thousands of records, etc.)\n• **What format** is it in? (spreadsheet, database, CSV files, PDF reports, etc.)\n• Say **I don't have data yet** if you need help collecting it\n\n_Example: \"Two years of sales data in Excel spreadsheets — about 50,000 rows with date, product, quantity, and revenue\"_",
    "What would be most useful to you?\n\n• **Summary & key numbers** — totals, averages, trends\n• **Comparisons** — how things stack up against each other\n• **Patterns & trends** — what's changing over time\n• **Predictions** — what might happen next based on the data\n• **Anomalies** — finding unusual things that stand out\n• **All of the above** — comprehensive analysis\n\n_Example: \"Mainly comparisons between regions and trends over time\"_",
    "How do you want to see the results?\n\n• **Charts and graphs** — visual, easy to understand at a glance\n• **Written report** — narrative with explanations\n• **Interactive dashboard** — I can filter and explore the data myself\n• **Clean spreadsheet** — organized data I can share or reuse\n• **Presentation-ready** — slides or visuals for a meeting\n\n_Example: \"Charts I can put in a presentation, plus a written summary with key takeaways\"_",
    "Who is this analysis for? This helps set the right level of detail.\n\n• **Just me** — I want to understand the data\n• **My team** — shared understanding for decision-making\n• **Leadership/executives** — high-level, focused on decisions\n• **External audience** — clients, investors, public\n\n_Example: \"For our quarterly leadership meeting — needs to be clear and focused on actionable insights\"_",
  ],
  Design: [
    "What do you need designed? Describe what it should be.\n\n_Examples:\n• \"A mobile app interface for ordering coffee\"\n• \"A logo for my new bakery business\"\n• \"A landing page for our product launch\"\n• \"Wireframes for a project management dashboard\"_",
    "Who will see or use this design? Describe your audience:\n\n• How old are they roughly?\n• What's their comfort level with technology?\n• What situation are they in when they see this?\n\n_Example: \"Busy professionals aged 25-45 who want to quickly order coffee on their phone during their commute\"_",
    "What feeling or impression should the design give?\n\n• **Modern & clean** — minimal, lots of white space\n• **Bold & energetic** — bright colors, strong shapes\n• **Elegant & premium** — sophisticated, luxury feel\n• **Friendly & playful** — fun, approachable, colorful\n• **Professional & trustworthy** — corporate, reliable\n• **Not sure** — share a website or app you like the look of instead\n\n_Example: \"Friendly and playful — we're a neighborhood bakery, not a corporate chain\"_",
    "Do you have any existing brand materials?\n\n• **Logo** — yes/no\n• **Brand colors** — specific colors or preferences\n• **Fonts** — specific typefaces or style preference\n• **Existing website or materials** — anything to match or build from\n• **Starting fresh** — no existing brand identity\n\n_Example: \"We have a logo and use green and cream colors, but no set fonts yet\"_",
    "What do you need delivered?\n\n• **Mockups/designs** — finished visual designs (images)\n• **Working prototype** — clickable/interactive preview\n• **Built pages/screens** — actual coded implementation\n• **Design files** — editable source files (Figma, Sketch, etc.)\n• **Style guide** — rules for consistent design going forward\n\n_Example: \"Mockups first so I can review, then a working prototype I can test on my phone\"_",
  ],
  DevOps: [
    "What's the situation? Describe what you're trying to accomplish.\n\n_Examples:\n• \"I built an app and now I need to put it online so people can use it\"\n• \"Our website goes down sometimes and I want to prevent that\"\n• \"I need to set up a way for my team to test code before it goes live\"_",
    "What does your setup look like right now?\n\n• **I have nothing yet** — starting from scratch\n• **Running locally** — it works on my computer but nowhere else\n• **Hosted somewhere** — it's already online (tell me where)\n• **Partly set up** — some things work, others don't\n\n_Example: \"The app runs on my laptop. I've heard of Docker but never used it. No server yet.\"_",
    "What's most important to you? Pick your top priorities:\n\n• **Keep it simple** — I don't want to manage complex infrastructure\n• **Keep costs low** — budget is limited\n• **High reliability** — it can't go down\n• **Fast performance** — speed is critical\n• **Security** — sensitive data, needs to be locked down\n• **Easy updates** — I want to deploy changes quickly\n\n_Example: \"Keep it simple and costs low — this is a side project with a few hundred users\"_",
    "How many people or how much traffic do you expect?\n\n• **Just me/my team** — internal tool, few users\n• **Small audience** — up to a few hundred users\n• **Medium** — thousands of users\n• **Large scale** — tens of thousands or more\n• **Not sure** — help me estimate\n\n_Example: \"Starting small, maybe 50 users, but could grow to a few thousand over the next year\"_",
    "What's your technical comfort level with servers and infrastructure?\n\n• **Beginner** — I can follow step-by-step instructions\n• **Intermediate** — I've used the command line and can Google my way through problems\n• **Advanced** — I'm comfortable with servers, networking, and configuration\n\n_This helps me recommend the right tools and level of detail for the plan._",
  ],
  Security: [
    "What are you trying to protect or assess? Describe your situation.\n\n_Examples:\n• \"I have a web app and want to make sure it's safe from hackers\"\n• \"We're storing customer data and need to follow privacy regulations\"\n• \"I want to check if our company's IT setup has any weaknesses\"_",
    "What kind of system or asset is involved?\n\n• **Website or web app** — something accessible via a browser\n• **Mobile app** — runs on phones/tablets\n• **Internal systems** — company networks, servers, databases\n• **Data** — customer info, financial records, intellectual property\n• **Code/software** — source code that needs reviewing\n• **Accounts & access** — who can get into what\n\n_Example: \"A web app that stores customer payment information, plus an admin panel for our team\"_",
    "What concerns you most? Pick any that apply:\n\n• **Data breach** — someone stealing data\n• **Unauthorized access** — wrong people getting in\n• **Downtime** — system being taken offline by an attack\n• **Compliance** — meeting regulations (GDPR, HIPAA, PCI, etc.)\n• **I don't know** — I just want to know if we're safe\n\n_Example: \"Mainly worried about data breaches and we might need GDPR compliance since we have European customers\"_",
    "What security measures do you already have, if any?\n\n• **Passwords** — how do users log in?\n• **Encryption** — is data encrypted?\n• **Backups** — do you have data backups?\n• **Updates** — is software kept up to date?\n• **None/not sure** — that's what I need help figuring out\n\n_Example: \"Users log in with email and password. I think the database is encrypted but I'm not sure. No regular backups.\"_",
    "What outcome do you need?\n\n• **Assessment report** — tell me what's wrong and how to fix it\n• **Security plan** — step-by-step guide to secure everything\n• **Implementation** — actually set up the security measures\n• **Ongoing monitoring** — continuous security checking\n• **Training** — help my team understand security best practices\n\n_Example: \"An assessment report first, then a plan to fix the critical issues\"_",
  ],
  Writing: [
    "What do you need written? Describe the piece.\n\n_Examples:\n• \"A blog post about our company's new sustainability initiative\"\n• \"Technical documentation for our API\"\n• \"A proposal to convince my boss to approve a new project\"\n• \"Social media posts for a product launch\"_",
    "Who will read this? Describe your audience:\n\n• What do they already know about the topic?\n• What's their reading level or expertise?\n• What's their relationship to you or your organization?\n\n_Example: \"Our customers — they're not technical but they care about the environment. They follow us on LinkedIn and read our newsletter.\"_",
    "What should the reader **do** or **think** after reading this?\n\n_Examples:\n• \"Feel confident using our API to build integrations\"\n• \"Be excited about our new features and share the post\"\n• \"Approve the budget for this project\"_",
    "What tone and style fits?\n\n• **Professional** — formal, authoritative\n• **Conversational** — like talking to a friend\n• **Technical** — precise, detailed, no fluff\n• **Persuasive** — convincing, compelling\n• **Educational** — patient, step-by-step\n• Share an example you like: _\"Write it like [publication/author]\"_\n\n_Example: \"Conversational but knowledgeable — like a smart friend explaining something over coffee\"_",
    "What's the scope?\n\n• **Length** — short (< 500 words), medium (500-1500), long (1500+), or specific word count\n• **Format** — article, list, guide, letter, script, social posts\n• **References** — any materials, data, or sources to include\n• **Deadline** — when do you need it?\n\n_Example: \"Medium-length blog post, around 800 words, referencing our recent sustainability report. Need it by Friday.\"_",
  ],
  Other: [
    "Tell me about your project. What are you trying to accomplish?\n\n_Don't worry about technical terms — just describe it like you'd explain to a friend._",
    "Why is this important? What problem does it solve or what opportunity does it create?\n\n_Example: \"We're wasting 10 hours a week on manual data entry and I want to fix that\"_",
    "What does the finished result look like? How will you know it's done?\n\n_Example: \"When the report automatically generates every Monday and lands in my inbox with accurate numbers\"_",
    "What resources or tools do you already have? And is there a budget or timeline?\n\n_Example: \"We use Google Workspace and have a small budget for software subscriptions. Would like this done within a month.\"_",
    "Is there anything else I should know? Constraints, preferences, past attempts, stakeholders?\n\n_Example: \"My manager tried a similar thing last year with a different tool and it didn't work — I want to avoid that approach\"_",
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
        response: `**Area: ${area}**\n\n_Question 1 of ${questions.length}_ — Send \`/cancel\` at any time to abort.\n\n${questions[0]}`,
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
          response: `_Question ${nextIndex + 1} of ${questions.length}_\n\n${questions[nextIndex]}`,
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

    // Notify user before the potentially slow LLM compilation
    if (ctx.notify) {
      await ctx.notify('Working on the project brief, this can take a moment...');
    }

    // Compile the brief
    const brief = await compileBrief(state);
    state.brief = brief;
    state.active = false;
    await saveState(ctx.sessionId, state);

    // Clear activeCommand — the plan is done.
    // Keep planningState briefly so user can say "go" to execute,
    // but mark it clearly as pending-execution.
    const sessionData = await sessionRepository.findById(ctx.sessionId);
    const sessionCtx = (sessionData?.context as SessionContext) || {};
    await sessionRepository.update(ctx.sessionId, {
      context: { ...sessionCtx, activeCommand: undefined, planningState: { brief, active: false, executed: false } as any },
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
    .map(a => {
      // Strip the examples/hints from questions for the brief — keep just the first line
      const shortQuestion = a.question.split('\n')[0];
      return `**Q:** ${shortQuestion}\n**A:** ${a.answer}`;
    })
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
          content: `You are a professional project planner. Compile the user's answers into a clear, structured project brief in markdown.

Use these sections:
## Goal
One paragraph summarizing what the project aims to achieve and why.

## Scope
Bullet list of what's included (and notable exclusions if any).

## Target Audience
Who this is for and their key characteristics.

## Key Requirements
Numbered list of the most important features, deliverables, or outcomes.

## Technical Approach
Recommended technologies, tools, or methods based on the answers. If the user didn't specify preferences, recommend appropriate options with brief justification.

## Integrations & Dependencies
External services, systems, or resources needed. Write "None identified" if not applicable.

## Success Criteria
How to measure if the project is complete and successful.

## Estimated Phases
Break the project into 3-5 high-level phases with brief descriptions.

Rules:
- Be specific and actionable, not vague
- Base everything on the user's actual answers — do NOT invent requirements
- If the user was vague on something, note it as "To be determined" rather than guessing
- Use professional but accessible language
- Keep it concise — each section should be 2-5 bullet points or 1-3 sentences`,
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: `Project area: ${state.area}\n\nPlanning answers:\n${qa}\n\nCompile this into a structured project brief.`,
          timestamp: new Date(),
        },
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });

    const content = result.content?.trim();
    if (!content) {
      coreLogger.warn('LLM returned empty brief, using fallback');
      return fallbackBrief(state, qa);
    }
    return content;
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to compile brief with LLM, using fallback');
    return fallbackBrief(state, qa);
  }
}

function fallbackBrief(state: PlanningState, qa: string): string {
  // Provide a structured fallback even without the LLM
  const answers = state.answers.reduce((acc, a) => {
    const shortQ = a.question.split('\n')[0];
    acc[shortQ] = a.answer;
    return acc;
  }, {} as Record<string, string>);

  const sections = [
    `## Project Brief — ${state.area}`,
    '',
    '### Summary',
    ...Object.entries(answers).map(([q, a]) => `- **${q}**: ${a}`),
  ];

  return sections.join('\n');
}
