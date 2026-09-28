package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;

import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.BComponentEvent;
import javax.baja.sys.BComponentEventMask;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Subscriber;

/**
 * One session's point subscriptions: direct subscribe/unsubscribe, named view groups with leases,
 * the Niagara subscriber, and periodic revalidation of what is subscribed.
 */
final class BaskStreamPointSubscriptions
{
  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;
  final Map<String, BaskStreamPointResolver.ResolvedPoint> subscriptions =
      new ConcurrentHashMap<String, BaskStreamPointResolver.ResolvedPoint>();
  private final Set<String> directSubscriptions =
      Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
  private final Map<String, SubscriptionGroup> subscriptionGroups =
      new ConcurrentHashMap<String, SubscriptionGroup>();
  private final Subscriber subscriber;
  private final Object subscriptionLock = new Object();
  private ScheduledFuture<?> leaseSweepFuture;
  private long leaseSweepAt;
  // Points whose authorization check failed on the last revalidation sweep. Worker thread only.
  private final Set<String> unresolvedAtRevalidation = new java.util.HashSet<String>();

  BaskStreamPointSubscriptions(BaskStreamClientSession session)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
    this.subscriber = Subscriber.make(this::onComponentEvent);
    this.subscriber.setMask(BComponentEventMask.PROPERTY_EVENTS);
  }

  int count()
  {
    return subscriptions.size();
  }

  int directCount()
  {
    return directSubscriptions.size();
  }

  int groupCount()
  {
    return subscriptionGroups.size();
  }

  void release()
  {
    synchronized (subscriptionLock)
    {
      session.cancelScheduled(leaseSweepFuture);
      leaseSweepFuture = null;
    }
    directSubscriptions.clear();
    subscriptionGroups.clear();
    subscriptions.clear();
    subscriber.unsubscribeAll();
  }

  /** Drops points the user can no longer read (or that failed to resolve twice in a row); returns them. */
  List<String> revalidate()
  {
      Set<String> subscribed = new LinkedHashSet<String>(directSubscriptions);
      synchronized (subscriptionLock)
      {
        for (SubscriptionGroup group : subscriptionGroups.values())
        {
          subscribed.addAll(group.points);
        }
      }

      List<String> revoked = new ArrayList<String>();
      unresolvedAtRevalidation.retainAll(subscribed);
      for (String pointOrd : subscribed)
      {
        Boolean authorized = stillAuthorized(pointOrd);
        if (authorized == null)
        {
          // One failed check may be a glitch; failing twice in a row means the point is gone.
          if (!unresolvedAtRevalidation.add(pointOrd))
          {
            revoked.add(pointOrd);
          }
          continue;
        }
        unresolvedAtRevalidation.remove(pointOrd);
        if (!authorized.booleanValue())
        {
          revoked.add(pointOrd);
        }
      }
      unresolvedAtRevalidation.removeAll(revoked);


    if (!revoked.isEmpty())
    {
      synchronized (subscriptionLock)
      {
        for (String pointOrd : revoked)
        {
          directSubscriptions.remove(pointOrd);
          for (SubscriptionGroup group : subscriptionGroups.values())
          {
            group.points.remove(pointOrd);
          }
          removeActualSubscription(pointOrd);
        }
      }
    }
    return revoked;
  }

  void handleSubscribe(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> points = runtime.getCodec().requireStringList(request, "points");
    session.requireMaxSize(points, "points", BaskStreamClientSession.MAX_POINTS_PER_REQUEST);
    List<Object> results = new ArrayList<Object>(points.size());

    synchronized (subscriptionLock)
    {
      for (String pointOrd : points)
      {
        try
        {
          BaskStreamPointResolver.ResolvedPoint resolved = ensurePointSubscription(pointOrd);
          directSubscriptions.add(pointOrd);
          results.add(runtime.getResolver().snapshot(resolved, context).toWire());
        }
        catch (BaskStreamProtocolException e)
        {
          results.add(session.errorEntry(pointOrd, e.getCode(), e.getMessage()));
        }
      }
    }

    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = session.baseMessage("subscribed", id);
    response.put("points", results);
    session.send(response);
  }

  void handleUnsubscribe(Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> points = runtime.getCodec().requireStringList(request, "points");
    synchronized (subscriptionLock)
    {
      for (String pointOrd : points)
      {
        directSubscriptions.remove(pointOrd);
        removePointIfUnreferenced(pointOrd);
      }
    }
    runtime.onSubscriptionCountChanged();
  }

  void handleReplaceSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String groupName = normalizeGroupName(runtime.getCodec().optionalString(request, "group"));
    List<String> requested = runtime.getCodec().requireStringList(request, "points");
    session.requireMaxSize(requested, "points", BaskStreamClientSession.MAX_POINTS_PER_REQUEST);
    LinkedHashSet<String> desired = new LinkedHashSet<String>(requested);
    List<Object> results = new ArrayList<Object>(desired.size());
    long now = Clock.millis();
    int leaseSec = normalizeLeaseSec(request.get("leaseSec"));
    long expiresAt = leaseSec <= 0 ? 0L : now + leaseSec * 1000L;
    int added = 0;
    int removed = 0;

    synchronized (subscriptionLock)
    {
      SubscriptionGroup group = subscriptionGroups.get(groupName);
      if (group == null && !desired.isEmpty()
          && subscriptionGroups.size() >= Math.max(1, runtime.getService().getMaxSubscriptionsPerClientValue()))
      {
        throw new BaskStreamProtocolException("subscription_limit", "Subscription group limit reached.");
      }
      Set<String> oldPoints = group == null ? Collections.<String>emptySet() : new LinkedHashSet<String>(group.points);
      LinkedHashSet<String> newPoints = new LinkedHashSet<String>();
      // Release this group's obsolete references before admitting replacements.
      // Other groups and direct subscriptions continue to retain their points.
      if (group != null)
      {
        group.points.retainAll(desired);
        for (String oldPoint : oldPoints)
        {
          if (!desired.contains(oldPoint)) removePointIfUnreferenced(oldPoint);
        }
      }

      for (String pointOrd : desired)
      {
        try
        {
          BaskStreamPointResolver.ResolvedPoint resolved = ensurePointSubscription(pointOrd);
          newPoints.add(pointOrd);
          if (!oldPoints.contains(pointOrd))
          {
            added++;
          }
          results.add(runtime.getResolver().snapshot(resolved, context).toWire());
        }
        catch (BaskStreamProtocolException e)
        {
          results.add(session.errorEntry(pointOrd, e.getCode(), e.getMessage()));
        }
      }

      if (group == null)
      {
        group = new SubscriptionGroup(groupName, now);
        subscriptionGroups.put(groupName, group);
      }
      group.points.clear();
      group.points.addAll(newPoints);
      group.updatedAt = now;
      group.leaseSec = leaseSec;
      group.expiresAt = expiresAt;

      for (String oldPoint : oldPoints)
      {
        if (!newPoints.contains(oldPoint))
        {
          removed++;
          removePointIfUnreferenced(oldPoint);
        }
      }

      if (newPoints.isEmpty())
      {
        subscriptionGroups.remove(groupName);
      }
      scheduleLeaseSweepLocked();
    }

    runtime.onSubscriptionCountChanged();
    Map<String, Object> response = session.baseMessage("subscriptions_replaced", id);
    response.put("group", groupName);
    response.put("points", results);
    response.put("added", Long.valueOf(added));
    response.put("removed", Long.valueOf(removed));
    response.put("leaseSec", Long.valueOf(leaseSec));
    response.put("leaseExpiresAt", expiresAt == 0L ? null : Long.valueOf(expiresAt));
    response.put("pointSubscriptions", Long.valueOf(session.getPointSubscriptionCount()));
    response.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    session.send(response);
  }

  void handleRenewSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String groupName = normalizeGroupName(runtime.getCodec().optionalString(request, "group"));
    long now = Clock.millis();
    int leaseSec = normalizeLeaseSec(request.get("leaseSec"));
    long expiresAt = leaseSec <= 0 ? 0L : now + leaseSec * 1000L;
    SubscriptionGroup group;
    synchronized (subscriptionLock)
    {
      group = subscriptionGroups.get(groupName);
      if (group == null)
      {
        throw new BaskStreamProtocolException("group_not_found", "Subscription group not found: " + groupName);
      }
      group.updatedAt = now;
      group.leaseSec = leaseSec;
      group.expiresAt = expiresAt;
      scheduleLeaseSweepLocked();
    }

    Map<String, Object> response = session.baseMessage("subscriptions_renewed", id);
    response.put("group", groupName);
    response.put("pointCount", Long.valueOf(group.points.size()));
    response.put("leaseSec", Long.valueOf(leaseSec));
    response.put("leaseExpiresAt", expiresAt == 0L ? null : Long.valueOf(expiresAt));
    session.send(response);
  }

  void handleReleaseSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String groupName = normalizeGroupName(runtime.getCodec().optionalString(request, "group"));
    int removed = 0;
    synchronized (subscriptionLock)
    {
      SubscriptionGroup group = subscriptionGroups.remove(groupName);
      if (group == null)
      {
        throw new BaskStreamProtocolException("group_not_found", "Subscription group not found: " + groupName);
      }
      removed = group.points.size();
      for (String pointOrd : group.points)
      {
        removePointIfUnreferenced(pointOrd);
      }
      scheduleLeaseSweepLocked();
    }
    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = session.baseMessage("subscriptions_released", id);
    response.put("group", groupName);
    response.put("removed", Long.valueOf(removed));
    response.put("pointSubscriptions", Long.valueOf(session.getPointSubscriptionCount()));
    response.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    session.send(response);
  }

  void handleSubscriptionStatus(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Boolean includePoints = session.optionalBoolean(request, "includePoints");
    sweepExpiredSubscriptionGroups();

    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("id", session.sessionId);
    summary.put("user", session.user.getUsername());
    summary.put("closed", Boolean.valueOf(session.closed.get()));
    summary.put("pointSubscriptions", Long.valueOf(session.getPointSubscriptionCount()));
    summary.put("directPointSubscriptions", Long.valueOf(directSubscriptions.size()));
    summary.put("alarmSubscriptions", Long.valueOf(session.getAlarmSubscriptionCount()));
    summary.put("modelSubscriptions", Long.valueOf(session.getModelSubscriptionCount()));
    summary.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    summary.put("pendingCovPoints", Long.valueOf(session.cov.getPendingCovPointCount()));
    summary.put("pendingCovSourceEvents", Long.valueOf(session.cov.getPendingCovEventCount()));

    Map<String, Object> limits = new LinkedHashMap<String, Object>();
    limits.put("maxSubscriptionsPerClient", Long.valueOf(runtime.getService().getMaxSubscriptionsPerClientValue()));
    limits.put("subscriptionLeaseSec", Long.valueOf(runtime.getService().getSubscriptionLeaseSecValue()));
    limits.put("covBatchWindowMillis", Long.valueOf(runtime.getService().getCovBatchWindowMillisValue()));

    Map<String, Object> response = session.baseMessage("subscription_status_result", id);
    response.put("session", summary);
    response.put("limits", limits);
    response.put("groups", subscriptionGroupSummaries(Boolean.TRUE.equals(includePoints)));
    session.send(response);
  }

  private BaskStreamPointResolver.ResolvedPoint ensurePointSubscription(String pointOrd) throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint existing = subscriptions.get(pointOrd);
    if (existing != null)
    {
      return existing;
    }

    if (session.getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
    {
      throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
    }

    BaskStreamPointResolver.ResolvedPoint resolved = runtime.getResolver().resolve(pointOrd, context);
    subscriptions.put(pointOrd, resolved);
    if (resolved.getComponent() != null && !subscriber.isSubscribed(resolved.getComponent()))
    {
      subscriber.subscribe(resolved.getComponent(), 0, context);
    }
    return resolved;
  }

  private void removePointIfUnreferenced(String pointOrd)
  {
    if (directSubscriptions.contains(pointOrd) || isGroupReferenced(pointOrd))
    {
      return;
    }
    removeActualSubscription(pointOrd);
  }

  private boolean isGroupReferenced(String pointOrd)
  {
    for (SubscriptionGroup group : subscriptionGroups.values())
    {
      if (group.points.contains(pointOrd))
      {
        return true;
      }
    }
    return false;
  }

  private void removeActualSubscription(String pointOrd)
  {
    BaskStreamPointResolver.ResolvedPoint removed = subscriptions.remove(pointOrd);
    if (removed == null || removed.getComponent() == null)
    {
      return;
    }

    boolean stillNeeded = false;
    for (BaskStreamPointResolver.ResolvedPoint point : subscriptions.values())
    {
      if (removed.getComponent().equals(point.getComponent()))
      {
        stillNeeded = true;
        break;
      }
    }

    if (!stillNeeded)
    {
      subscriber.unsubscribe(removed.getComponent(), context);
    }
  }

  private void onComponentEvent(BComponentEvent event)
  {
    if (session.closed.get() || event.getId() != BComponentEvent.PROPERTY_CHANGED)
    {
      return;
    }
    // No lease sweep here: it takes subscriptionLock, which the worker can hold for a whole
    // batch, and this runs on Niagara's event thread. The lease timer handles expiry.

    // Runs on a Niagara event thread: only note which points changed. The event lane reads
    // their values when the batch is flushed.
    String slotName = event.getSlotName();
    List<String> changed = new ArrayList<String>();
    for (BaskStreamPointResolver.ResolvedPoint point : subscriptions.values())
    {
      if (point.getComponent() != null && point.getComponent().equals(event.getSourceComponent())
          && point.isTriggeredBy(slotName))
      {
        changed.add(point.getPointOrd());
      }
    }

    if (!changed.isEmpty())
    {
      session.cov.queueCovChanges(changed);
    }
  }

  private String normalizeGroupName(String group) throws BaskStreamProtocolException
  {
    if (group == null || group.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'group' is required.");
    }
    String normalized = group.trim();
    if (normalized.length() > BaskStreamClientSession.MAX_GROUP_NAME_LENGTH)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'group' must be " + BaskStreamClientSession.MAX_GROUP_NAME_LENGTH + " characters or fewer.");
    }
    return normalized;
  }

  private int normalizeLeaseSec(Object value) throws BaskStreamProtocolException
  {
    int leaseSec = runtime.getService().getSubscriptionLeaseSecValue();
    if (value != null)
    {
      if (!(value instanceof Number))
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'leaseSec' must be a number.");
      }
      leaseSec = ((Number) value).intValue();
    }
    if (leaseSec < 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'leaseSec' cannot be negative.");
    }
    if (leaseSec > BaskStreamClientSession.MAX_LEASE_SEC)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'leaseSec' cannot exceed " + BaskStreamClientSession.MAX_LEASE_SEC + ".");
    }
    return leaseSec;
  }

  void sweepExpiredSubscriptionGroups()
  {
    if (subscriptionGroups.isEmpty())
    {
      return;
    }
    boolean changed = false;
    long now = Clock.millis();
    synchronized (subscriptionLock)
    {
      for (SubscriptionGroup group : subscriptionGroups.values().toArray(new SubscriptionGroup[0]))
      {
        if (group.expiresAt > 0L && group.expiresAt <= now)
        {
          subscriptionGroups.remove(group.name);
          for (String pointOrd : group.points)
          {
            removePointIfUnreferenced(pointOrd);
          }
          changed = true;
        }
      }
      scheduleLeaseSweepLocked();
    }
    if (changed)
    {
      runtime.onSubscriptionCountChanged();
    }
  }

  private void scheduleLeaseSweepLocked()
  {
    if (session.closed.get())
    {
      return;
    }

    long now = Clock.millis();
    long next = Long.MAX_VALUE;
    for (SubscriptionGroup group : subscriptionGroups.values())
    {
      if (group.expiresAt > 0L && group.expiresAt < next)
      {
        next = group.expiresAt;
      }
    }
    if (next == leaseSweepAt && leaseSweepFuture != null && !leaseSweepFuture.isDone()) return;
    session.cancelScheduled(leaseSweepFuture);
    leaseSweepFuture = null;
    leaseSweepAt = next;
    if (next == Long.MAX_VALUE) return;

    leaseSweepFuture = runtime.schedule(new Runnable()
    {
      @Override
      public void run()
      {
        // Hop onto the session worker so the shared scheduler never waits on subscriptionLock.
        try
        {
          session.worker.execute(new Runnable()
          {
            @Override
            public void run()
            {
              synchronized (subscriptionLock)
              {
                leaseSweepAt = 0L;
                sweepExpiredSubscriptionGroups();
              }
            }
          });
        }
        catch (RejectedExecutionException ignored)
        {
          // Closing, or the request queue is full; the next request's sweep reschedules the timer.
        }
      }
    }, Math.max(100L, next - now));
  }

  /** TRUE or FALSE, or null when the check itself failed (for example, the point did not resolve). */
  private Boolean stillAuthorized(String pointOrd)
  {
    // The path policy may have been narrowed mid-session — re-check it explicitly.
    if (!BaskStreamAccessPolicy.isAllowed(runtime.getService(), pointOrd))
    {
      return Boolean.FALSE;
    }
    try
    {
      OrdTarget target = BOrd.make(pointOrd).resolve(runtime.getService(), context);
      return Boolean.valueOf(target.canRead());
    }
    catch (Exception e)
    {
      return null;
    }
  }

  private List<Object> subscriptionGroupSummaries(boolean includePoints)
  {
    long now = Clock.millis();
    List<Object> groups = new ArrayList<Object>(subscriptionGroups.size());
    for (SubscriptionGroup group : subscriptionGroups.values())
    {
      Map<String, Object> summary = new LinkedHashMap<String, Object>();
      summary.put("group", group.name);
      summary.put("pointCount", Long.valueOf(group.points.size()));
      summary.put("createdAt", Long.valueOf(group.createdAt));
      summary.put("updatedAt", Long.valueOf(group.updatedAt));
      summary.put("leaseSec", Long.valueOf(group.leaseSec));
      summary.put("leaseExpiresAt", group.expiresAt == 0L ? null : Long.valueOf(group.expiresAt));
      summary.put("ttlSec", group.expiresAt == 0L ? null : Long.valueOf(Math.max(0L, (group.expiresAt - now) / 1000L)));
      if (includePoints)
      {
        summary.put("points", new ArrayList<String>(group.points));
      }
      groups.add(summary);
    }
    return groups;
  }

  private static final class SubscriptionGroup
  {
    private final String name;
    private final LinkedHashSet<String> points = new LinkedHashSet<String>();
    private final long createdAt;
    private long updatedAt;
    private int leaseSec;
    private long expiresAt;

    private SubscriptionGroup(String name, long now)
    {
      this.name = name;
      this.createdAt = now;
      this.updatedAt = now;
    }
  }
}
