package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;

import javax.baja.sys.Clock;
import javax.baja.sys.Context;

/**
 * One session's COV batching: points marked changed by Niagara callbacks are coalesced and, after
 * the batch window, their latest values are read and sent from the session's event lane.
 */
final class BaskStreamCovBatcher
{
  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;
  private final Map<String, BaskStreamPointResolver.ResolvedPoint> subscriptions;
  private final Object covLock = new Object();
  // Points changed since the last COV flush. Values are read at flush time, so the latest wins.
  private final LinkedHashSet<String> pendingCov = new LinkedHashSet<String>();
  private final java.util.concurrent.atomic.AtomicLong covSequence = new java.util.concurrent.atomic.AtomicLong();
  private int pendingCovEventCount;
  private ScheduledFuture<?> covFlushFuture;

  BaskStreamCovBatcher(BaskStreamClientSession session, Map<String, BaskStreamPointResolver.ResolvedPoint> subscriptions)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
    this.subscriptions = subscriptions;
  }

  void close()
  {
    synchronized (covLock)
    {
      pendingCov.clear();
      pendingCovEventCount = 0;
      if (covFlushFuture != null)
      {
        covFlushFuture.cancel(false);
      }
      covFlushFuture = null;
    }
  }

  void queueCovChanges(List<String> pointOrds)
  {
    // A zero window still goes through the scheduler and the lane, just without waiting.
    int delayMillis = Math.max(0, runtime.getService().getCovBatchWindowMillisValue());
    synchronized (covLock)
    {
      if (session.closed.get())
      {
        return;
      }
      pendingCov.addAll(pointOrds);
      pendingCovEventCount++;
      if (covFlushFuture == null || covFlushFuture.isDone())
      {
        // The scheduler only hands the flush to this session's lane; it never snapshots or sends.
        covFlushFuture = runtime.schedule(() -> session.events.submit(this::flushPendingCov), delayMillis);
      }
    }
  }

  private void flushPendingCov()
  {
    List<String> pointOrds;
    int sourceEvents;
    synchronized (covLock)
    {
      covFlushFuture = null;
      if (pendingCov.isEmpty())
      {
        pendingCovEventCount = 0;
        return;
      }
      pointOrds = new ArrayList<String>(pendingCov);
      pendingCov.clear();
      sourceEvents = pendingCovEventCount;
      pendingCovEventCount = 0;
    }
    List<Object> changes = new ArrayList<Object>(pointOrds.size());
    for (String pointOrd : pointOrds)
    {
      BaskStreamPointResolver.ResolvedPoint point = subscriptions.get(pointOrd);
      if (point == null)
      {
        continue; // Unsubscribed since it changed.
      }
      try
      {
        changes.add(runtime.getResolver().snapshot(point, context).toWire());
      }
      catch (BaskStreamProtocolException e)
      {
        changes.add(session.errorEntry(pointOrd, e.getCode(), e.getMessage()));
      }
    }
    sendCov(changes, runtime.getService().getCovBatchWindowMillisValue() > 0, sourceEvents);
  }

  private void sendCov(List<Object> changes, boolean batched, int sourceEvents)
  {
    if (changes == null || changes.isEmpty())
    {
      return;
    }
    Map<String, Object> cov = session.baseMessage("cov", null);
    cov.put("sequence", Long.valueOf(covSequence.incrementAndGet()));
    cov.put("timestamp", Long.valueOf(Clock.millis()));
    cov.put("batched", Boolean.valueOf(batched));
    cov.put("sourceEvents", Long.valueOf(sourceEvents));
    cov.put("points", changes);
    session.send(cov);
  }

  int getPendingCovPointCount()
  {
    synchronized (covLock)
    {
      return pendingCov.size();
    }
  }

  int getPendingCovEventCount()
  {
    synchronized (covLock)
    {
      return pendingCovEventCount;
    }
  }
}
