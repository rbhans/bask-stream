import { EventEmitter } from "node:events";

/**
 * Under Bun (the standalone `bask` executables), the `ws` package is swapped for a shim that
 * ignores `rejectUnauthorized`, so self-signed stations fail the TLS handshake. This wraps Bun's
 * native WebSocket, which takes TLS options, behind the small part of the `ws` API the client uses.
 */
export class BunSocket extends EventEmitter {
  private readonly socket: {
    readyState: number;
    binaryType: string;
    send(data: Uint8Array): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string }) => void) | null;
    onclose: ((event: { code: number; reason?: string }) => void) | null;
  };

  constructor(url: string, options: { headers: Record<string, string>; rejectUnauthorized: boolean; ca?: string | Buffer }) {
    super();
    const Native = (globalThis as unknown as { WebSocket: new (url: string, options: unknown) => BunSocket["socket"] }).WebSocket;
    this.socket = new Native(url, {
      headers: options.headers,
      tls: { rejectUnauthorized: options.rejectUnauthorized, ...(options.ca ? { ca: options.ca } : {}) }
    });
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.emit("open");
    this.socket.onmessage = ({ data }) =>
      typeof data === "string" ? this.emit("message", Buffer.from(data), false) : this.emit("message", Buffer.from(data as ArrayBuffer), true);
    this.socket.onerror = (event) => this.emit("error", new Error(event?.message || "WebSocket connection failed"));
    this.socket.onclose = (event) => this.emit("close", event.code, Buffer.from(event.reason ?? ""));
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: Uint8Array, _options: unknown, callback?: (error?: Error) => void): void {
    try {
      this.socket.send(data);
      callback?.();
    } catch (error) {
      callback?.(error as Error);
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.close();
  }
}
