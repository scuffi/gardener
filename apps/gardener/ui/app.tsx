import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppDataProvider, useGardener } from "./app-context";
import { AppShell } from "./components/app-shell";
import { SignInPage } from "./components/sign-in-page";
import { SetupWizard } from "./components/setup-wizard";
import { ErrorState, LoadingState } from "./components/ui";

const OverviewPage = lazy(() => import("./pages/overview-page").then((module) => ({ default: module.OverviewPage })));
const RepositoriesPage = lazy(() => import("./pages/repositories-page").then((module) => ({ default: module.RepositoriesPage })));
const WorkflowsPage = lazy(() => import("./pages/workflows-page").then((module) => ({ default: module.WorkflowsPage })));
const WorkflowBuilderPage = lazy(() => import("./pages/workflow-builder-page").then((module) => ({ default: module.WorkflowBuilderPage })));
const WorkflowDetailPage = lazy(() => import("./pages/workflow-detail-page").then((module) => ({ default: module.WorkflowDetailPage })));
const RunsPage = lazy(() => import("./pages/runs-page").then((module) => ({ default: module.RunsPage })));
const ApprovalsPage = lazy(() => import("./pages/approvals-page").then((module) => ({ default: module.ApprovalsPage })));
const PoliciesPage = lazy(() => import("./pages/policies-page").then((module) => ({ default: module.PoliciesPage })));
const SettingsPage = lazy(() => import("./pages/settings-page").then((module) => ({ default: module.SettingsPage })));

function AppRoutes() {
  const { health, state, loading, error, authenticated, refresh } = useGardener();
  const location = useLocation();
  const setupComplete = Boolean(state?.setup.completed);

  if (loading) return <AppShell><div className="page-loading"><LoadingState label={health ? "Loading workspace" : "Checking deployment"} /></div></AppShell>;
  if (error && !health) return <AppShell><ErrorState title="Unable to reach this deployment" message={error.message} onRetry={() => void refresh()} /></AppShell>;
  if (!authenticated) return <AppShell><SignInPage /></AppShell>;
  if (!setupComplete) {
    return <AppShell>
      {location.pathname !== "/overview" && location.pathname !== "/" ? <Navigate to="/overview" replace /> : null}
      <SetupWizard />
    </AppShell>;
  }

  return <AppShell><Suspense fallback={<LoadingState label="Loading page" />}><Routes>
    <Route path="/" element={<Navigate to="/overview" replace />} />
    <Route path="/overview" element={<OverviewPage />} />
    <Route path="/repositories" element={<RepositoriesPage />} />
    <Route path="/workflows" element={<WorkflowsPage />} />
    <Route path="/workflows/new" element={<WorkflowBuilderPage />} />
    <Route path="/workflows/:id/edit" element={<WorkflowBuilderPage />} />
    <Route path="/workflows/:id/revisions/:revision" element={<WorkflowDetailPage />} />
    <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
    <Route path="/runs" element={<RunsPage />} />
    <Route path="/approvals" element={<ApprovalsPage />} />
    <Route path="/policies" element={<PoliciesPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="*" element={<Navigate to="/overview" replace />} />
  </Routes></Suspense></AppShell>;
}

export function App() {
  return <AppDataProvider><AppRoutes /></AppDataProvider>;
}
