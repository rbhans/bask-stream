// Which Niagara login a workspace's AI agent uses. The person stays on their own login in the
// station panes; the agent gets a saved profile of its own for the same station, under the Niagara
// user made for it. The station then tells the two apart by user, and its agent rules follow that
// user however it connects.
import { StationHttp } from "@basidekick/baskstream";
import { getProfile, loadStore, putProfile, updateProfile } from "./config.js";
import { promptHidden } from "./prompt.js";
import { connect } from "./session.js";

export interface AgentChoice {
  /** The profile the agent's bask uses. */
  profile: string;
  user: string;
  /** asked: named on the command line. remembered: the one this profile used last time. guessed: a saved profile for the station whose name says agent or AI. */
  how: "asked" | "remembered" | "guessed";
  /** Not saved yet: this user is logged in and saved under `profile`. */
  create?: boolean;
}

export interface AgentLogin extends AgentChoice {
  /** The station treats this user as an agent by itself (it is in the service's agentUsers). Undefined when the station does not say. */
  listed?: boolean;
  /** The agent's point writes wait for a person's approval. */
  approval?: boolean;
}

/**
 * Picks the agent's login for the person's profile `mine`, without touching the network: the one
 * named, else the one used last time, else a saved profile that looks like an agent's. Undefined
 * means there is none, and the agent would share the person's login.
 */
export function chooseAgentLogin(mine: string, wants: { profile?: string; user?: string } = {}): AgentChoice | undefined {
  const store = loadStore();
  const me = store.profiles[mine];
  if (!me) throw new Error(`No profile named "${mine}".`);
  const sameStation = (name: string) => store.profiles[name]?.station === me.station;
  const sameUser = (user?: string) => (user ?? "").toLowerCase() === (me.username ?? "").toLowerCase();

  if (wants.profile) {
    if (wants.profile === mine) return undefined;
    const named = getProfile(wants.profile).profile;
    if (named.station !== me.station) throw new Error(`Profile "${wants.profile}" is for ${named.station}, not for ${me.station}. The agent needs a login on the same station: bask workspace --agent-user <user>`);
    if (sameUser(named.username)) throw new Error(`Profile "${wants.profile}" signs in as ${named.username}, which is your own login. Name the Niagara user made for the AI: bask workspace --agent-user <user>`);
    return { profile: wants.profile, user: named.username ?? "", how: "asked" };
  }
  if (wants.user) {
    if (sameUser(wants.user)) throw new Error(`${wants.user} is your own login. Name the Niagara user made for the AI: bask workspace --agent-user <user>`);
    const saved = Object.entries(store.profiles).find(([name, p]) => name !== mine && sameStation(name) && (p.username ?? "").toLowerCase() === wants.user!.toLowerCase());
    if (saved) return { profile: saved[0], user: saved[1].username ?? wants.user, how: "asked" };
    // A name for the new profile: "ai" when that is free, else one tied to the person's profile.
    let name = store.profiles.ai ? `${mine}-ai` : "ai";
    for (let n = 2; store.profiles[name]; n += 1) name = `${mine}-ai-${n}`;
    return { profile: name, user: wants.user, how: "asked", create: true };
  }
  if (me.agent && me.agent !== mine && sameStation(me.agent) && !sameUser(store.profiles[me.agent].username)) {
    return { profile: me.agent, user: store.profiles[me.agent].username ?? "", how: "remembered" };
  }
  // A saved profile for the same station under another user whose name says AI or agent: "ai" first.
  const rank = (name: string, user: string) => (/^ai$/i.test(name) ? 4 : /^ai[-_ ]|[-_ ]ai$/i.test(name) || /^ai[-_]/i.test(user) ? 3 : /claude|codex|gpt|gemini/i.test(`${name} ${user}`) ? 2 : /agent/i.test(`${name} ${user}`) ? 1 : 0);
  const guess = Object.entries(store.profiles)
    .filter(([name, p]) => name !== mine && sameStation(name) && !sameUser(p.username))
    .map(([name, p]) => ({ name, user: p.username ?? "", rank: rank(name, p.username ?? "") }))
    .sort((a, b) => b.rank - a.rank)[0];
  return guess && guess.rank > 0 ? { profile: guess.name, user: guess.user, how: "guessed" } : undefined;
}

/** How a choice is described to the person before anything is asked of them. */
export function describeChoice(choice: AgentChoice): string {
  if (choice.create) return `a new saved login, profile "${choice.profile}"`;
  if (choice.how === "remembered") return `profile "${choice.profile}", as last time`;
  if (choice.how === "guessed") return `the saved profile "${choice.profile}" for this station, picked by its name`;
  return `profile "${choice.profile}"`;
}

/**
 * Makes sure the agent's login works, asking for its password when there is no live saved session
 * (never the person's own password: BASKSTREAM_PASSWORD is not used, BASKSTREAM_AGENT_PASSWORD is).
 * Remembers the choice on the person's profile, and reports whether the station itself counts the
 * user as an agent.
 */
export async function openAgentLogin(mine: string, choice: AgentChoice): Promise<AgentLogin> {
  const me = getProfile(mine).profile;
  const label = `Password for the AI agent's login ${choice.user}@${new URL(me.station).host}: `;
  const password = process.env.BASKSTREAM_AGENT_PASSWORD;
  try {
    if (choice.create) {
      const http = new StationHttp({ station: me.station, verifyTls: !me.insecure });
      await http.login(choice.user, password ?? (await promptHidden(label)));
      putProfile(choice.profile, { station: me.station, username: choice.user, insecure: me.insecure, cookies: http.getCookies() }, false);
    }
    const conn = await connect(choice.profile, { promptLabel: label, password, envPassword: false });
    const caps = conn.client.capabilities;
    conn.client.close();
    const agents = caps.agents as { isAgent?: boolean; approvalRequired?: boolean } | undefined;
    updateProfile(mine, { agent: choice.profile });
    return { ...choice, create: undefined, user: typeof caps.authenticatedUser === "string" ? caps.authenticatedUser : choice.user, listed: agents ? Boolean(agents.isAgent) : undefined, approval: agents ? agents.approvalRequired !== false : undefined };
  } catch (error) {
    throw new Error(
      [
        `The agent's login as ${choice.user} (${describeChoice(choice)}) was not accepted: ${(error as Error).message}`,
        `  Log it in again:           bask login ${me.station} -u ${choice.user} --name ${choice.profile}${me.insecure ? " -k" : ""}`,
        "  Use another Niagara user:  bask workspace --agent-user <user>",
        "  Start without the agent:   bask workspace --no-agent"
      ].join("\n")
    );
  }
}
