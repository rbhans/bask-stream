// The demo station only needs a server socket; this keeps @types/ws out of the dependencies.
declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket extends EventEmitter {
    readyState: number;
    send(data: Uint8Array | string): void;
    close(): void;
    terminate(): void;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer?: boolean });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void;
  }
}
