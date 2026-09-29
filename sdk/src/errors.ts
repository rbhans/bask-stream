/** A request the station answered with an error, or a client-side failure with a stable code. */
export class BaskStreamError extends Error {
  constructor(
    /** Protocol error code (see spec/baskstream-protocol.json), or a client code such as "timeout". */
    readonly code: string,
    message: string,
    /** The operation that failed, when known. */
    readonly op?: string
  ) {
    super(message);
    this.name = "BaskStreamError";
  }
}

/** Client-side codes, alongside the protocol's own. */
export const CLIENT_ERRORS = {
  timeout: "timeout",
  notConnected: "not_connected",
  closed: "connection_closed",
  loginFailed: "login_failed",
  sessionExpired: "session_expired",
  badMessage: "bad_message"
} as const;
