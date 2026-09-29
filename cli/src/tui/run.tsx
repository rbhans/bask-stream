import React from "react";
import { render } from "ink";
import type { Connection } from "../session.js";
import { App, type ViewName } from "./App.js";

/** Runs the full-screen dashboard on the terminal's alternate screen until the user quits. */
export async function runDashboard(conn: Connection, options: { allowWrites: boolean; view?: ViewName; points?: string[] }): Promise<void> {
  const out = process.stdout;
  const restore = () => out.write("\x1b[?1049l\x1b[?25h");
  out.write("\x1b[?1049h\x1b[H\x1b[?25l");
  process.once("exit", restore);
  try {
    const app = render(<App client={conn.client} profileName={conn.profileName} {...options} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    restore();
    conn.client.close();
  }
}
