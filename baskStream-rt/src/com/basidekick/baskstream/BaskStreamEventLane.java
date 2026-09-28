package com.basidekick.baskstream;

import java.util.ArrayDeque;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Runs one session's event work (COV snapshots, alarm and model notices) in order on a pool
 * shared by all sessions. Niagara callbacks and the shared scheduler only hand work over, so a
 * slow query or a slow client never holds their threads. The queue is bounded: when a session
 * falls too far behind, its backlog is dropped and replaced by one resync task.
 */
final class BaskStreamEventLane
{
  interface Resync
  {
    /** Builds the task that tells the client events were dropped. */
    Runnable afterDropping(int dropped);
  }

  private static final int BATCH = 64;

  private final Executor pool;
  private final int maxQueued;
  private final Resync resync;
  private final Logger log;
  private final ArrayDeque<Runnable> queue = new ArrayDeque<Runnable>();
  private boolean draining;
  private boolean closed;

  BaskStreamEventLane(Executor pool, int maxQueued, Resync resync, Logger log)
  {
    this.pool = pool;
    this.maxQueued = maxQueued;
    this.resync = resync;
    this.log = log;
  }

  /** Queues event work without blocking. */
  void submit(Runnable task)
  {
    boolean start = false;
    synchronized (queue)
    {
      if (closed)
      {
        return;
      }
      if (queue.size() >= maxQueued)
      {
        int dropped = queue.size();
        queue.clear();
        queue.add(resync.afterDropping(dropped));
      }
      queue.add(task);
      if (!draining)
      {
        draining = true;
        start = true;
      }
    }
    if (start)
    {
      schedule();
    }
  }

  void close()
  {
    synchronized (queue)
    {
      closed = true;
      queue.clear();
    }
  }

  int size()
  {
    synchronized (queue)
    {
      return queue.size();
    }
  }

  private void schedule()
  {
    try
    {
      pool.execute(this::drain);
    }
    catch (RejectedExecutionException stopping)
    {
      synchronized (queue)
      {
        draining = false;
        queue.clear();
      }
    }
  }

  private void drain()
  {
    for (int i = 0; i < BATCH; i++)
    {
      Runnable next;
      synchronized (queue)
      {
        next = queue.poll();
        if (next == null)
        {
          draining = false;
          return;
        }
      }
      try
      {
        next.run();
      }
      catch (Throwable e)
      {
        log.log(Level.WARNING, "baskStream event task failed", e);
      }
    }
    // Give other sessions a turn on the shared pool before continuing.
    schedule();
  }
}
