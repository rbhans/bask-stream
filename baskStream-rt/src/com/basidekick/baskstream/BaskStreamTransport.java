package com.basidekick.baskstream;

import java.io.IOException;

/**
 * What a session needs from its connection. The Jetty implementation is
 * BaskStreamJettyWebSocketConnection; a Niagara 5 transport implements this instead.
 */
interface BaskStreamTransport
{
  /** Queues one encoded frame; throws when the connection can no longer accept it. */
  void send(byte[] frame) throws IOException;

  /** Closes the underlying socket with a WebSocket close code. */
  void closeTransport(int code, String reason);
}
