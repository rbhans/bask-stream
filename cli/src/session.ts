import { BaskStreamClient } from "@basidekick/baskstream";
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
export async function connect(profileName?: string): Promise<Connection> {
  const { name, profile } = getProfile(profileName);
  let typed: string | undefined = process.env.BASKSTREAM_PASSWORD;
  let mayPrompt = true;
  const password = async () => {
    if (typed !== undefined) return typed;
    if (!mayPrompt) throw new Error("The station session expired. Quit and run bask again to log in.");
    typed = await promptHidden(`Password for ${profile.username}@${new URL(profile.station).host}: `);
    return typed;
  };
  const client = await BaskStreamClient.connect({
    station: profile.station,
    username: profile.username,
    password,
    verifyTls: !profile.insecure,
    cookies: profile.cookies,
    onSession: (cookies) => updateProfile(name, { cookies })
  });
  return { client, profileName: name, stopPrompting: () => (mayPrompt = false) };
}
