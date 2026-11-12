import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import { Link } from "../link.js";
import type { Connection } from "../session.js";
import { App, type ViewName } from "./App.js";
import { mouseMode } from "./input.js";
import { detectTheme, setTheme } from "./theme.js";

export interface DashboardOptions {
  allowWrites: boolean;
  view?: ViewName;
  points?: string[];
  /** One view per window, for a multiplexer pane. */
  pane?: boolean;
  /** Mouse clicks and wheel (default on). */
  mouse?: boolean;
  theme?: "dark" | "light";
  /** Share the watch list and "show this" requests with other bask windows (default on). */
  shared?: boolean;
}

/**
 * Draws whole frames onto the terminal by rewriting only the lines that changed, each at its own
 * row. Nothing depends on where the cursor was left, so a resize, another program's output or a
 * very wide line cannot shift the picture, and an update never blanks the screen first.
 */
class Painter {
  private shown: string[] = [];
  private latest = "";
  private timer?: NodeJS.Timeout;

  constructor(private readonly out: NodeJS.WriteStream) {}

  /** Takes the next frame; frames arriving close together are drawn once. */
  frame(text: string): void {
    this.latest = text;
    this.timer ??= setTimeout(() => this.flush(), 12);
  }

  private flush(): void {
    this.timer = undefined;
    const rows = this.out.rows || 24;
    const lines = this.latest.split("\n").slice(0, rows);
    let update = "";
    for (let row = 0; row < Math.max(lines.length, this.shown.length); row += 1) {
      const line = lines[row] ?? "";
      // Clear the row before writing: clearing after a line that fills the row would rub out its last character.
      if (line !== this.shown[row]) update += `\x1b[${row + 1};1H\x1b[0m\x1b[2K${line}`;
    }
    this.shown = lines;
    // Synchronized output: terminals that know it show the update in one step.
    if (update) this.out.write(`\x1b[?2026h${update}\x1b[0m\x1b[?2026l`);
  }

  /** Forgets what is on screen and draws the latest frame again in full. */
  repaint(): void {
    clearTimeout(this.timer);
    this.shown = [];
    this.out.write("\x1b[2J");
    this.flush();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

/** Runs the full-screen dashboard on the terminal's alternate screen until the user quits. */
export async function runDashboard(conn: Connection, options: DashboardOptions): Promise<void> {
  const out = process.stdout;
  const mouse = options.mouse !== false;
  setTheme(options.theme ?? detectTheme());
  const enter = () => out.write(`\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l${mouse ? mouseMode(true) : ""}`);
  const leave = () => out.write(`${mouseMode(false)}\x1b[?1049l\x1b[?25h`);
  enter();
  process.once("exit", leave);

  // Ink renders each frame as text into this stand-in for the terminal; the painter puts it on screen.
  const painter = new Painter(out);
  const screen = Object.assign(new EventEmitter(), { write: (frame: string) => (painter.frame(frame), true) });
  Object.defineProperties(screen, { columns: { get: () => out.columns || 80 }, rows: { get: () => out.rows || 24 }, isTTY: { value: true } });
  const onResize = () => {
    screen.emit("resize");
    painter.repaint();
  };
  out.on("resize", onResize);

  const link = new Link(conn.client.http.url.origin, options.shared !== false);
  /** Gives the screen to another program (an editor), then draws the dashboard again. */
  const suspend = (work: () => void) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY && stdin.isRaw;
    leave();
    if (wasRaw) stdin.setRawMode(false);
    try {
      work();
    } finally {
      if (wasRaw) stdin.setRawMode(true);
      enter();
      painter.repaint();
    }
  };
  try {
    const app = render(
      <App client={conn.client} profileName={conn.profileName} allowWrites={options.allowWrites} view={options.view} points={options.points} pane={options.pane} mouse={mouse} link={link} suspend={suspend} terminal={(data) => void out.write(data)} />,
      { stdout: screen as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false }
    );
    await app.waitUntilExit();
  } finally {
    out.off("resize", onResize);
    painter.stop();
    leave();
    conn.client.close();
  }
}
