import { getUMI } from '@/channels/interface';
import { getOAuthManager } from '@/security/oauth';
import { coreLogger } from '@/utils/logger';

export interface HookSuggestion {
  id: string;
  name: string;
  description: string;
  category: 'daily-briefing' | 'email' | 'developer' | 'monitoring' | 'productivity' | 'calendar';
  integration: 'google' | 'microsoft' | 'github' | 'telegram' | 'system' | 'any';
  trigger: string;
  triggerConfig: Record<string, unknown>;
  action: string;
  actionConfig: Record<string, unknown>;
}

export async function getHookSuggestions(userId: string): Promise<HookSuggestion[]> {
  const suggestions: HookSuggestion[] = [];
  const oauthManager = getOAuthManager();

  let hasGoogle = false;
  let hasMicrosoft = false;
  let hasTelegram = false;

  // Detect available integrations
  try {
    const googleToken = await oauthManager.getValidToken(userId, 'google');
    hasGoogle = !!googleToken;
  } catch (err) { coreLogger.error({ err }, 'silent failure in suggestions'); }

  try {
    const msToken = await oauthManager.getValidToken(userId, 'microsoft');
    hasMicrosoft = !!msToken;
  } catch (err) { coreLogger.error({ err }, 'silent failure in suggestions'); }

  try {
    const umi = getUMI();
    hasTelegram = umi.isChannelAvailable('telegram' as any);
  } catch (err) { coreLogger.error({ err }, 'silent failure in suggestions'); }

  const hasEmail = hasGoogle || hasMicrosoft;
  const hasCalendar = hasGoogle || hasMicrosoft;
  const emailProvider = hasGoogle ? 'Gmail' : 'Outlook';
  const calendarProvider = hasGoogle ? 'Google Calendar' : 'Outlook Calendar';

  // ─── Daily Briefings ─────────────────────────────────────────────

  if (hasEmail || hasCalendar) {
    suggestions.push({
      id: 'morning-briefing',
      name: 'Morning Briefing',
      description: 'Daily summary at 8 AM: calendar events, unread emails, weather, and top news for your interests',
      category: 'daily-briefing',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 8 * * *' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Generate my morning briefing for today. Include:
1. Today's calendar events from ${calendarProvider} — list times and titles
2. Unread email summary from ${emailProvider} — flag urgent items, group by sender importance
3. Current weather for my location (check my profile for location)
4. Top 3 tech/AI news headlines from the web

Format as a clean, scannable digest. Keep it concise — bullet points, not paragraphs.`,
        orchestrated: true,
        notifyRoot: true,
      },
    });
  }

  if (hasTelegram) {
    suggestions.push({
      id: 'evening-recap',
      name: 'Evening Recap',
      description: 'End-of-day summary at 6 PM: what happened today, pending tasks, tomorrow preview',
      category: 'daily-briefing',
      integration: 'telegram',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 18 * * 1-5' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Generate my evening recap for today. Include:
1. Summary of agent activity today — what tasks were completed
2. Any pending items or follow-ups from today's conversations
${hasCalendar ? `3. Tomorrow's calendar preview from ${calendarProvider}` : ''}
${hasEmail ? `4. Any important emails that still need a response` : ''}

Keep it brief and actionable. Highlight anything that needs attention tomorrow.`,
        orchestrated: true,
        notifyRoot: true,
      },
    });
  }

  // ─── Email Management ─────────────────────────────────────────────

  if (hasEmail) {
    suggestions.push({
      id: 'email-triage',
      name: 'Email Triage (Every 30 min)',
      description: 'Check for new emails, classify by urgency, flag important ones, summarize',
      category: 'email',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '*/30 * * * *' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Check ${emailProvider} for new unread emails. For each email:
1. Classify urgency: URGENT (needs response today), IMPORTANT (this week), FYI (informational), SKIP (spam/newsletters)
2. For URGENT and IMPORTANT: summarize the key ask and suggest a brief reply
3. For newsletters and promotions: just note the sender and subject

Use the email processor tool with batch processing. Present results grouped by urgency level.`,
        orchestrated: true,
        notifyRoot: true,
      },
    });

    suggestions.push({
      id: 'email-cleanup',
      name: 'Weekly Email Cleanup',
      description: 'Sunday evening cleanup: archive old read emails, flag newsletters for unsubscribe',
      category: 'email',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 20 * * 0' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Perform a weekly email cleanup on ${emailProvider}:
1. Find read emails older than 7 days that haven't been starred/flagged — list them for archiving
2. Identify recurring newsletter/promotional senders — list which ones I haven't opened in 2+ weeks
3. Find any emails with attachments I might need to save
4. Give me a summary: total unread, total processed, recommended actions

Use the email processor tool to iterate through emails in batches. Report what you'd recommend archiving or unsubscribing from — don't take action without confirmation.`,
        orchestrated: true,
        notifyRoot: true,
      },
    });

    suggestions.push({
      id: 'email-digest',
      name: 'Daily Email Digest',
      description: 'Morning digest of overnight emails — summarize what came in while you slept',
      category: 'email',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 7 * * *' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Check ${emailProvider} for all emails received in the last 12 hours. Summarize them as a digest:
- Group by sender or topic
- Highlight anything that needs immediate attention
- Note any calendar invites or meeting changes
- Skip obvious spam and marketing unless it's from a service I use

Keep the digest scannable — 2-3 sentences per email max.`,
        orchestrated: true,
        notifyRoot: true,
      },
    });
  }

  // ─── Calendar ─────────────────────────────────────────────────────

  if (hasCalendar) {
    suggestions.push({
      id: 'calendar-daily',
      name: 'Daily Schedule',
      description: 'Morning overview of today\'s meetings and events at 8:30 AM',
      category: 'calendar',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '30 8 * * 1-5' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Get today's calendar events from ${calendarProvider}. Present as a clean schedule:
- Time, title, location (if any), attendees
- Highlight any conflicts or back-to-back meetings
- Note any prep needed (e.g., "Review PR before standup")
- Show free time blocks if any`,
        orchestrated: true,
        notifyRoot: true,
      },
    });

    suggestions.push({
      id: 'calendar-weekly-prep',
      name: 'Weekly Schedule Prep',
      description: 'Sunday evening preview of the week ahead — meetings, deadlines, free blocks',
      category: 'calendar',
      integration: hasGoogle ? 'google' : 'microsoft',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 19 * * 0' },
      action: 'spawn_agent',
      actionConfig: {
        agentPrompt: `Get my calendar events for the upcoming week (Monday to Friday) from ${calendarProvider}. Present:
1. Day-by-day overview of meetings and events
2. Busiest day and lightest day
3. Any conflicts or double-bookings
4. Suggested focus/deep-work blocks in free time
5. Any deadlines or important dates this week`,
        orchestrated: true,
        notifyRoot: true,
      },
    });
  }

  // ─── Developer Workflows ──────────────────────────────────────────

  suggestions.push({
    id: 'dev-daily-standup',
    name: 'Dev Standup Prep',
    description: 'Morning standup prep: git activity, open PRs, recent commits, and blockers',
    category: 'developer',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '45 8 * * 1-5' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Prepare my daily standup summary. Check the workspace and git:
1. What I worked on yesterday — list recent git commits from the last 24 hours
2. What I'm working on today — check any in-progress branches or uncommitted changes
3. Any blockers — failing tests, build errors, or unresolved merge conflicts
4. Check git status for any uncommitted work

Format as a standup-ready summary I can paste directly.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  suggestions.push({
    id: 'dev-code-review',
    name: 'Code Review Check',
    description: 'Check for open PRs waiting for review and summarize changes',
    category: 'developer',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 10,14 * * 1-5' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Check for code review tasks:
1. List any open pull requests in the workspace repositories using git/github tools
2. For each PR: show title, author, files changed, and a brief summary of what it does
3. Flag any PRs that have been open for more than 2 days
4. Check if any of my PRs have new comments or review feedback

Prioritize by age — oldest PRs first.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  suggestions.push({
    id: 'dev-dependency-check',
    name: 'Weekly Dependency Audit',
    description: 'Check for outdated dependencies, security vulnerabilities, and updates',
    category: 'developer',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Run a dependency audit on the workspace:
1. Check for outdated packages (npm outdated, pip list --outdated, etc.)
2. Check for known security vulnerabilities (npm audit, etc.)
3. Summarize: total packages, outdated count, critical vulnerabilities
4. Recommend which updates are safe to apply (patch/minor) vs risky (major)

Don't apply any updates — just report findings.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  // ─── Server/System Monitoring ─────────────────────────────────────

  suggestions.push({
    id: 'server-health-check',
    name: 'Server Health Check',
    description: 'Hourly check of system resources, disk usage, running services',
    category: 'monitoring',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 * * * *' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Run a quick server health check:
1. Check disk usage (df -h) — alert if any partition is over 85%
2. Check memory usage (free -h) — alert if available memory is under 1GB
3. Check running Docker containers (docker ps) — note any that are restarting or unhealthy
4. Check system load average

Only report problems. If everything is healthy, just say "All systems healthy" with a one-line summary.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  suggestions.push({
    id: 'docker-cleanup',
    name: 'Weekly Docker Cleanup',
    description: 'Clean up unused Docker images, volumes, and stopped containers',
    category: 'monitoring',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 3 * * 0' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Check Docker resource usage and recommend cleanup:
1. List stopped containers (docker ps -a --filter status=exited)
2. List dangling images (docker images -f dangling=true)
3. Check volume usage (docker system df)
4. Show total disk space used by Docker

Report what can be cleaned up and how much space it would free. Don't run docker prune without confirmation.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  suggestions.push({
    id: 'log-monitor',
    name: 'Log Error Monitor',
    description: 'Check application logs every 15 minutes for errors and warnings',
    category: 'monitoring',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '*/15 * * * *' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Check Octipus backend log for recent errors:
1. Read the last 200 lines of ~/.octipus/backend.log
2. Filter for ERROR and WARN entries from the last 15 minutes
3. Group errors by type/source
4. If there are repeated errors, identify the pattern

Only notify if there are actual errors. Skip routine info messages.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  // ─── Productivity ─────────────────────────────────────────────────

  suggestions.push({
    id: 'research-digest',
    name: 'Weekly AI/Tech Research',
    description: 'Friday afternoon research digest — top AI and tech developments of the week',
    category: 'productivity',
    integration: 'any',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 15 * * 5' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Research and compile a weekly tech digest:
1. Search the web for the top AI and technology news from this week
2. Focus on: new model releases, framework updates, notable open source projects, industry trends
3. For each item: one-paragraph summary with why it matters
4. Include links to sources

Aim for 5-7 items. Quality over quantity — skip minor updates and marketing announcements.`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  suggestions.push({
    id: 'knowledge-maintenance',
    name: 'Weekly Knowledge Base Cleanup',
    description: 'Clean up the knowledge base: remove orphaned entries, stale outputs, duplicates',
    category: 'productivity',
    integration: 'system',
    trigger: 'schedule',
    triggerConfig: { cronExpression: '0 2 * * 6' },
    action: 'spawn_agent',
    actionConfig: {
      agentPrompt: `Perform knowledge base maintenance:
1. Run cleanup_knowledge with dry_run=true first to preview
2. If there are entries to clean up, run it for real with max_age_days=30 and min_content_length=50
3. Report what was removed: orphaned documents, stale agent outputs, short entries, duplicates
4. Show knowledge base stats after cleanup`,
      orchestrated: true,
      notifyRoot: true,
    },
  });

  return suggestions;
}
