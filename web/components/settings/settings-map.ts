/** Canonical destinations; search and overview cards share this list. Legacy tab URLs stay valid. */
export interface SettingsEntry { title: string; tab?: string; href?: string; keywords: string; admin?: boolean; module?: string }
export const settingsGroups: Array<{ name: string; description: string; icon: string; entries: SettingsEntry[] }> = [
  { name: 'You & your workspace', description: 'Your profile, preferences, and devices.', icon: 'user', entries: [
    { title: 'Appearance', tab: 'appearance', keywords: 'theme dark light mode display colors' },
    { title: 'Profile', tab: 'general', keywords: 'account username email' },
    { title: 'Companion appearance', href: '/persona', keywords: 'name persona personality instructions' },
    { title: 'Notifications', tab: 'notifications', keywords: 'alerts sound' },
    { title: 'Voice & Calls', tab: 'voice', keywords: 'speech microphone', module: 'voice' },
    { title: 'Mobile App', tab: 'mobile', keywords: 'phone android' },
    { title: 'People & profiles', href: '/profiles', keywords: 'people contacts profiles' },
    { title: 'Spaces on other installs', tab: 'remote-spaces', keywords: 'remote federation team' },
  ] },
  { name: 'Companion & automation', description: 'Models, supervision, and when work runs.', icon: 'spark', entries: [
    { title: 'Companion model & supervision', href: '/companion', keywords: 'companion model budget autonomy goals' },
    { title: 'Heartbeat', tab: 'heartbeat', keywords: 'periodic check background todos' },
    { title: 'Pipelines', href: '/pipelines', keywords: 'plans stages review' },
    { title: 'Schedules & hooks', href: '/hooks', keywords: 'triggers automation' },
    { title: 'Recovery & security', tab: 'security', keywords: 'uncertain outcome auto approve two factor' },
  ] },
  { name: 'Models & knowledge', description: 'Intelligence, instructions, and context.', icon: 'cpu', entries: [
    { title: 'Models & providers', href: '/models', keywords: 'ollama openrouter default local API' },
    { title: 'My models', tab: 'my-models', keywords: 'personal models keys' },
    { title: 'Topic assignments', href: '/topics', keywords: 'roles routing models', admin: true },
    { title: 'Skills', href: '/skills', keywords: 'instructions capabilities' },
    { title: 'Memory', href: '/memory', keywords: 'remember recall' },
    { title: 'Knowledge', href: '/knowledge', keywords: 'indexing sources embeddings documents' },
  ] },
  { name: 'Connected accounts', description: 'Services, mailboxes, and messaging.', icon: 'connect', entries: [
    { title: 'Accounts & services', tab: 'integrations', keywords: 'oauth google github gitlab appwrite integrations' },
    { title: 'Mailboxes', tab: 'mailboxes', keywords: 'email imap smtp multiple inbox calendar', module: 'mail' },
    { title: 'Channels', tab: 'channels', keywords: 'telegram teams slack whatsapp', module: 'channels' },
    { title: 'MCP & connectors', href: '/mcp', keywords: 'extensions plugins tools' },
  ] },
  { name: 'Machines & access', description: 'Where work runs and what it can reach.', icon: 'shield', entries: [
    { title: 'Workspace folders', tab: 'folders', keywords: 'paths project roots directories files' },
    { title: 'Environments & Access', tab: 'environments', keywords: 'host sandbox ssh gh oc tea CLI workstation installed programs' },
    { title: 'Permissions & exceptions', href: '/permissions', keywords: 'allow deny approvals scoped' },
    { title: 'Secrets', href: '/secrets', keywords: 'vault credentials keys' },
    { title: 'API Tokens', tab: 'api-tokens', keywords: 'tokens authentication' },
  ] },
  { name: 'System', description: 'Usage, diagnostics, and installation controls.', icon: 'settings', entries: [
    { title: 'Features & modules', tab: 'modules', keywords: 'enable disable modules' },
    { title: 'Usage & budgets', tab: 'usage', keywords: 'cost tokens cache limits spend' },
    { title: 'Health & diagnostics', tab: 'health', keywords: 'status services providers', admin: true },
    { title: 'Advanced configuration', tab: 'configuration', keywords: 'gateway logging API settings', admin: true },
    { title: 'Tools', href: '/tools', keywords: 'tool inventory', admin: true },
    { title: 'Evaluations', href: '/eval', keywords: 'tests benchmarks', admin: true },
    { title: 'Users', href: '/admin/users', keywords: 'users accounts roles', admin: true },
  ] },
];
