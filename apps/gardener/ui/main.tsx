import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link as RouterLink } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./app";
import { NotificationsProvider } from "./components/notifications";
import { consumeReturnedIdentity } from "./lib/api";
import { ThemeProvider } from "./theme";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to: _to, ...props }, ref) => (
  <RouterLink ref={ref} to={href ?? ""} {...props} />
));
AppLink.displayName = "AppLink";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

async function render(): Promise<void> {
  try {
    await consumeReturnedIdentity();
  } catch (error) {
    console.error("Unable to establish dashboard session", error);
  }
  createRoot(root!).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <NotificationsProvider>
              <BrowserRouter>
                <LinkProvider component={AppLink}>
                  <App />
                </LinkProvider>
              </BrowserRouter>
            </NotificationsProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void render();
