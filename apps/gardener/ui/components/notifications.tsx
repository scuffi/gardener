import { CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface Notice { id: number; title: string; description?: string; tone: "success" | "error" | "info" }
interface NotificationsValue { notify: (notice: Omit<Notice, "id">) => void }
const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const sequence = useRef(0);
  const dismiss = useCallback((id: number) => setNotices((current) => current.filter((notice) => notice.id !== id)), []);
  const notify = useCallback((notice: Omit<Notice, "id">) => {
    const id = ++sequence.current;
    setNotices((current) => [...current.slice(-2), { ...notice, id }]);
    if (notice.tone !== "error") window.setTimeout(() => dismiss(id), 4500);
  }, [dismiss]);
  const value = useMemo(() => ({ notify }), [notify]);

  return <NotificationsContext.Provider value={value}>
    {children}
    <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
      {notices.map((notice) => <div key={notice.id} className={`toast toast--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
        {notice.tone === "success" ? <CheckCircleIcon size={20} weight="fill" aria-hidden="true" /> : <WarningCircleIcon size={20} weight="fill" aria-hidden="true" />}
        <div><strong>{notice.title}</strong>{notice.description ? <p>{notice.description}</p> : null}</div>
        <button type="button" onClick={() => dismiss(notice.id)} aria-label="Dismiss notification"><XIcon size={16} /></button>
      </div>)}
    </div>
  </NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used within NotificationsProvider");
  return value;
}
