// Everything bask can do from a shell, from the line at the bottom of the screen: the command is run
// as its own bask process on the same saved login, and what it prints is shown in place of the map.
import { spawn } from "node:child_process";

/** Every command bask has that prints and ends. */
export const SHELL_COMMANDS = [
  "status", "browse", "search", "read", "history", "alarms", "ack", "clear", "write", "schedule", "call", "proposals", "explain", "approve", "reject", "changes", "revert", "resolve",
  "why", "log", "get", "test", "agent-log", "query", "files", "cat", "put", "rm", "jobs", "job", "discover", "add", "metrics", "graphic", "px", "nav", "check", "export", "diff", "apply",
  "model", "record", "logic", "plan", "show", "agent-brief", "profiles", "doctor", "energy", "note", "help"
];
/** Commands that take the terminal over or never end: they are run from a shell of their own. */
export const SHELL_OWN_WINDOW = ["tui", "demo", "fleet", "workspace", "ws", "symbols", "login", "logout", "use", "replay", "eval", "watch"];
/** Commands that change the station whenever they run. */
const ALWAYS_CHANGE = new Set(["ack", "clear", "write", "approve", "reject", "revert", "put", "rm", "add", "apply"]);

/** True when running the command would change the station, so it is shown first and asked about. */
export function changes(args: string[]): boolean {
  if (ALWAYS_CHANGE.has(args[0])) return true;
  if (args.some((a) => a === "--apply" || a === "--add" || a === "--yes" || a === "-y" || a === "--allow-writes")) return true;
  return ["model", "px", "graphic", "nav", "logic"].includes(args[0]) && /^(write|attach|save|rm|put|set|add|build|detach)$/.test(args[1] ?? "");
}

/** "a b 'c d'" as words, keeping what is inside quotes together. */
export function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

/** How this bask was started, so the same one is run again: a built binary, or node with the script. */
function self(): string[] {
  const script = process.argv[1];
  return !script || /\$bunfs|~BUN/i.test(script) ? [process.execPath] : [process.execPath, script];
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Runs bask with these words and returns what it printed, without colour. */
export function runBask(args: string[], profile: string, allowWrites: boolean, timeoutMs = 180000): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const [bin, ...first] = self();
    const child = spawn(bin, [...first, "-p", profile, ...(allowWrites ? ["--allow-writes", "--yes"] : []), ...args], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BASK_MOTION: "off", COLUMNS: "108" }
    });
    let text = "";
    const take = (chunk: Buffer) => {
      if (text.length < 2_000_000) text += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({ code, lines: text.replace(ANSI, "").replace(/\r/g, "").replace(/\n+$/, "").split("\n") });
    };
    child.on("error", (error) => {
      text += String(error.message);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}
