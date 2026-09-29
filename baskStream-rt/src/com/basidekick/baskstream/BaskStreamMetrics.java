package com.basidekick.baskstream;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Station-wide traffic counters since the service started. They are cheap to bump on any
 * thread; the runtime copies them onto the service's read-only properties periodically.
 */
final class BaskStreamMetrics
{
  final AtomicLong requests = new AtomicLong();
  final AtomicLong errors = new AtomicLong();
  final AtomicLong writeRequests = new AtomicLong();
  final AtomicLong resyncs = new AtomicLong();
  final AtomicLong requestTimeouts = new AtomicLong();
}
