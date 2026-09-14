import { describe, expect, it, vi } from "vitest";
import { actionGroups, filterActionGroups, globalResumeDescription } from "./actions";
import { routes } from "./routes";

/**
 * The palette derives navigation from the route registry, so these tests mostly guard that
 * derivation: adding a surface must surface it in ⌘K without anyone editing the palette.
 */

const context = () => ({
  state: null,
  resolvedTheme: "light" as const,
  setPreference: vi.fn(),
  setPaused: vi.fn(),
});

describe("command palette actions", () => {
  it("offers every sidebar surface without needing a palette edit", () => {
    const navigate = actionGroups(context()).find((group) => group.id === "navigate");
    const paths = navigate?.items.map((item) => item.href);

    for (const route of routes.filter((candidate) => candidate.group)) {
      expect(paths, `${route.label} is missing from the palette`).toContain(route.path);
    }
  });

  it("omits routes that need an id, since they cannot be navigated blind", () => {
    const navigate = actionGroups(context()).find((group) => group.id === "navigate");
    for (const item of navigate?.items ?? []) {
      expect(item.href).not.toContain(":");
    }
  });

  it("labels the pause command by what it will do, not the current state", () => {
    const running = actionGroups({ ...context(), state: { globalPaused: false } as never });
    const paused = actionGroups({ ...context(), state: { globalPaused: true } as never });

    const titleOf = (groups: ReturnType<typeof actionGroups>) =>
      groups.find((group) => group.id === "commands")?.items.find((i) => i.id === "cmd:pause")
        ?.title;

    expect(titleOf(running)).toBe("Pause Gardener globally");
    expect(titleOf(paused)).toBe("Resume Gardener globally");
  });

  it("runs the pause command against the inverse of the current state", () => {
    const setPaused = vi.fn();
    const groups = actionGroups({
      ...context(),
      state: { globalPaused: false } as never,
      setPaused,
    });
    groups.find((group) => group.id === "commands")?.items.find((i) => i.id === "cmd:pause")?.run?.();
    expect(setPaused).toHaveBeenCalledWith(true);
  });

  it("guards the global resume command with exact confirmation copy", () => {
    const groups = actionGroups({
      ...context(),
      state: { globalPaused: true } as never,
    });
    const resume = groups
      .find((group) => group.id === "commands")
      ?.items.find((item) => item.id === "cmd:pause");

    expect(resume?.confirmation).toEqual({
      title: "Resume Gardener globally?",
      description: globalResumeDescription,
      confirmLabel: "Resume Gardener globally",
    });
  });

  it("matches on keywords that are not visible in the label", () => {
    const filtered = filterActionGroups(actionGroups(context()), "kill switch");
    const ids = filtered.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toContain("cmd:pause");
  });

  it("drops groups that have no matches, and returns everything for an empty query", () => {
    const all = actionGroups(context());
    expect(filterActionGroups(all, "   ")).toHaveLength(all.length);
    expect(filterActionGroups(all, "zzzznotathing")).toHaveLength(0);
  });
});
