import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A saved station connection. Only session cookies are stored, never the password. */
export interface Profile {
  station: string;
  username?: string;
  insecure?: boolean;
  cookies?: Record<string, string>;
  /** The profile an AI agent uses on this station in a workspace: the same station under the agent's own Niagara user. */
  agent?: string;
}

export interface Store {
  current?: string;
  profiles: Record<string, Profile>;
}

export function configDir(): string {
  if (process.env.BASKSTREAM_CONFIG_DIR) return process.env.BASKSTREAM_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : path.join(os.homedir(), ".config"));
  return path.join(base, "baskstream");
}

const file = () => path.join(configDir(), "profiles.json");

export function loadStore(): Store {
  try {
    const store = JSON.parse(fs.readFileSync(file(), "utf8")) as Store;
    return { current: store.current, profiles: store.profiles ?? {} };
  } catch {
    return { profiles: {} };
  }
}

function saveStore(store: Store): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file());
}

/** The named profile, or the current one, or the only one. */
export function getProfile(name?: string): { name: string; profile: Profile } {
  const store = loadStore();
  const chosen = name ?? process.env.BASKSTREAM_PROFILE ?? store.current ?? (Object.keys(store.profiles).length === 1 ? Object.keys(store.profiles)[0] : undefined);
  if (!chosen || !store.profiles[chosen]) {
    throw new Error(chosen ? `No profile named "${chosen}". Run: bask login <station> -u <user> --name ${chosen}` : "No station yet. Run: bask login <station> -u <user>");
  }
  return { name: chosen, profile: store.profiles[chosen] };
}

export function putProfile(name: string, profile: Profile, makeCurrent = true): void {
  const store = loadStore();
  store.profiles[name] = profile;
  if (makeCurrent || !store.current) store.current = name;
  saveStore(store);
}

export function updateProfile(name: string, change: Partial<Profile>): void {
  const store = loadStore();
  if (!store.profiles[name]) return;
  store.profiles[name] = { ...store.profiles[name], ...change };
  saveStore(store);
}

export function setCurrent(name: string): void {
  const store = loadStore();
  if (!store.profiles[name]) throw new Error(`No profile named "${name}".`);
  store.current = name;
  saveStore(store);
}

export function removeProfile(name: string): void {
  const store = loadStore();
  delete store.profiles[name];
  if (store.current === name) store.current = Object.keys(store.profiles)[0];
  saveStore(store);
}

/**
 * A station URL from what was typed. A short numeric address is refused: 192.168.128 would
 * otherwise be read as 192.168.0.128.
 */
export function stationUrl(text: string): URL {
  const typed = text.replace(/^https?:\/\//, "").split(/[/:]/)[0];
  if (/^\d+(\.\d+){0,2}$/.test(typed)) throw new Error(`${typed} is not a full address: an IP address has four numbers, like ${typed.split(".").concat(["x", "x", "x"]).slice(0, 4).join(".")}.`);
  return new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
}

export interface LoginChoice {
  profile: string;
  user: string;
}

/** The saved logins for the same station as a profile, one per user, the profile's own first. AI agents' logins are left out. */
export function loginChoices(store: Store, name: string): LoginChoice[] {
  const mine = store.profiles[name];
  if (!mine) return [];
  const agents = new Set(Object.values(store.profiles).map((p) => p.agent).filter(Boolean));
  const out: LoginChoice[] = [];
  for (const [profile, p] of [[name, mine] as const, ...Object.entries(store.profiles)]) {
    if (!p.username || p.station !== mine.station || agents.has(profile)) continue;
    if (!out.some((c) => c.user.toLowerCase() === p.username!.toLowerCase())) out.push({ profile, user: p.username });
  }
  return out;
}
