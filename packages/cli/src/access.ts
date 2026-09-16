import { spawnSync } from "node:child_process";

export class CloudflareAccessRedirectError extends Error {
  constructor(readonly url: string) {
    super(`Cloudflare Access is protecting ${new URL(url).hostname}`);
    this.name = "CloudflareAccessRedirectError";
  }
}

export async function fetchJsonEndpoint(
  url: string,
  init: RequestInit,
  options: { label: string; allowUserAccess?: boolean },
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (isCloudflareAccessRedirect(response)) {
    if (options.allowUserAccess) return cloudflaredAccessJson(url, options.label);
    throw new CloudflareAccessRedirectError(url);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.label} failed (${response.status})`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown content type";
    throw new Error(`${options.label} returned ${contentType}, not JSON`);
  }
}

export function cloudflaredAccessJson(url: string, label: string): unknown {
  const result = spawnSync("cloudflared", ["access", "curl", url, "-sS"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      `${label} is protected by Cloudflare Access. Install cloudflared and rerun setup to verify it `
      + "with your Cloudflare identity.",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} could not be verified through Cloudflare Access`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`${label} returned a non-JSON response through Cloudflare Access`);
  }
}

function isCloudflareAccessRedirect(response: Response): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("location");
  if (!location) return false;
  try {
    return new URL(location).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}
