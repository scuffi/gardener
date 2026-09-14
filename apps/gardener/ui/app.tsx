import { lazy, Suspense, type ComponentType } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppDataProvider, useGardener } from "./app-context";
import { SignInPage } from "./features/auth/sign-in-page";
import { SetupWizard } from "./features/setup/setup-wizard";
import { ErrorState, PageHeader, PageHeaderSkeleton } from "./primitives";
import { defaultRoute, routes } from "./routes";
import { AppShell } from "./shell/app-shell";

/**
 * Lazy page components, built once from the route registry.
 *
 * `lazy()` must run at module scope so the component identity is stable across renders.
 */
const pages = new Map<string, ComponentType>(
  routes.map((route) => [route.id, lazy(route.load) as unknown as ComponentType]),
);

function AppRoutes() {
  const { health, loading, error, state, authenticated, refresh } = useGardener();

  if (loading || (error && !health) || !authenticated) return <SignInPage />;
  if (error && !state) {
    return (
      <AppShell>
        <PageHeader
          title="Unable to load Gardener"
          description="The dashboard could not read this instance's current state."
        />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </AppShell>
    );
  }
  if (!state?.setup.completed) {
    return (
      <AppShell>
        <SetupWizard />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<PageHeaderSkeleton />}>
        {/* `/` is a real route (Overview), so it is rendered from the registry like any other. */}
        <Routes>
          {routes.flatMap((route) => {
            const Page = pages.get(route.id)!;
            const element = <Page />;
            return [route.path, ...(route.extraPaths ?? [])].map((path) => (
              <Route key={path} path={path} element={element} />
            ));
          })}
          <Route path="*" element={<Navigate to={defaultRoute} replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export function App() {
  return (
    <AppDataProvider>
      <AppRoutes />
    </AppDataProvider>
  );
}
