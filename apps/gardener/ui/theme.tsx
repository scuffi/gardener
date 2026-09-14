import { DesktopIcon, MoonIcon, SunIcon, type Icon } from "@phosphor-icons/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button, Radio } from "./primitives";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = Exclude<ThemePreference, "system">;

/** Brand accent. Colour values live in `accents.css`; this only selects between them. */
export type Accent = "orange" | "green";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const STORAGE_KEY = "gardener.theme";
const ACCENT_STORAGE_KEY = "gardener.accent";
const DEFAULT_ACCENT: Accent = "orange";
const ThemeContext = createContext<ThemeContextValue | null>(null);

const accentOptions: Array<{ value: Accent; label: string; description: string }> = [
  { value: "orange", label: "Cloudflare orange", description: "The default Cloudflare accent" },
  { value: "green", label: "Gardener green", description: "Leans into the gardening metaphor" },
];

const options: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: Icon;
}> = [
  { value: "system", label: "System", description: "Follow this device", icon: DesktopIcon },
  { value: "light", label: "Light", description: "Bright and airy", icon: SunIcon },
  { value: "dark", label: "Dark", description: "Low-light workspace", icon: MoonIcon },
];

/*
 * These neutral swatch fills intentionally stay fixed: each thumbnail must preview its named
 * scheme instead of inheriting the currently active scheme. Product UI still uses Kumo tokens.
 */
const previewStyles: Record<
  ThemePreference,
  { canvas: CSSProperties; rail: CSSProperties; primary: CSSProperties; secondary: CSSProperties }
> = {
  light: {
    canvas: { background: "rgb(252 252 252)" },
    rail: { background: "rgb(255 255 255)" },
    primary: { background: "rgb(217 217 217)" },
    secondary: { background: "rgb(232 232 232)" },
  },
  dark: {
    canvas: { background: "rgb(40 40 40)" },
    rail: { background: "rgb(40 40 40)" },
    primary: { background: "rgb(89 89 89)" },
    secondary: { background: "rgb(59 59 59)" },
  },
  system: {
    canvas: { background: "linear-gradient(90deg, rgb(252 252 252) 50%, rgb(40 40 40) 50%)" },
    rail: { background: "linear-gradient(90deg, rgb(255 255 255) 50%, rgb(40 40 40) 50%)" },
    primary: { background: "linear-gradient(90deg, rgb(217 217 217) 50%, rgb(89 89 89) 50%)" },
    secondary: { background: "linear-gradient(90deg, rgb(232 232 232) 50%, rgb(59 59 59) 50%)" },
  },
};

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
  // design-system-exempt: browser chrome (address bar) cannot read CSS custom properties, so the
  // theme-color meta tag must carry literal values. Keep in step with --color-kumo-canvas.
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", resolvedTheme === "dark" ? "#0f0f0f" : "#fcfcfc");
}

function storedAccent(): Accent {
  try {
    return localStorage.getItem(ACCENT_STORAGE_KEY) === "green" ? "green" : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [accent, setAccentState] = useState<Accent>(storedAccent);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const resolvedTheme = preference === "system" ? system : preference;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* Theme still applies for this session. */
    }
    applyTheme(preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  useEffect(() => {
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    } catch {
      /* Accent still applies for this session. */
    }
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      setPreference: setPreferenceState,
      accent,
      setAccent: setAccentState,
    }),
    [preference, resolvedTheme, accent],
  );

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

  return (
    <Button
      type="button"
      variant="secondary"
      shape="square"
      className="text-kumo-default max-[900px]:size-11"
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      title={`${dark ? "Dark" : "Light"} theme`}
      icon={CurrentIcon}
      onClick={() => setPreference(dark ? "light" : "dark")}
    />
  );
}

/**
 * Brand accent chooser. Each swatch pins its own subtree with `data-accent`, so the preview is
 * rendered by the same token the app uses rather than a duplicated colour value. Change a colour
 * in `accents.css` and these previews follow automatically.
 */
export function AccentPicker() {
  const { accent, setAccent } = useTheme();

  return (
    <Radio.Group<Accent>
      appearance="card"
      orientation="horizontal"
      value={accent}
      onValueChange={setAccent}
      className="p-[18px_20px_20px] [&>div]:grid-cols-2 max-md:[&>div]:grid-cols-1 max-sm:p-4"
    >
      <Radio.Legend className="sr-only">Brand accent</Radio.Legend>
      {accentOptions.map((option) => (
        <Radio.Item<Accent>
          key={option.value}
          value={option.value}
          className="min-w-0"
          label={
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
              <span
                data-accent={option.value}
                aria-hidden="true"
                className={
                  "grid h-12 w-[52px] place-items-center rounded-md border border-kumo-line "
                  + "bg-kumo-brand"
                }
              >
                <span className="h-[5px] w-6 rounded-full bg-kumo-canvas/70" />
              </span>
              <span className="grid min-w-0 gap-0.5">
                <strong className="text-xs text-kumo-strong">{option.label}</strong>
                <small className="text-xs font-normal text-kumo-default">
                  {option.description}
                </small>
              </span>
            </span>
          }
        />
      ))}
    </Radio.Group>
  );
}

export function ThemePicker() {
  const { preference, setPreference } = useTheme();

  return (
    <Radio.Group<ThemePreference>
      appearance="card"
      orientation="horizontal"
      value={preference}
      onValueChange={setPreference}
      className={
        "p-[18px_20px_20px] [&>div]:grid-cols-3 max-md:[&>div]:grid-cols-1 " +
        "max-sm:p-4"
      }
    >
      <Radio.Legend className="sr-only">Color theme</Radio.Legend>
      {options.map((option) => {
        const OptionIcon = option.icon;
        const preview = previewStyles[option.value];
        return (
          <Radio.Item<ThemePreference>
            key={option.value}
            value={option.value}
            className="min-w-0"
            label={
              <span className="grid min-w-0 grid-cols-[78px_minmax(0,1fr)] items-center gap-3">
                <span
                  style={preview.canvas}
                  aria-hidden="true"
                  className={
                    "relative grid h-12 w-[78px] place-items-center overflow-hidden rounded-md " +
                    "border border-kumo-line text-kumo-subtle"
                  }
                >
                  <span
                    style={preview.rail}
                    className="absolute inset-y-0 left-0 w-[17px] border-r border-kumo-hairline"
                  />
                  <span className="absolute top-[7px] right-1.5 left-[23px] grid gap-[5px]">
                    <span style={preview.primary} className="h-[5px] rounded-full" />
                    <span style={preview.secondary} className="h-[5px] rounded-full" />
                    <span style={preview.secondary} className="h-[5px] rounded-full" />
                  </span>
                  <OptionIcon className="relative z-10 -ml-[38px]" size={18} />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <strong className="text-xs text-kumo-strong">{option.label}</strong>
                  <small className="text-xs font-normal text-kumo-default">
                    {option.description}
                  </small>
                </span>
              </span>
            }
          />
        );
      })}
    </Radio.Group>
  );
}
