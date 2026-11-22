import { BaskStreamClient, BaskStreamError, StationHttp, type Actor } from "@basidekick/baskstream";
import { getProfile, loadStore, loginChoices, putProfile, setCurrent, updateProfile, type Profile } from "./config.js";
import { promptHidden, promptLine } from "./prompt.js";

export interface Connection {
  client: BaskStreamClient;
  profileName: string;
  /** After this, a re-login needs the password from the environment or the one typed at startup. */
  stopPrompting(): void;
}

/**
 * Connects with a saved profile. The saved session is reused; if it has expired the password
 * comes from BASKSTREAM_PASSWORD or a prompt, and is kept in memory only for later reconnects.
 */
export async function connect(profileName?: string, options: { beforePrompt?: () => void; actor?: Actor; password?: string; prompt?: boolean; promptLabel?: string; envPassword?: boolean } = {}): Promise<Connection> {
  let { name, profile } = getProfile(profileName);
  // A person at a terminal whose saved login no longer works chooses: the same login (just the
  // password) or a new one (user name and password). Nothing is asked while the session is good.
  const asking = options.prompt !== false && !options.promptLabel && options.password === undefined && process.env.BASKSTREAM_PASSWORD === undefined && !!process.stdin.isTTY;
  if (asking && !(await loggedIn(profile))) {
    options.beforePrompt?.();
    ({ name, profile } = await sameOrNew(name, profile));
  }
  // BASKSTREAM_PASSWORD is the person's own: a second login (an agent's) passes `envPassword: false`.
  let typed: string | undefined = options.password ?? (options.envPassword === false ? undefined : process.env.BASKSTREAM_PASSWORD);
  // With `prompt: false` an expired session is an error to show, not a question to ask (several stations at once).
  let mayPrompt = options.prompt !== false;
  const password = async () => {
    if (typed !== undefined) return typed;
    if (!mayPrompt) throw new Error(options.prompt === false ? `The saved login expired. Run: bask login ${profile.station} -u ${profile.username ?? "<user>"} --name ${name}${profile.insecure ? " -k" : ""}` : "The station session expired. Quit and run bask again to log in.");
    options.beforePrompt?.();
    typed = await promptHidden(options.promptLabel ?? `Password for ${profile.username}@${new URL(profile.station).host}: `);
    return typed;
  };
  let client: BaskStreamClient;
  for (let attempt = 1; ; attempt++) {
    try {
      client = await BaskStreamClient.connect({
        station: profile.station,
        username: profile.username,
        password,
        verifyTls: !profile.insecure,
        cookies: profile.cookies,
        onSession: (cookies) => updateProfile(name, { cookies }),
        actor: options.actor
      });
      break;
    } catch (error) {
      // A mistyped password is asked for again, twice at most: a station locks a user out after too many.
      if (!(asking && attempt < 3 && error instanceof BaskStreamError && error.code === "login_failed" && /wrong username or password/i.test(error.message))) throw error;
      process.stderr.write(`The station did not accept that password for ${profile.username}. Try again, or ctrl-C to stop.\n`);
      typed = undefined;
    }
  }
  return { client, profileName: name, stopPrompting: () => (mayPrompt = false) };
}

/** Whether a profile's saved session is still good. A station that cannot be reached counts as good: connecting reports that better. */
async function loggedIn(profile: Profile): Promise<boolean> {
  if (!profile.cookies) return false;
  try {
    return !!(await new StationHttp({ station: profile.station, verifyTls: !profile.insecure, cookies: profile.cookies, timeoutMs: 10000 }).health());
  } catch {
    return true;
  }
}

/** Asks whether to log in as the same user or a new one, and gives back the profile to log in with (made current). */
async function sameOrNew(name: string, profile: Profile): Promise<{ name: string; profile: Profile }> {
  const host = new URL(profile.station).host;
  const others = loginChoices(loadStore(), name).slice(1);
  process.stderr.write(`\n${host}: the saved login${profile.cookies ? " has expired" : " is logged out"}.\n\n`);
  if (profile.username) process.stderr.write(`  enter   same login: ${profile.username} (just the password)\n`);
  process.stderr.write(`  n       new login (user name and password)\n\n`);
  const choice = profile.username ? await promptLine("Same or new? ") : "n";
  if (profile.username && !/^n/i.test(choice)) return { name, profile };
  const user = await promptLine(`User name${others.length ? ` (saved for this station: ${others.map((o) => o.user).join(", ")})` : ""}: `);
  if (!user || user.toLowerCase() === profile.username?.toLowerCase()) return { name, profile };
  // A user already saved for this station keeps its profile; a new one gets its own.
  const saved = others.find((o) => o.user.toLowerCase() === user.toLowerCase());
  const next = saved?.profile ?? `${user}@${new URL(profile.station).hostname}`;
  if (saved) setCurrent(next);
  else putProfile(next, { station: profile.station, username: user, insecure: profile.insecure });
  return getProfile(next);
}
