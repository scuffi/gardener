import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface Notice { title: string; description?: string; tone: "success" | "error" | "info" }
interface NotificationsValue { notify: (notice: Notice) => void }
const NotificationsContext = createContext<NotificationsValue | null>(null);

function NotificationsBridge({ children }: { children: ReactNode }) {
  const toastManager = useKumoToastManager();
  const notify = useCallback((notice: Notice) => {
    toastManager.add({
      title: notice.title,
      description: notice.description,
      variant: notice.tone,
      priority: notice.tone === "error" ? "high" : "low",
      timeout: notice.tone === "error" ? 0 : 4_500,
    });
  }, [toastManager]);
  const value = useMemo(() => ({ notify }), [notify]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  return <Toasty><NotificationsBridge>{children}</NotificationsBridge></Toasty>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used within NotificationsProvider");
  return value;
}
