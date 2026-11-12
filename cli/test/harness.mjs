// Renders the dashboard to an in-memory terminal of a chosen size, for tests and for looking at frames.
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { BaskStreamClient } from "@basidekick/baskstream";
import { App } from "../dist/tui/App.js";
import { startDemoStation } from "../dist/demo/station.js";

const ANSI = /\x1b\[[0-9;]*m/g;

class Screen extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.frame = "";
  }
  write = (frame) => {
    this.frame = frame;
  };
}

class Keyboard extends EventEmitter {
  isTTY = true;
  data = null;
  write = (data) => {
    this.data = data;
    this.emit("readable");
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

export const KEYS = { up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", esc: "\u001B", tab: "\t", space: " ", pgdn: "\u001B[6~", pgup: "\u001B[5~", back: "\u007F", "ctrl+k": "\u000B" };

export const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** A demo station (frozen values unless `live`) and a connected client. */
export async function startStation(options = {}) {
  const station = await startDemoStation({ live: false, ...options });
  const client = await BaskStreamClient.connect({ station: station.url, username: station.user, password: station.password });
  return { station, client, async close() { client.close(); await station.close(); } };
}

/** Mounts the dashboard on a `columns` x `rows` screen. */
export function mount(client, props = {}, { columns = 120, rows = 36 } = {}) {
  const stdout = new Screen(columns, rows);
  const stdin = new Keyboard();
  const instance = render(React.createElement(App, { client, profileName: "demo", allowWrites: false, ...props }), { stdout, stderr: new Screen(columns, rows), stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  const frame = () => stdout.frame.replace(ANSI, "");
  return {
    frame,
    raw: () => stdout.frame,
    /** Presses keys by name (see KEYS) or as literal text, pausing between them. */
    async press(...keys) {
      for (const key of keys) {
        stdin.write(KEYS[key] ?? key);
        await settle(70);
      }
    },
    /** A mouse press or wheel turn at a zero-based column and row. */
    async mouse(kind, x, y) {
      const button = kind === "wheelUp" ? 64 : kind === "wheelDown" ? 65 : 0;
      stdin.write(`\u001B[<${button};${x + 1};${y + 1}M`);
      await settle(70);
    },
    async until(pattern, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(frame())) {
          // Ink re-binds key handlers in an effect after the frame is drawn; let that run first.
          await settle(100);
          return frame();
        }
        await settle(25);
      }
      assert.fail(`timed out waiting for ${pattern}\n${frame()}`);
    },
    unmount: () => instance.unmount()
  };
}
