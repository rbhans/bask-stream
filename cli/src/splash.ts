import chalk from "chalk";
import { QUIPS, type QuipKind } from "./quips.js";
import { VERSION } from "./version.js";

/** The BASidekick mark on one line ("BA", the S on its hi-vis chip, "idekick"), then bask's version. */
export function splash(): string {
  const mark = `${chalk.bold("BA")}${chalk.bgHex("#d4ff3a").hex("#0e1013").bold(" S ")}${chalk.bold("idekick")}`;
  return ["", `  ${mark}  ${chalk.bold("bask")} ${chalk.dim(`v${VERSION} · your Niagara sidekick`)}`, ""].join("\n");
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Clears the spinner line and stops it (safe to call twice). */
  stop(): void;
  /** Replaces the spinner with a final line. */
  done(line: string): void;
}

/** A one-line spinner on stderr that rotates through the sidekick's lines. No-op without a terminal. */
export function spinner(kind: QuipKind): Spinner {
  const out = process.stderr;
  if (!out.isTTY) return { stop() {}, done: (line) => out.write(`${line}\n`) };
  const lines = [...QUIPS[kind]].sort(() => Math.random() - 0.5);
  let frame = 0;
  let running = true;
  const draw = () => {
    const text = lines[Math.floor(frame / 25) % lines.length];
    out.write(`\r\x1b[2K  ${chalk.hex("#9bc400")(FRAMES[frame % FRAMES.length])} ${chalk.dim(text)}`);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 80);
  const stop = () => {
    if (!running) return;
    running = false;
    clearInterval(timer);
    out.write("\r\x1b[2K");
  };
  return {
    stop,
    done(line) {
      stop();
      out.write(`${line}\n`);
    }
  };
}
