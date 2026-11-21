// Output through a pipe, whole.
//
// The standalone bask is built with Bun. There, once anything has looked at process.stdout (chalk
// does, to choose colours), console.log writes straight to a descriptor that no longer blocks: what
// does not fit in the pipe's buffer (65,536 bytes) is dropped, so `bask ... -o json | cat` lost the
// rest. process.stdout.write keeps what is left and sends it as the reader takes it, so under Bun
// the console goes through the streams. Node's console already does.
import { format } from "node:util";

/** Sends console output through process.stdout and process.stderr, where a pipe gets all of it. */
export function pipeSafeConsole(): void {
  if (!process.versions.bun) return;
  const out = (...args: unknown[]) => void process.stdout.write(`${format(...args)}\n`);
  const err = (...args: unknown[]) => void process.stderr.write(`${format(...args)}\n`);
  console.log = out;
  console.info = out;
  console.debug = out;
  console.error = err;
  console.warn = err;
}

/** Resolves when everything written to stdout and stderr so far has been handed over. */
export function flushOutput(): Promise<void> {
  const flushed = (stream: NodeJS.WriteStream) =>
    new Promise<void>((resolve) => {
      // A reader that went away (bask ... | head) must not keep bask waiting.
      if (stream.destroyed || stream.writableEnded) return resolve();
      stream.once("error", () => resolve());
      stream.write("", () => resolve());
    });
  return Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => undefined);
}

/** Ends the process once its output is out: process.exit by itself can cut a pipe short. */
export async function exitWhenFlushed(code: number): Promise<never> {
  await flushOutput();
  process.exit(code);
}
