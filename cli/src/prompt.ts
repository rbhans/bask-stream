import readline from "node:readline";

/** Reads a line without echoing it (for passwords). Needs a terminal. */
export function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new Error("No terminal to ask for the password. Set BASKSTREAM_PASSWORD or run bask login in a terminal."));
  }
  process.stderr.write(question);
  return new Promise((resolve) => {
    let value = "";
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          input.off("data", onData);
          input.setRawMode(wasRaw);
          input.pause();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(wasRaw);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** Asks a yes/no question on the terminal; anything but y/yes is no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
