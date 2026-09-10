import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppDataProvider, useGardener } from "./app-context";
import { AppShell } from "./components/app-shell";
import { SignInPage } from "./components/sign-in-page";
import { SetupWizard } from "./components/setup-wizard";
import { LoadingState } from "./components/ui";

const InboxPage = lazy(() => import("./pages/inbox-page").then((module) => ({ default: module.InboxPage })));
const AgentsPage = lazy(() => import("./pages/agents-page").then((module) => ({ default: module.AgentsPage })));
const AgentEditorPage = lazy(() => import("./pages/agent-editor-page").then((module) => ({ default: module.AgentEditorPage })));
const AgentDetailPage = lazy(() => import("./pages/agent-detail-page").then((module) => ({ default: module.AgentDetailPage })));
const HistoryPage = lazy(() => import("./pages/history-page").then((module) => ({ default: module.HistoryPage })));
const RepositoriesPage = lazy(() => import("./pages/repositories-page").then((module) => ({ default: module.RepositoriesPage })));
const PoliciesPage = lazy(() => import("./pages/policies-page").then((module) => ({ default: module.PoliciesPage })));
const SettingsPage = lazy(() => import("./pages/settings-page").then((module) => ({ default: module.SettingsPage })));

function AppRoutes() {
  const { health, state, loading, error, authenticated } = useGardener();
  if (loading || (error && !health) || !authenticated) return <SignInPage />;
  if (!state?.setup.completed) return <AppShell><SetupWizard /></AppShell>;

  return <AppShell><Suspense fallback={<LoadingState label="Loading page" />}><Routes>
    <Route path="/" element={<Navigate to="/inbox" replace />} />
    <Route path="/inbox" element={<InboxPage />} />
    <Route path="/agents" element={<AgentsPage />} />
    <Route path="/agents/new" element={<AgentEditorPage />} />
    <Route path="/agents/:id/draft" element={<AgentEditorPage />} />
    <Route path="/agents/:id/revisions/:revision" element={<AgentDetailPage />} />
    <Route path="/agents/:id" element={<AgentDetailPage />} />
    <Route path="/history" element={<HistoryPage />} />
    <Route path="/repositories" element={<RepositoriesPage />} />
    <Route path="/policies" element={<PoliciesPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="*" element={<Navigate to="/inbox" replace />} />
  </Routes></Suspense></AppShell>;
}

export function App() { return <AppDataProvider><AppRoutes /></AppDataProvider>; }
