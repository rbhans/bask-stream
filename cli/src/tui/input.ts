// Keyboard and mouse input for the dashboard. One `useKeyPump` at the top of the app reads from Ink;
// every other component listens through `useKeys` and `useMouse`.
import { useEffect, useRef } from "react";
import { useInput, type Key } from "ink";

/** One SGR mouse report: ESC [ < button ; column ; row (M = press, m = release). */
const MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;
/** A terminal's answer to a question (its colours, what it is). A slow one can arrive after the wait for it ended; it is not a key. */
const REPLY = /^\x1b?(\]1[01];|\[\?[\d;]*[cn]$)/;

export interface MouseEvent {
  /** Zero-based column and row on the screen. */
  x: number;
  y: number;
  kind: "down" | "up" | "wheelUp" | "wheelDown";
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const inside = (e: { x: number; y: number }, r: Rect) => e.x >= r.x && e.x < r.x + r.width && e.y >= r.y && e.y < r.y + r.height;

/** Turns terminal mouse reporting on or off (press, release and wheel, SGR coordinates). */
export const mouseMode = (on: boolean) => (on ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");

type KeyHandler = (input: string, key: Key) => void;
type MouseHandler = (event: MouseEvent) => void;
interface Listener<T> {
  handler: { current: T };
  active: { current: boolean };
}

const keyListeners = new Set<Listener<KeyHandler>>();
const mouseListeners = new Set<Listener<MouseHandler>>();
const queue: { input: string; key: Key }[] = [];
let pumping = false;
/** Counts renders of components that listen for keys, to tell when a key press has taken effect. */
let renders = 0;

function deliver(input: string, key: Key): void {
  const m = MOUSE.exec(input);
  if (!m) {
    for (const listener of [...keyListeners]) if (listener.active.current) listener.handler.current(input, key);
    return;
  }
  const button = Number(m[1]);
  if (!(button & 64) && (button & 3) !== 0) return; // left button only
  const event: MouseEvent = { x: Number(m[2]) - 1, y: Number(m[3]) - 1, kind: button & 64 ? (button & 1 ? "wheelDown" : "wheelUp") : m[4] === "M" ? "down" : "up" };
  for (const listener of [...mouseListeners]) if (listener.active.current) listener.handler.current(event);
}

/**
 * Hands out queued input one event at a time. Keys that arrive together (fast typing, key repeat)
 * must not all see the screen as it was before the first: after each one the pump waits for the
 * dashboard to draw again (or a few turns of the event loop, when the key changed nothing).
 */
function pump(): void {
  const next = queue.shift();
  if (!next) return void (pumping = false);
  const before = renders;
  deliver(next.input, next.key);
  // Stay busy even with nothing queued: the next key of the same burst arrives in this same turn.
  let turns = 0;
  const wait = () => (renders !== before || ++turns >= 4 ? pump() : setImmediate(wait));
  setImmediate(wait);
}

/** Reads keyboard and mouse input from Ink. Exactly one component on screen should have it enabled. */
export function useKeyPump(enabled = true): void {
  useInput((input, key) => {
    if (REPLY.test(input)) return;
    queue.push({ input, key });
    if (!pumping) {
      pumping = true;
      pump();
    }
  }, { isActive: enabled });
  useEffect(() => () => void (queue.length = 0), []);
}

function useListener<T>(listeners: Set<Listener<T>>, handler: T, isActive: boolean): void {
  const entry = useRef<Listener<T>>({ handler: { current: handler }, active: { current: isActive } }).current;
  entry.handler.current = handler;
  entry.active.current = isActive;
  renders += 1;
  useEffect(() => {
    listeners.add(entry);
    return () => void listeners.delete(entry);
  }, [listeners, entry]);
}

/** Keyboard input while `isActive`. Mouse reports never reach it, so they cannot land in a text field. */
export function useKeys(handler: KeyHandler, options: { isActive?: boolean } = {}): void {
  useListener(keyListeners, handler, options.isActive !== false);
}

/** Mouse presses and wheel turns, while `isActive`. */
export function useMouse(handler: MouseHandler, isActive = true): void {
  useListener(mouseListeners, handler, isActive);
}
