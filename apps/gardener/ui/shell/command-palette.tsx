import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { actionGroups, filterActionGroups, type Action, type ActionGroup } from "../actions";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { queryPrefixes } from "../lib/query-keys";
import { cn, CommandPalette } from "../primitives";
import { useNotifications } from "../providers/notifications";
import { useTheme } from "../theme";

const PaletteContext = createContext<{ open: () => void } | null>(null);

/** Opens the palette from anywhere in the shell. Safe to call when the provider is absent. */
export function useCommandPalette() {
  return useContext(PaletteContext) ?? { open: () => undefined };
}

/**
 * Button that opens the palette, shown in the app bar so the shortcut is discoverable rather
 * than folklore. The shortcut hint is hidden on touch layouts where no keyboard exists.
 */
export function CommandPaletteTrigger() {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={open}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "flex h-8 items-center gap-2 rounded-md border border-kumo-hairline bg-kumo-recessed",
        "px-2.5 text-xs text-kumo-subtle transition-colors",
        "hover:border-kumo-line hover:text-kumo-default",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus",
      )}
    >
      <MagnifyingGlassIcon size={14} aria-hidden="true" />
      <span className="max-lg:hidden">Search</span>
      <kbd
        aria-hidden="true"
        className={cn(
          "ml-4 rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5",
          "font-mono text-[10px] max-lg:hidden",
        )}
      >
        ⌘K
      </kbd>
    </button>
  );
}

/**
 * The ⌘K palette.
 *
 * Contents come from `ui/actions.ts`, which derives navigation from the route registry. Adding a
 * surface therefore adds a palette entry with no change here.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { state } = useGardener();
  const { resolvedTheme, setPreference, accent, setAccent } = useTheme();
  const { notify } = useNotifications();
  const queryClient = useQueryClient();

  const pauseMutation = useMutation({
    mutationFn: gardenerApi.setPaused,
    onSuccess: async ({ globalPaused }) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
      notify({
        tone: "success",
        title: globalPaused ? "Gardener paused" : "Gardener resumed",
        description: globalPaused
          ? "New work is paused. Operations already in progress may finish."
          : "Repository-specific pause settings remain in effect.",
      });
    },
    onError: (error: Error) =>
      notify({ tone: "error", title: "Unable to update automation", description: error.message }),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((previous) => !previous);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo(
    () =>
      filterActionGroups(
        actionGroups({
          state,
          resolvedTheme,
          setPreference,
          accent,
          setAccent,
          setPaused: (paused) => pauseMutation.mutate(paused),
        }),
        search,
      ),
    [state, resolvedTheme, setPreference, accent, setAccent, pauseMutation, search],
  );

  const dismiss = () => {
    setOpen(false);
    setSearch("");
  };

  const select = (action: Action) => {
    if (action.href) navigate(action.href);
    action.run?.();
    dismiss();
  };

  return (
    <PaletteContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      <CommandPalette.Root
        open={open}
        onOpenChange={(next: boolean) => (next ? setOpen(true) : dismiss())}
        items={groups}
        value={search}
        onValueChange={setSearch}
        itemToStringValue={(group: ActionGroup) => group.label}
        getSelectableItems={(items: ActionGroup[]) => items.flatMap((group) => group.items)}
        onSelect={(action: Action) => select(action)}
      >
        <CommandPalette.Input
          placeholder="Search surfaces and commands…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <CommandPalette.List>
          <CommandPalette.Results>
            {(group: ActionGroup) => (
              <CommandPalette.Group key={group.id} items={group.items}>
                <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
                <CommandPalette.Items>
                  {(action: Action) => (
                    <CommandPalette.Item
                      key={action.id}
                      value={action}
                      onClick={() => select(action)}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        {action.icon ? (
                          <action.icon size={16} aria-hidden="true" className="flex-none" />
                        ) : null}
                        <span className="min-w-0 truncate">{action.title}</span>
                        {action.description ? (
                          <span className="ml-auto hidden truncate text-xs text-kumo-subtle lg:block">
                            {action.description}
                          </span>
                        ) : null}
                      </span>
                    </CommandPalette.Item>
                  )}
                </CommandPalette.Items>
              </CommandPalette.Group>
            )}
          </CommandPalette.Results>
          <CommandPalette.Empty>No matching surface or command</CommandPalette.Empty>
        </CommandPalette.List>
      </CommandPalette.Root>
    </PaletteContext.Provider>
  );
}
