import { Button } from "@cloudflare/kumo/components/button";
import { DesktopIcon, MoonIcon, SunIcon, type Icon } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = Exclude<ThemePreference, "system">;

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const STORAGE_KEY = "gardener.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

const options: Array<{ value: ThemePreference; label: string; description: string; icon: Icon }> = [
  { value: "system", label: "System", description: "Follow this device", icon: DesktopIcon },
  { value: "light", label: "Light", description: "Bright and airy", icon: SunIcon },
  { value: "dark", label: "Dark", description: "Low-light workspace", icon: MoonIcon },
];

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme) {
  document.documentElement.dataset.mode = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", resolvedTheme === "dark" ? "#0f0f0f" : "#fcfcfc");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const resolvedTheme = preference === "system" ? system : preference;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Theme still applies for this session. */ }
    applyTheme(preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  const value = useMemo<ThemeContextValue>(() => ({
    preference,
    resolvedTheme,
    setPreference: setPreferenceState,
  }), [preference, resolvedTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

export function ThemeToggle() {
  const { resolvedTheme, setPreference } = useTheme();
  const dark = resolvedTheme === "dark";
  const CurrentIcon = dark ? MoonIcon : SunIcon;
  return <Button
    type="button"
    variant="secondary"
    shape="square"
    className="theme-toggle"
    aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
    title={`${dark ? "Dark" : "Light"} theme`}
    icon={CurrentIcon}
    onClick={() => setPreference(dark ? "light" : "dark")}
  />;
}

export function ThemePicker() {
  const { preference, setPreference } = useTheme();
  return <div className="theme-picker" role="radiogroup" aria-label="Color theme">
    {options.map((option) => {
      const OptionIcon = option.icon;
      const selected = preference === option.value;
      return <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        className={`theme-option${selected ? " theme-option--selected" : ""}`}
        onClick={() => setPreference(option.value)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const group = event.currentTarget.parentElement;
          const current = options.findIndex((item) => item.value === option.value);
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
            : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + options.length) % options.length;
          setPreference(options[nextIndex]!.value);
          requestAnimationFrame(() => group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus());
        }}
      >
        <span className={`theme-option__preview theme-option__preview--${option.value}`} aria-hidden="true"><OptionIcon size={18} /></span>
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </button>;
    })}
  </div>;
}
