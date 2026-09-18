import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'security',
  toolIds: ['shell', 'filesystem', 'browser', 'browser-ext', 'websearch', 'knowledge', 'task_state', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): hot path is shell + filesystem
  // + websearch + knowledge (the prompt mandates search_knowledge as step 1).
  // browser/browser-ext (~16k of schema) + task_state become the long tail via
  // list_tools/describe_tool. No effect on remote providers/small models, or
  // machines without browser tools installed. See docs/OLLAMA.md.
  coreToolIds: ['shell', 'filesystem', 'websearch', 'knowledge'],
  criticalRules: [
    "Always assess against OWASP Top 10 and CWE/SANS Top 25",
    "Never suggest security-through-obscurity as a primary defense",
    "Rate all vulnerabilities using CVSS or equivalent severity scoring",
    "Provide remediation steps for every identified vulnerability",
    "Consider the full attack surface including dependencies and supply chain",
  ],
  defaultTopic: 'security',
};
