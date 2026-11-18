import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WsWebSocket from "ws";
import { BaskStreamError, CLIENT_ERRORS } from "./errors.js";
import type { StationHttp } from "./http.js";

export interface SnapshotOptions {
  /** With a component: the view to open, e.g. "Graphic". Default: the component's default view. */
  view?: string;
  /** Browser window size in CSS pixels. Default 1600 × 900. */
  width?: number;
  height?: number;
  /** Extra wait once the page has loaded and its network is quiet, for bound values to arrive. Default 3000. */
  settleMs?: number;
  /** Pictures to take, `intervalMs` apart (default 1 and 3000). Several show animation or values changing. */
  frames?: number;
  intervalMs?: number;
  /** Longest wait for the page to load and its network to go quiet. Default 30000. */
  timeoutMs?: number;
  /** The Chrome, Chromium or Edge program to use. Default: $BASKSTREAM_BROWSER, else the first one installed. */
  browser?: string;
}

export interface SnapshotFrame {
  /** The picture, as PNG. */
  png: Buffer;
  takenAt: number;
}

export interface PxSnapshot {
  /** The ORD that was opened. */
  ord: string;
  /** Where the browser ended up. */
  url: string;
  title: string;
  /** HTTP status of the page itself. */
  httpStatus: number | null;
  width: number;
  height: number;
  frames: SnapshotFrame[];
  /** From navigating until the network went quiet. */
  loadMs: number;
  /** Requests the page made that failed (images, scripts, data). */
  failedRequests: number;
  /** Script errors and console.error messages from the page, without repeats (first 10). */
  consoleErrors: string[];
}

/**
 * The ORD for a page: a Px file (`^folder/Page.px`, `file:^…`, or a bare `folder/Page.px`), a
 * component (`slot:/…`, or a bare `Drivers/AHU_1`) with an optional view, or a full ORD as given.
 */
