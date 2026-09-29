import chalk from "chalk";
import { QUIPS, type QuipKind } from "./quips.js";
import { VERSION } from "./version.js";

const WORDMARK = ["█▄▄ ▄▀█ █▀ █▄▀", "█▄█ █▀█ ▄█ █░█"];
const FROM = [0x7a, 0xa2, 0xf7];
const TO = [0xbb, 0x9a, 0xf7];

/** The bask wordmark with a left-to-right gradient, the version and the BASidekick tagline. */
export function splash(): string {
  const width = WORDMARK[0].length;
  const shade = (line: string) =>
    [...line]
      .map((ch, i) => {
        const t = i / (width - 1);
        const [r, g, b] = FROM.map((from, k) => Math.round(from + (TO[k] - from) * t));
        return chalk.rgb(r, g, b)(ch);
      })
      .join("");
  return [
    "",
    `  ${shade(WORDMARK[0])}`,
    `  ${shade(WORDMARK[1])}   ${chalk.dim(`v${VERSION}`)}`,
    `  ${chalk.bold("BASidekick")} ${chalk.dim("· your Niagara sidekick")}`,
    ""
  ].join("\n");
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
    out.write(`\r\x1b[2K  ${chalk.hex("#7aa2f7")(FRAMES[frame % FRAMES.length])} ${chalk.dim(text)}`);
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
