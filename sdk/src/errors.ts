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

/**
 * An agent's change that was not made and now waits for a person (API 1.14). The station answers
 * with an error so that no client takes the change for done; this is that error, with the
 * proposal. Do not send the change again: watch the proposal with `proposals()` or `onProposal`.
 */
export class ChangeProposedError extends BaskStreamError {
  constructor(message: string, op: string | undefined, readonly proposal: import("./types.js").Proposal) {
    super("change_proposed", message, op);
    this.name = "ChangeProposedError";
  }
}

/** Client-side codes, alongside the protocol's own. */
export const CLIENT_ERRORS = {
  timeout: "timeout",
  notConnected: "not_connected",
  closed: "connection_closed",
  loginFailed: "login_failed",
  sessionExpired: "session_expired",
  badMessage: "bad_message",
  messageTooLarge: "message_too_large",
  browserNotFound: "browser_not_found",
  snapshotFailed: "snapshot_failed"
} as const;