export function pxPageOrd(page: string, view?: string): string {
  let ord = page.trim().replace(/^local:\|/, "");
  if (!ord) throw new TypeError("No page given.");
  if (ord.startsWith("^")) ord = `file:${ord}`;
  else if (ord.startsWith("slot:")) ord = `station:|${ord}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(ord)) {
    const path = ord.replace(/^\/+/, "");
    ord = /\.(px|nav|html?)$/i.test(path) ? `file:^${path}` : `station:|slot:/${path}`;
  }
  if (view && !ord.includes("|view:")) ord += `|view:${view}`;
  return ord;
}

/** The station URL a browser opens for an ORD. */
export function pxPageUrl(station: URL, ord: string): string {
  return `${station.origin}/ord?${encodeURI(ord).replace(/#/g, "%23")}`;
}

/** The browser program to drive: `explicit`, else $BASKSTREAM_BROWSER, else the first installed Chrome, Chromium or Edge. */
export function findBrowser(explicit?: string): string {
  for (const chosen of [explicit, process.env.BASKSTREAM_BROWSER?.trim()]) {
    if (!chosen) continue;
    if (existsSync(chosen)) return chosen;
    throw new BaskStreamError(CLIENT_ERRORS.browserNotFound, `The browser ${chosen} doesn't exist.`);
  }
  const found = browserCandidates().find((path) => existsSync(path));
  if (found) return found;
  throw new BaskStreamError(
    CLIENT_ERRORS.browserNotFound,
    "Seeing a page needs Chrome, Chromium or Microsoft Edge on this computer, and none was found. Install one, or set BASKSTREAM_BROWSER to its program."
  );
}

function browserCandidates(): string[] {
  if (process.platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
    return apps.flatMap((app) => [join("/Applications", app), join(homedir(), "Applications", app)]);
  }
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    const programs = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    return programs.flatMap((program) => roots.map((root) => join(root, program)));
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

/**
 * Opens a page in a headless browser with the session in `http` (its cookies; no password is
 * used) and takes PNG pictures of it. The browser gets a throwaway profile, deleted afterwards,
 * since it holds the session cookies. Fails with `session_expired` when the station sends the
 * browser to its login page, `browser_not_found` without a browser, and `snapshot_failed` when the
 * page can't be opened.
 */
export async function snapshotPage(http: StationHttp, page: string, options: SnapshotOptions = {}): Promise<PxSnapshot> {
  const settings = {
    width: whole(options.width, 1600, 200, 7680),
    height: whole(options.height, 900, 200, 4320),
    settleMs: whole(options.settleMs, 3000, 0, 60000),
    frames: whole(options.frames, 1, 1, 10),
    intervalMs: whole(options.intervalMs, 3000, 0, 60000),
    timeoutMs: whole(options.timeoutMs, 30000, 1000, 120000)
  };
  const ord = pxPageOrd(page, options.view);
  const browser = await Browser.launch(findBrowser(options.browser), { insecure: !http.verifyTls, width: settings.width, height: settings.height });
  try {
    return await browser.capture(http, ord, settings);
  } finally {
    await browser.close();
  }
}

function whole(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.min(max, Math.max(min, n));
}

// ---- The browser, over the DevTools protocol ----------------------------------------------------

interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/** The parts of a WebSocket used here; Node 22+ and Bun have one built in, Node 20 uses ws. */
interface MinimalSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
type SocketConstructor = new (url: string) => MinimalSocket;
const Socket: SocketConstructor = (globalThis as { WebSocket?: SocketConstructor }).WebSocket ?? (WsWebSocket as unknown as SocketConstructor);

const COMMAND_TIMEOUT_MS = 30000;

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly socket: MinimalSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const waiting = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (waiting) {
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiting.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) listener(message as CdpEvent);
      }
    };
    socket.onclose = () => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("The browser closed the connection."));
      }
      this.pending.clear();
    };
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new Socket(url);
      socket.onopen = () => resolve(new Cdp(socket));
      socket.onerror = () => reject(new BaskStreamError(CLIENT_ERRORS.snapshotFailed, "Couldn't connect to the browser."));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BaskStreamError(CLIENT_ERRORS.snapshotFailed, `The browser didn't answer ${method}.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }
}

class Browser {
  private constructor(
    private readonly child: ChildProcess,
    private readonly exited: Promise<unknown>,
    private readonly profile: string,
    private readonly cdp: Cdp
  ) {}

  static async launch(program: string, window: { insecure: boolean; width: number; height: number }): Promise<Browser> {
    const profile = await mkdtemp(join(tmpdir(), "baskstream-snapshot-"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--mute-audio",
      "--use-mock-keychain",
      "--password-store=basic",
      "--hide-scrollbars",
      `--window-size=${window.width},${window.height}`,
      // Stations mostly have self-signed certificates; this follows the connection's own verifyTls.
      ...(window.insecure ? ["--ignore-certificate-errors"] : []),
      "about:blank"
    ];
    const child = spawn(program, args, { stdio: "ignore" });
    const status: { gone: Error | null } = { gone: null };
    const exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        status.gone ??= new Error(`it exited with code ${code}`);
        resolve(code);
      });
      child.once("error", (error) => {
        status.gone = error;
        resolve(error);
      });
    });

    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 20000;
    let lines: string[] = [];
    while (lines.length < 2) {
      if (status.gone || Date.now() > deadline) {
        child.kill();
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        const why = status.gone ? status.gone.message : "it didn't open its debugging port in 20 s";
        throw new BaskStreamError(CLIENT_ERRORS.snapshotFailed, `The browser ${program} didn't start: ${why}.`);
      }
      if (existsSync(portFile)) lines = (await readFile(portFile, "utf8")).trim().split("\n");
      if (lines.length < 2) await delay(50);
    }
    try {
      const cdp = await Cdp.open(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
      return new Browser(child, exited, profile, cdp);
    } catch (error) {
      child.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      throw error;
    }
  }

  async capture(http: StationHttp, ord: string, settings: { width: number; height: number; settleMs: number; frames: number; intervalMs: number; timeoutMs: number }): Promise<PxSnapshot> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}) => this.cdp.send(method, params, sessionId);

    const inflight = new Set<string>();
    let lastActivity = Date.now();
    let loaded = false;
    let mainFrame = "";
    let httpStatus: number | null = null;
    let failedRequests = 0;
    const consoleErrors: string[] = [];
    const stopListening = this.cdp.on(({ method, params, sessionId: from }) => {
      if (from !== sessionId) return;
      switch (method) {
        case "Network.requestWillBeSent":
          inflight.add(params.requestId);
          lastActivity = Date.now();
          break;
        case "Network.loadingFinished":
          inflight.delete(params.requestId);
          lastActivity = Date.now();
          break;
        case "Network.loadingFailed":
          inflight.delete(params.requestId);
          lastActivity = Date.now();
          if (!params.canceled) failedRequests += 1;
          break;
        case "Network.responseReceived":
          if (params.type === "Document" && params.frameId === mainFrame) httpStatus = params.response?.status ?? null;
          break;
        case "Page.loadEventFired":
          loaded = true;
          break;
        case "Runtime.exceptionThrown":
          consoleErrors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "").split("\n")[0]);
          break;
        case "Runtime.consoleAPICalled":
          if (params.type === "error") consoleErrors.push((params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" "));
          break;
      }
    });

    try {
      await send("Network.enable");
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: settings.width, height: settings.height, deviceScaleFactor: 1, mobile: false });
      const origin = http.url.origin;
      for (const [name, value] of Object.entries(http.getCookies())) {
        await send("Network.setCookie", { name, value, url: `${origin}/`, path: "/", secure: http.url.protocol === "https:", httpOnly: true });
      }

      // The page's own response arrives before Page.navigate answers, so know the frame first.
      mainFrame = (await send("Page.getFrameTree")).frameTree.frame.id;
      const url = pxPageUrl(http.url, ord);
      const started = Date.now();
      const navigation = await send("Page.navigate", { url });
      if (navigation.errorText) throw new BaskStreamError(CLIENT_ERRORS.snapshotFailed, `The browser couldn't open ${url}: ${navigation.errorText}.`);

      // Loaded, then no network traffic for 1.5 s (bound values mostly arrive over the page's own
      // WebSocket, which doesn't count), then the settle time.
      while (!loaded) {
        if (Date.now() - started > settings.timeoutMs) throw new BaskStreamError(CLIENT_ERRORS.snapshotFailed, `The page didn't finish loading in ${settings.timeoutMs / 1000} s.`);
        await delay(50);
      }
      while ((inflight.size > 0 || Date.now() - lastActivity < 1500) && Date.now() - started < settings.timeoutMs) await delay(50);
      const loadMs = Date.now() - started;

      const where = await send("Runtime.evaluate", { expression: "({ href: location.href, path: location.pathname, title: document.title })", returnByValue: true });
      const page = where.result?.value ?? { href: url, path: "", title: "" };
      if (/^\/(prelogin|login|j_security_check)/i.test(page.path)) {
        throw new BaskStreamError(CLIENT_ERRORS.sessionExpired, "The station sent the browser to its login page: the session isn't logged in.");
      }

      await delay(settings.settleMs);
      const frames: SnapshotFrame[] = [];
      for (let i = 0; i < settings.frames; i += 1) {
        if (i > 0) await delay(settings.intervalMs);
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        frames.push({ png: Buffer.from(data, "base64"), takenAt: Date.now() });
      }

      return {
        ord,
        url: page.href,
        title: page.title,
        httpStatus,
        width: settings.width,
        height: settings.height,
        frames,
        loadMs,
        failedRequests,
        consoleErrors: [...new Set(consoleErrors.map((text) => text.slice(0, 300)).filter(Boolean))].slice(0, 10)
      };
    } finally {
      stopListening();
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }

  /** Closes the browser, waits for it to exit, and deletes its profile (which holds the session cookies). */
  async close(): Promise<void> {
    await this.cdp.send("Browser.close").catch(() => undefined);
    this.cdp.close();
    await Promise.race([this.exited, idle(5000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await Promise.race([this.exited, idle(5000)]);
    }
    await rm(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * Resolves after `ms` without keeping the process alive: a fallback raced against something that
 * usually comes first. A plain timer would hold a short-lived program (a CLI) open until it fires.
 */
function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
