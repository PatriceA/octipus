/**
 * The route table, one entry per page module.
 *
 * Generated from the directory layout the file-router used, so the URLs are
 * unchanged. Pages are lazy so the initial bundle is the shell rather than all
 * forty-four screens.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { AppShell } from '@/components/app-shell';
import { Providers } from './app/providers';
import AdminLayout from './app/admin/layout';

const Home = lazy(() => import('./app/page'));
const AdminPage = lazy(() => import('./app/admin/page'));
const AdminAuditPage = lazy(() => import('./app/admin/audit/page'));
const AdminOrgsPage = lazy(() => import('./app/admin/orgs/page'));
const AdminOrgsSsoPage = lazy(() => import('./app/admin/orgs/sso/page'));
const AdminQuotasPage = lazy(() => import('./app/admin/quotas/page'));
const AdminUsersPage = lazy(() => import('./app/admin/users/page'));
const AgentsPage = lazy(() => import('./app/agents/page'));
const AgentsViewPage = lazy(() => import('./app/agents/view/page'));
const ArtifactsPage = lazy(() => import('./app/artifacts/page'));
const ArtifactsNewPage = lazy(() => import('./app/artifacts/new/page'));
const ArtifactsViewPage = lazy(() => import('./app/artifacts/view/page'));
const ChatPage = lazy(() => import('./app/chat/page'));
const DocumentsPage = lazy(() => import('./app/documents/page'));
const EmailPage = lazy(() => import('./app/email/page'));
const EvalPage = lazy(() => import('./app/eval/page'));
const EvalComparePage = lazy(() => import('./app/eval/compare/page'));
const EvalRedTeamPage = lazy(() => import('./app/eval/red-team/page'));
const EvalViewPage = lazy(() => import('./app/eval/view/page'));
const ExpertsPage = lazy(() => import('./app/experts/page'));
const GraphPage = lazy(() => import('./app/graph/page'));
const HooksPage = lazy(() => import('./app/hooks/page'));
const KnowledgePage = lazy(() => import('./app/knowledge/page'));
const LinkAccountPage = lazy(() => import('./app/link-account/page'));
const LoginPage = lazy(() => import('./app/login/page'));
const McpPage = lazy(() => import('./app/mcp/page'));
const MemoryPage = lazy(() => import('./app/memory/page'));
const ModelsPage = lazy(() => import('./app/models/page'));
const NotesPage = lazy(() => import('./app/notes/page'));
const PermissionsPage = lazy(() => import('./app/permissions/page'));
const PersonaPage = lazy(() => import('./app/persona/page'));
const PipelinesPage = lazy(() => import('./app/pipelines/page'));
const ProfilesPage = lazy(() => import('./app/profiles/page'));
const ReaderPage = lazy(() => import('./app/reader/page'));
const ResearchPage = lazy(() => import('./app/research/page'));
const RunsViewPage = lazy(() => import('./app/runs/view/page'));
const SecretsPage = lazy(() => import('./app/secrets/page'));
const SettingsPage = lazy(() => import('./app/settings/page'));
const SetupPage = lazy(() => import('./app/setup/page'));
const SkillsPage = lazy(() => import('./app/skills/page'));
const SkillsProposalsPage = lazy(() => import('./app/skills/proposals/page'));
const TasksPage = lazy(() => import('./app/tasks/page'));
const ToolsPage = lazy(() => import('./app/tools/page'));
const TopicsPage = lazy(() => import('./app/topics/page'));

function Loading() {
  return <div className="p-8 font-mono text-on-surface-variant">loading…</div>;
}

/**
 * The shell wraps every route. `Providers` sits outside the router's outlet so
 * the query client, auth and workspace contexts survive navigation instead of
 * remounting on each one.
 */
function Shell() {
  return (
    <Providers>
      <AppShell>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </Providers>
  );
}

/** `/admin/*` renders inside the admin gate, as it did under the file router. */
function AdminShell() {
  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Home /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'agents/view', element: <AgentsViewPage /> },
      { path: 'artifacts', element: <ArtifactsPage /> },
      { path: 'artifacts/new', element: <ArtifactsNewPage /> },
      { path: 'artifacts/view', element: <ArtifactsViewPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'email', element: <EmailPage /> },
      { path: 'eval', element: <EvalPage /> },
      { path: 'eval/compare', element: <EvalComparePage /> },
      { path: 'eval/red-team', element: <EvalRedTeamPage /> },
      { path: 'eval/view', element: <EvalViewPage /> },
      { path: 'experts', element: <ExpertsPage /> },
      { path: 'graph', element: <GraphPage /> },
      { path: 'hooks', element: <HooksPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
      { path: 'link-account', element: <LinkAccountPage /> },
      { path: 'mcp', element: <McpPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'models', element: <ModelsPage /> },
      { path: 'notes', element: <NotesPage /> },
      { path: 'permissions', element: <PermissionsPage /> },
      { path: 'persona', element: <PersonaPage /> },
      { path: 'pipelines', element: <PipelinesPage /> },
      { path: 'profiles', element: <ProfilesPage /> },
      { path: 'reader', element: <ReaderPage /> },
      { path: 'research', element: <ResearchPage /> },
      { path: 'runs/view', element: <RunsViewPage /> },
      { path: 'secrets', element: <SecretsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'setup', element: <SetupPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'skills/proposals', element: <SkillsProposalsPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tools', element: <ToolsPage /> },
      { path: 'topics', element: <TopicsPage /> },
      { path: 'login', element: <LoginPage /> },
      {
        path: 'admin',
        element: <AdminShell />,
        children: [
        { index: true, element: <AdminPage /> },
        { path: 'audit', element: <AdminAuditPage /> },
        { path: 'orgs', element: <AdminOrgsPage /> },
        { path: 'orgs/sso', element: <AdminOrgsSsoPage /> },
        { path: 'quotas', element: <AdminQuotasPage /> },
        { path: 'users', element: <AdminUsersPage /> },
        ],
      },
    ],
  },
]);

export function Router() {
  return <RouterProvider router={router} />;
}
