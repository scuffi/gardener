import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, gardenerApi } from "./lib/api";
import { queryKeys, queryPrefixes } from "./lib/query-keys";
import type { AppState, HealthState } from "./lib/types";
import { useNotifications } from "./providers/notifications";
import { defaultRoute } from "./routes";

interface AppContextValue {
  health: HealthState | null;
  state: AppState | null;
  loading: boolean;
  stateLoading: boolean;
  error: Error | null;
  authenticated: boolean;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [sessionRevision, setSessionRevision] = useState(0);
  const installationHandled = useRef(false);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: gardenerApi.health,
    retry: 1,
    staleTime: 30_000,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.session(sessionRevision),
    queryFn: gardenerApi.session,
    retry: false,
  });
  const authenticated = Boolean(
    sessionQuery.data?.authenticated || healthQuery.data?.localDevelopment,
  );
  const stateQuery = useQuery({
    queryKey: queryKeys.state(sessionRevision),
    queryFn: gardenerApi.state,
    enabled: authenticated,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
  });

  useEffect(() => {
    if (!(stateQuery.error instanceof ApiError) || stateQuery.error.status !== 401) return;
    queryClient.setQueryData(queryKeys.session(sessionRevision), { authenticated: false });
    notify({ tone: "error", title: "Dashboard session expired", description: "Sign in again to continue." });
  }, [stateQuery.error, notify]);

  useEffect(() => {
    const installationComplete = new URLSearchParams(location.search).get("installation") === "complete";
    if (!installationComplete || !authenticated || installationHandled.current) return;
    installationHandled.current = true;
    void gardenerApi
      .syncRepositories()
      .then(async () => {
        history.replaceState(null, "", defaultRoute);
        await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
        notify({
          tone: "success",
          title: "Repository access connected",
          description: "Choose how Gardener should handle GitHub actions.",
        });
      })
      .catch((error: unknown) => {
        notify({
          tone: "error",
          title: "Repository sync failed",
          description:
            error instanceof Error ? error.message : "Try again from Repositories.",
        });
      });
  }, [authenticated, notify, queryClient]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      queryClient.invalidateQueries({ queryKey: queryPrefixes.state }),
    ]);
  }, [queryClient]);

  const signOut = useCallback(() => {
    void gardenerApi.signOut().finally(() => {
      queryClient.removeQueries({ queryKey: queryPrefixes.state });
      setSessionRevision((value) => value + 1);
    });
  }, [queryClient]);

  const value = useMemo<AppContextValue>(
    () => ({
      health: healthQuery.data ?? null,
      state: stateQuery.data ?? null,
      loading:
        healthQuery.isLoading || sessionQuery.isLoading || (authenticated && stateQuery.isLoading),
      stateLoading: stateQuery.isLoading,
      error: (healthQuery.error ?? stateQuery.error) as Error | null,
      authenticated,
      refresh,
      signOut,
    }),
    [
      healthQuery.data,
      healthQuery.isLoading,
      healthQuery.error,
      sessionQuery.isLoading,
      stateQuery.data,
      stateQuery.isLoading,
      stateQuery.error,
      authenticated,
      refresh,
      signOut,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useGardener(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useGardener must be used within AppDataProvider");
  return value;
}
