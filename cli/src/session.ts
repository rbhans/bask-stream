import { BaskStreamClient, type Actor } from "@basidekick/baskstream";
import { getProfile, updateProfile } from "./config.js";
import { promptHidden } from "./prompt.js";

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
  const { name, profile } = getProfile(profileName);
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
  const client = await BaskStreamClient.connect({
    station: profile.station,
    username: profile.username,
    password,
    verifyTls: !profile.insecure,
    cookies: profile.cookies,
    onSession: (cookies) => updateProfile(name, { cookies }),
    actor: options.actor
  });
  return { client, profileName: name, stopPrompting: () => (mayPrompt = false) };
}
