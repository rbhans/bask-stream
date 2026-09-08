package com.basidekick.baskstream;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.logging.Level;

import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.WebSocketAdapter;
import org.eclipse.jetty.websocket.servlet.ServletUpgradeRequest;

final class BaskStreamJettyWebSocketConnection extends WebSocketAdapter
{
  private final BaskStreamWebSocketRuntime runtime;
  private final ServletUpgradeRequest upgradeRequest;
  private volatile BaskStreamClientSession clientSession;
  private final java.util.ArrayDeque<byte[]> outbound = new java.util.ArrayDeque<byte[]>();
  private long outboundBytes;
  private boolean sending;
  private boolean transportClosed;
  private static final long MAX_OUTBOUND_BYTES = 16L * 1024L * 1024L;
  private static final int MAX_OUTBOUND_FRAMES = 128;

  BaskStreamJettyWebSocketConnection(BaskStreamWebSocketRuntime runtime, ServletUpgradeRequest upgradeRequest)
  {
    this.runtime = runtime;
    this.upgradeRequest = upgradeRequest;
  }

  @Override
  public void onWebSocketConnect(Session session)
  {
    super.onWebSocketConnect(session);
    session.setIdleTimeout(runtime.getService().getHeartbeatIntervalSecValue() * 2000L);

    try
    {
      BaskStreamClientSession next = runtime.buildSession(this, upgradeRequest);
      if (!runtime.onOpen(next))
      {
        runtime.getService().audit("connect_rejected", "reason=connection_limit user=" + next.getUsername()
          + " remote=" + String.valueOf(session.getRemoteAddress()));
        session.close(1013, "Connection limit reached.");
        return;
      }
      clientSession = next;
      runtime.getService().audit("connect", "user=" + next.getUsername()
        + " remote=" + String.valueOf(session.getRemoteAddress()) + " session=" + next.getSessionId());
      next.start();
    }
    catch (BaskStreamProtocolException e)
    {
      runtime.getService().LOG.log(Level.WARNING, "Failed to initialize baskStream websocket session", e);
      session.close(1008, e.getMessage());
    }
  }

  @Override
  public void onWebSocketBinary(byte[] payload, int offset, int len)
  {
    BaskStreamClientSession current = clientSession;
    if (current == null)
    {
      return;
    }

    byte[] frame = Arrays.copyOfRange(payload, offset, offset + len);
    current.onBinary(frame);
  }

  @Override
  public void onWebSocketText(String message)
  {
    Session session = getSession();
    if (session != null && session.isOpen())
    {
      session.close(1003, "Text frames are not supported.");
    }
  }

  @Override
  public void onWebSocketClose(int statusCode, String reason)
  {
    synchronized (outbound)
    {
      transportClosed = true;
      outbound.clear();
      outboundBytes = 0L;
    }
    BaskStreamClientSession current = clientSession;
    clientSession = null;
    if (current != null)
    {
      current.close(reason == null ? "closed" : reason);
    }
    super.onWebSocketClose(statusCode, reason);
  }

  @Override
  public void onWebSocketError(Throwable cause)
  {
    runtime.getService().LOG.log(Level.WARNING, "baskStream websocket transport error", cause);
    BaskStreamClientSession current = clientSession;
    if (current != null)
    {
      current.close(cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage());
    }
    super.onWebSocketError(cause);
  }

  void send(byte[] payload) throws IOException
  {
    boolean start;
    synchronized (outbound)
    {
      if (transportClosed || getRemote() == null) throw new IOException("WebSocket is closed.");
      if (outbound.size() >= MAX_OUTBOUND_FRAMES || outboundBytes + payload.length > MAX_OUTBOUND_BYTES)
      {
        throw new IOException("WebSocket outbound queue limit reached.");
      }
      outbound.addLast(payload);
      outboundBytes += payload.length;
      start = !sending;
      sending = true;
    }
    if (start) sendNext();
  }

  private void sendNext()
  {
    final byte[] payload;
    synchronized (outbound)
    {
      payload = outbound.peekFirst();
      if (transportClosed || payload == null)
      {
        sending = false;
        return;
      }
    }
    try
    {
      getRemote().sendBytes(ByteBuffer.wrap(payload), new org.eclipse.jetty.websocket.api.WriteCallback()
      {
        public void writeSuccess()
        {
          synchronized (outbound)
          {
            if (transportClosed) return;
            outbound.removeFirst();
            outboundBytes -= payload.length;
          }
          sendNext();
        }

        public void writeFailed(Throwable failure)
        {
          closeTransport(1011, "WebSocket send failed.");
          BaskStreamClientSession current = clientSession;
          if (current != null) current.close("WebSocket send failed");
        }
      });
    }
    catch (RuntimeException failure)
    {
      closeTransport(1011, "WebSocket send failed.");
      BaskStreamClientSession current = clientSession;
      if (current != null) current.close("WebSocket send failed");
    }
  }

  void closeTransport(int statusCode, String reason)
  {
    synchronized (outbound)
    {
      transportClosed = true;
      outbound.clear();
      outboundBytes = 0L;
    }
    Session session = getSession();
    if (session != null && session.isOpen())
    {
      session.close(statusCode, reason);
    }
  }
}
