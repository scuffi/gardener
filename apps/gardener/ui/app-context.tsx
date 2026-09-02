import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, clearSession, gardenerApi, hasSession } from "./lib/api";
import type { AppState, HealthState } from "./lib/types";
import { useNotifications } from "./components/notifications";

interface AppContextValue {
  health: HealthState | null;
  state: AppState | null;
  loading: boolean;
  stateLoading: boolean;
  error: Error | null;
  authenticated: boolean;
  refresh: () => Promise<void>;
  signOut: () => void;
  establishSession: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [sessionRevision, setSessionRevision] = useState(0);
  const installationHandled = useRef(false);
  const sessionPresent = hasSession();
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: gardenerApi.health, retry: 1, staleTime: 30_000 });
  const authenticated = sessionPresent || Boolean(healthQuery.data?.localDevelopment);
  const stateQuery = useQuery({
    queryKey: ["state", sessionRevision],
    queryFn: gardenerApi.state,
    enabled: authenticated,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
  });

  useEffect(() => {
    if (!(stateQuery.error instanceof ApiError) || stateQuery.error.status !== 401) return;
    clearSession();
    setSessionRevision((value) => value + 1);
    notify({ tone: "error", title: "Dashboard session expired", description: "Connect GitHub again to continue." });
  }, [stateQuery.error, notify]);

  useEffect(() => {
    const installationComplete = new URLSearchParams(location.search).get("installation") === "complete";
    if (!installationComplete || !authenticated || installationHandled.current) return;
    installationHandled.current = true;
    void gardenerApi.syncRepositories().then(async () => {
      history.replaceState(null, "", "/overview");
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      notify({ tone: "success", title: "Repository access connected", description: "Choose how Gardener should handle GitHub actions." });
    }).catch((error: unknown) => {
      notify({ tone: "error", title: "Repository sync failed", description: error instanceof Error ? error.message : "Try again from Repositories." });
    });
  }, [authenticated, notify, queryClient]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["health"] }),
      queryClient.invalidateQueries({ queryKey: ["state"] }),
    ]);
  }, [queryClient]);

  const signOut = useCallback(() => {
    clearSession();
    queryClient.removeQueries({ queryKey: ["state"] });
    setSessionRevision((value) => value + 1);
  }, [queryClient]);

  const establishSession = useCallback(() => setSessionRevision((value) => value + 1), []);
  const value = useMemo<AppContextValue>(() => ({
    health: healthQuery.data ?? null,
    state: stateQuery.data ?? null,
    loading: healthQuery.isLoading || (authenticated && stateQuery.isLoading),
    stateLoading: stateQuery.isLoading,
    error: (healthQuery.error ?? stateQuery.error) as Error | null,
    authenticated,
    refresh,
    signOut,
    establishSession,
  }), [healthQuery.data, healthQuery.isLoading, healthQuery.error, stateQuery.data, stateQuery.isLoading, stateQuery.error, authenticated, refresh, signOut, establishSession]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useGardener(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useGardener must be used within AppDataProvider");
  return value;
}
