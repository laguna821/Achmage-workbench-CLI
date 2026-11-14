import { ChannelService, type ChannelServiceOptions } from "./service.ts";

// Which gateway runs the messenger channel, and with what. The window's gateway and the background
// service (which keeps running with the window closed, and is what "PC를 켜면 자동으로 시작" starts)
// both do; a one-off command-line gateway does not.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A stand-in Bot API (or Slack Web API) for checks, accepted only on this machine: the tokens go to it. */
function standInApi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname) && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the sealed Mini App form is hosted (design §6.3 (ii)), from WORKBENCH_SEAL_PAGE: only an
 * HTTPS address of seal-v1.html, without credentials, query or fragment. Unset (the default: the
 * owner has not chosen where to host it), values typed in the chat are taken and deleted at once.
 */
export function sealPageOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/seal-v1.html") ? url.href : null;
  } catch {
    return null;
  }
}

/** `vault`: the gateway's own, so the master key is opened (or made) once for every service that seals. */
export function gatewayChannels(env: Record<string, string | undefined>, deps: Pick<ChannelServiceOptions, "dataDir" | "store" | "manager" | "bus" | "vault" | "projects" | "credentials" | "logins">): ChannelService | undefined {
  if (env.WORKBENCH_CLI_INPUT) return undefined;
  const telegramUrl = standInApi(env.WORKBENCH_TELEGRAM_API);
  const slackUrl = standInApi(env.WORKBENCH_SLACK_API);
  return new ChannelService({ ...deps, ...(telegramUrl ? { telegramUrl } : {}), ...(slackUrl ? { slackUrl: `${slackUrl}/api` } : {}), sealPage: sealPageOf(env.WORKBENCH_SEAL_PAGE) });
}
