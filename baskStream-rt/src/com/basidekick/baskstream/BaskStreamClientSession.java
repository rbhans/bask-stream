package com.basidekick.baskstream;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;

import javax.baja.alarm.BAlarmRecord;
import javax.baja.alarm.BAlarmService;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.BObject;
import javax.baja.sys.BComponent;
import javax.baja.sys.BComponentEvent;
import javax.baja.sys.BComponentEventMask;
import javax.baja.sys.BValue;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Subscriber;
import javax.baja.user.BUser;

final class BaskStreamClientSession
{
  private static final int MAX_GROUP_NAME_LENGTH = 128;
  private static final int MAX_LEASE_SEC = 86400;
  private static final int MAX_POINTS_PER_REQUEST = 1000;
  private static final int MAX_MODEL_BASES_PER_REQUEST = 100;

  private final BaskStreamWebSocketRuntime runtime;
  private final BaskStreamJettyWebSocketConnection connection;
  private final BUser user;
  private final Context context;
  private final String sessionId;
  // Baseline mounted state of the authenticated principal. If the principal is a live station
  // component it is mounted here and a later unmount means the user was removed (tear down). If
  // the handshake hands back a detached copy (never mounted), this stays false and we never use
  // the unmount signal — avoiding a false mass-disconnect on every session.
  private final boolean userMountedAtStart;
  private final Subscriber subscriber;
  private final Subscriber alarmSubscriber;
  private final Subscriber modelSubscriber;
  private final Map<String, BaskStreamPointResolver.ResolvedPoint> subscriptions =
      new ConcurrentHashMap<String, BaskStreamPointResolver.ResolvedPoint>();
  private final Set<String> directSubscriptions =
      Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
  private final Map<String, SubscriptionGroup> subscriptionGroups =
      new ConcurrentHashMap<String, SubscriptionGroup>();
  private final Map<String, BaskStreamAlarmResolver.AlarmSubscriptionSpec> alarmSubscriptions =
      new ConcurrentHashMap<String, BaskStreamAlarmResolver.AlarmSubscriptionSpec>();
  private final Map<String, BComponent> modelSubscriptions =
      new ConcurrentHashMap<String, BComponent>();
  private final AtomicBoolean closed = new AtomicBoolean(false);
  private final ExecutorService worker;
  private volatile Thread workerThread;
  private final Object subscriptionLock = new Object();
  private final Object covLock = new Object();
  private final LinkedHashMap<String, Object> pendingCov = new LinkedHashMap<String, Object>();
  private long covSequence;
  private long alarmSequence;
  private long modelSequence;
  private int pendingCovEventCount;
  private ScheduledFuture<?> covFlushFuture;
  private ScheduledFuture<?> leaseSweepFuture;
  private ScheduledFuture<?> revalidateFuture;

  BaskStreamClientSession(BaskStreamWebSocketRuntime runtime, BaskStreamJettyWebSocketConnection connection, BUser user, Context context)
  {
    this.runtime = runtime;
    this.connection = connection;
    this.user = user;
    this.context = context;
    this.userMountedAtStart = user.isMounted();
    this.sessionId = UUID.randomUUID().toString();
    this.worker = Executors.newSingleThreadExecutor(new ThreadFactory()
    {
      @Override
      public Thread newThread(Runnable r)
      {
        Thread t = new Thread(r, "baskStream-session-" + sessionId);
        t.setDaemon(true);
        workerThread = t;
        return t;
      }
    });
    this.subscriber = Subscriber.make(this::onComponentEvent);
    this.subscriber.setMask(BComponentEventMask.PROPERTY_EVENTS);
    this.alarmSubscriber = Subscriber.make(this::onAlarmEvent);
    this.alarmSubscriber.setMask(BComponentEventMask.make(new int[] { BComponentEvent.TOPIC_FIRED }));
    this.modelSubscriber = Subscriber.make(this::onModelEvent);
    this.modelSubscriber.setMask(BComponentEventMask.make(new int[] {
      BComponentEvent.PROPERTY_ADDED,
      BComponentEvent.PROPERTY_REMOVED,
      BComponentEvent.PROPERTY_RENAMED,
      BComponentEvent.PROPERTIES_REORDERED,
      BComponentEvent.FLAGS_CHANGED,
      BComponentEvent.FACETS_CHANGED,
      BComponentEvent.KNOB_ADDED,
      BComponentEvent.KNOB_REMOVED,
      BComponentEvent.RECATEGORIZED,
      BComponentEvent.COMPONENT_PARENTED,
      BComponentEvent.COMPONENT_UNPARENTED,
      BComponentEvent.COMPONENT_RENAMED,
      BComponentEvent.COMPONENT_REORDERED,
      BComponentEvent.COMPONENT_FLAGS_CHANGED,
      BComponentEvent.COMPONENT_FACETS_CHANGED,
      BComponentEvent.RELATION_KNOB_ADDED,
      BComponentEvent.RELATION_KNOB_REMOVED
    }));
  }

  String getUsername()
  {
    return user.getUsername();
  }

  String getSessionId()
  {
    return sessionId;
  }

  int getSubscriptionCount()
  {
    return subscriptions.size() + alarmSubscriptions.size() + modelSubscriptions.size();
  }

  int getPointSubscriptionCount()
  {
    return subscriptions.size();
  }

  int getAlarmSubscriptionCount()
  {
    return alarmSubscriptions.size();
  }

  int getModelSubscriptionCount()
  {
    return modelSubscriptions.size();
  }

  void onBinary(final byte[] payload)
  {
    if (closed.get())
    {
      return;
    }

    // Hand the frame to the per-session worker so the Jetty IO thread is never
    // blocked (e.g. by a large batch write's settle delays). The single-thread
    // executor preserves per-session FIFO ordering exactly as the prior inline path.
    try
    {
      worker.execute(new Runnable()
      {
        @Override
        public void run()
        {
          processFrame(payload);
        }
      });
    }
    catch (RejectedExecutionException e)
    {
      // Worker already shut down (session closing) — drop, matching the closed() contract.
    }
  }

  private void processFrame(byte[] payload)
  {
    if (closed.get())
    {
      return;
    }
    sweepExpiredSubscriptionGroups();

    String id = null;
    try
    {
      Map<String, Object> request = runtime.getCodec().decodeMessage(payload);
      String op = runtime.getCodec().requireString(request, "op");
      id = runtime.getCodec().optionalString(request, "id");

      if ("ping".equals(op))
      {
        sendPong(id);
      }
      else if ("capabilities".equals(op))
      {
        handleCapabilities(id);
      }
      else if ("read".equals(op))
      {
        handleRead(id, request);
      }
      else if ("write".equals(op))
      {
        handleWrite(id, request);
      }
      else if ("subscribe".equals(op))
      {
        handleSubscribe(id, request);
      }
      else if ("unsubscribe".equals(op))
      {
        handleUnsubscribe(request);
      }
      else if ("replace_subscriptions".equals(op))
      {
        handleReplaceSubscriptions(id, request);
      }
      else if ("renew_subscriptions".equals(op))
      {
        handleRenewSubscriptions(id, request);
      }
      else if ("release_subscriptions".equals(op))
      {
        handleReleaseSubscriptions(id, request);
      }
      else if ("subscription_status".equals(op))
      {
        handleSubscriptionStatus(id, request);
      }
      else if ("browse".equals(op))
      {
        handleBrowse(id, request);
      }
      else if ("describe".equals(op))
      {
        handleDescribe(id, request);
      }
      else if ("search".equals(op))
      {
        handleSearch(id, request);
      }
      else if ("describe_write".equals(op))
      {
        handleDescribeWrite(id, request);
      }
      else if ("read_history".equals(op))
      {
        handleReadHistory(id, request);
      }
      else if ("describe_history".equals(op))
      {
        handleDescribeHistory(id, request);
      }
      else if ("read_alarms".equals(op))
      {
        handleReadAlarms(id, request);
      }
      else if ("ack_alarm".equals(op) || "ack_alarms".equals(op))
      {
        handleAckAlarms(id, request);
      }
      else if ("clear_alarm".equals(op) || "clear_alarms".equals(op))
      {
        handleClearAlarms(id, request);
      }
      else if ("subscribe_alarms".equals(op))
      {
        handleSubscribeAlarms(id, request);
      }
      else if ("unsubscribe_alarms".equals(op))
      {
        handleUnsubscribeAlarms(id, request);
      }
      else if ("subscribe_model".equals(op))
      {
        handleSubscribeModel(id, request);
      }
      else if ("unsubscribe_model".equals(op))
      {
        handleUnsubscribeModel(id, request);
      }
      else if ("read_schedule".equals(op))
      {
        handleReadSchedule(id, request);
      }
      else if ("read_tags".equals(op))
      {
        handleReadTags(id, request);
      }
      else if ("write_tags".equals(op))
      {
        handleWriteTags(id, request);
      }
      else if ("write_relations".equals(op))
      {
        handleWriteRelations(id, request);
      }
      else
      {
        sendError(id, "unsupported_op", "Unsupported operation: " + op);
      }
    }
    catch (BaskStreamProtocolException e)
    {
      sendError(id, e.getCode(), e.getMessage());
    }
    catch (Exception e)
    {
      runtime.getService().LOG.log(Level.WARNING, "baskStream request handling failed for session " + sessionId, e);
      sendError(id, "internal_error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  void close(String reason)
  {
    if (!closed.compareAndSet(false, true))
    {
      return;
    }

    try
    {
      // Stop accepting new frames and drain the worker. close() can be invoked from the
      // worker itself (the send() IO-failure path inside processFrame), so only await
      // termination when we are NOT on the worker thread — otherwise we would deadlock.
      worker.shutdown();
      if (Thread.currentThread() != workerThread)
      {
        try
        {
          if (!worker.awaitTermination(5L, TimeUnit.SECONDS))
          {
            worker.shutdownNow();
          }
        }
        catch (InterruptedException e)
        {
          worker.shutdownNow();
          Thread.currentThread().interrupt();
        }
      }

      for (BaskStreamPointResolver.ResolvedPoint point : subscriptions.values().toArray(new BaskStreamPointResolver.ResolvedPoint[0]))
      {
        removeActualSubscription(point.getPointOrd());
      }
      directSubscriptions.clear();
      subscriptionGroups.clear();
      alarmSubscriptions.clear();
      modelSubscriptions.clear();
      synchronized (covLock)
      {
        pendingCov.clear();
        pendingCovEventCount = 0;
        cancelScheduled(covFlushFuture);
        covFlushFuture = null;
      }
      synchronized (subscriptionLock)
      {
        cancelScheduled(leaseSweepFuture);
        leaseSweepFuture = null;
        cancelScheduled(revalidateFuture);
        revalidateFuture = null;
      }
      subscriber.unsubscribeAll();
      alarmSubscriber.unsubscribeAll();
      modelSubscriber.unsubscribeAll();
    }
    finally
    {
      // Connection accounting must never leak even if a cleanup operation fails. Without
      // this guarantee, ordinary short-lived clients can permanently exhaust maxConnections.
      runtime.onClose(this);
      runtime.getService().audit("disconnect", "user=" + user.getUsername() + " session=" + sessionId + " reason=" + reason);
    }
  }

  private void handleCapabilities(String id)
  {
    Map<String, Object> capabilities = new LinkedHashMap<String, Object>();
    capabilities.put("apiVersion", "1.5");
    capabilities.put("module", "baskStream");
    capabilities.put("transport", "websocket-msgpack");
    capabilities.put("serverTime", Long.valueOf(Clock.millis()));
    capabilities.put("authenticatedUser", user.getUsername());
    capabilities.put("operations", listOf(
        "ping",
        "capabilities",
        "browse",
        "describe",
        "search",
        "read",
        "subscribe",
        "unsubscribe",
        "replace_subscriptions",
        "renew_subscriptions",
        "release_subscriptions",
        "subscription_status",
        "write",
        "describe_write",
        "read_history",
        "describe_history",
        "read_alarms",
        "ack_alarm",
        "ack_alarms",
        "clear_alarm",
        "clear_alarms",
        "subscribe_alarms",
        "unsubscribe_alarms",
        "read_schedule",
        "subscribe_model",
        "unsubscribe_model",
        "read_tags",
        "write_tags",
        "write_relations"));

    Map<String, Object> limits = new LinkedHashMap<String, Object>();
    limits.put("maxConnections", Long.valueOf(runtime.getService().getMaxConnectionsValue()));
    limits.put("maxConnectionsPerUser", Long.valueOf(runtime.getService().getMaxConnectionsPerUserValue()));
    limits.put("maxMessageBytes", Long.valueOf(runtime.getService().getMaxMessageBytesValue()));
    limits.put("activeConnections", Long.valueOf(runtime.getService().getActiveConnectionsValue()));
    limits.put("maxSubscriptionsPerClient", Long.valueOf(runtime.getService().getMaxSubscriptionsPerClientValue()));
    limits.put("maxLivePointsPerStream", Long.valueOf(runtime.getService().getMaxSubscriptionsPerClientValue()));
    limits.put("maxPointSnapshotPoints", Long.valueOf(runtime.getService().getMaxPointSnapshotPointsValue()));
    limits.put("totalSubscriptions", Long.valueOf(runtime.getService().getTotalSubscriptionsValue()));
    limits.put("heartbeatIntervalSec", Long.valueOf(runtime.getService().getHeartbeatIntervalSecValue()));
    limits.put("subscriptionLeaseSec", Long.valueOf(runtime.getService().getSubscriptionLeaseSecValue()));
    limits.put("maxSubscriptionLeaseSec", Long.valueOf(MAX_LEASE_SEC));
    limits.put("covBatchWindowMillis", Long.valueOf(runtime.getService().getCovBatchWindowMillisValue()));
    limits.put("defaultBrowseDepth", Long.valueOf(BaskStreamBrowseResolver.DEFAULT_DEPTH));
    limits.put("maxBrowseDepth", Long.valueOf(BaskStreamBrowseResolver.MAX_DEPTH));
    limits.put("defaultSearchDepth", Long.valueOf(BaskStreamBrowseResolver.DEFAULT_SEARCH_DEPTH));
    limits.put("maxSearchDepth", Long.valueOf(BaskStreamBrowseResolver.MAX_SEARCH_DEPTH));
    limits.put("defaultSearchLimit", Long.valueOf(BaskStreamBrowseResolver.DEFAULT_SEARCH_LIMIT));
    limits.put("maxSearchLimit", Long.valueOf(BaskStreamBrowseResolver.MAX_SEARCH_LIMIT));
    limits.put("defaultSearchMaxVisited", Long.valueOf(BaskStreamBrowseResolver.DEFAULT_SEARCH_MAX_VISITED));
    limits.put("maxSearchMaxVisited", Long.valueOf(BaskStreamBrowseResolver.MAX_SEARCH_MAX_VISITED));
    limits.put("defaultSearchTimeoutMillis", Long.valueOf(BaskStreamBrowseResolver.DEFAULT_SEARCH_TIMEOUT_MILLIS));
    limits.put("maxSearchTimeoutMillis", Long.valueOf(BaskStreamBrowseResolver.MAX_SEARCH_TIMEOUT_MILLIS));
    capabilities.put("limits", limits);

    Map<String, Object> session = new LinkedHashMap<String, Object>();
    session.put("id", sessionId);
    session.put("pointSubscriptions", Long.valueOf(getPointSubscriptionCount()));
    session.put("directPointSubscriptions", Long.valueOf(directSubscriptions.size()));
    session.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    session.put("alarmSubscriptions", Long.valueOf(getAlarmSubscriptionCount()));
    session.put("modelSubscriptions", Long.valueOf(getModelSubscriptionCount()));
    capabilities.put("session", session);

    Map<String, Object> schemas = new LinkedHashMap<String, Object>();
    schemas.put("nodeMetadata", "2");
    schemas.put("pointSnapshot", "2");
    schemas.put("history", "2");
    schemas.put("alarm", "1");
    schemas.put("modelEvents", "1");
    schemas.put("subscriptionGroups", "1");
    schemas.put("cov", "2");
    schemas.put("tags", "1");
    capabilities.put("schemas", schemas);

    Map<String, Object> subscriptionsMeta = new LinkedHashMap<String, Object>();
    subscriptionsMeta.put("pointCov", Boolean.TRUE);
    subscriptionsMeta.put("pointCovBatching", Boolean.valueOf(runtime.getService().getCovBatchWindowMillisValue() > 0));
    subscriptionsMeta.put("viewGroups", Boolean.TRUE);
    subscriptionsMeta.put("leasedGroups", Boolean.valueOf(runtime.getService().getSubscriptionLeaseSecValue() > 0));
    subscriptionsMeta.put("alarmEvents", Boolean.TRUE);
    subscriptionsMeta.put("modelEvents", Boolean.TRUE);
    subscriptionsMeta.put("sharedStationSubscriptions", Boolean.FALSE);
    subscriptionsMeta.put("historyLive", Boolean.FALSE);
    subscriptionsMeta.put("scheduleLive", Boolean.FALSE);
    capabilities.put("subscriptions", subscriptionsMeta);

    Map<String, Object> pointSnapshot = new LinkedHashMap<String, Object>();
    pointSnapshot.put("operation", "read");
    pointSnapshot.put("batch", Boolean.TRUE);
    pointSnapshot.put("facets", Boolean.TRUE);
    pointSnapshot.put("fieldSelection", Boolean.TRUE);
    pointSnapshot.put("maxPoints", Long.valueOf(runtime.getService().getMaxPointSnapshotPointsValue()));
    pointSnapshot.put("fields", listOf(
        "point",
        "ok",
        "display",
        "type",
        "valueType",
        "value",
        "displayValue",
        "status",
        "timestamp",
        "facets",
        "enumOrdinal",
        "enumTag",
        "enumDisplay",
        "enumOptions"));
    capabilities.put("pointSnapshot", pointSnapshot);

    Map<String, Object> tagsMeta = new LinkedHashMap<String, Object>();
    tagsMeta.put("read", Boolean.TRUE);
    tagsMeta.put("writeDirect", Boolean.TRUE);
    tagsMeta.put("relations", Boolean.TRUE);
    tagsMeta.put("impliedTagsReadOnly", Boolean.TRUE);
    tagsMeta.put("maxTargetsPerRequest", Long.valueOf(runtime.getTagResolver().getMaxTargetsPerRequest()));
    tagsMeta.put("note", "Tags are dictionary-neutral: address Haystack (hs:), Niagara (n:), and hierarchy/site dictionary tags by qualified name.");
    capabilities.put("tags", tagsMeta);

    Map<String, Object> graphics = new LinkedHashMap<String, Object>();
    graphics.put("plainPx", Boolean.FALSE);
    graphics.put("plainGraphic", Boolean.FALSE);
    graphics.put("note", "Plain Px/WebOp embedding is not implemented in this API version.");
    capabilities.put("graphics", graphics);

    Map<String, Object> policy = new LinkedHashMap<String, Object>();
    policy.put("allowedPathPatterns", runtime.getService().getAllowedPathPatterns());
    policy.put("allowedOrigins", runtime.getService().getAllowedOrigins());
    policy.put("slotBrowseOnly", Boolean.TRUE);
    policy.put("hierarchyBrowse", Boolean.TRUE);
    policy.put("historyOrdReads", Boolean.TRUE);
    capabilities.put("policy", policy);

    Map<String, Object> response = baseMessage("capabilities_result", id);
    response.put("capabilities", capabilities);
    send(response);
  }

  private void handleRead(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> points = runtime.getCodec().requireStringList(request, "points");
    requireMaxSize(points, "points", runtime.getService().getMaxPointSnapshotPointsValue());
    List<String> fields = normalizeSnapshotFields(request);
    List<Object> results = new ArrayList<Object>(points.size());
    for (String pointOrd : points)
    {
      results.add(resolveReadResult(pointOrd, fields));
    }

    Map<String, Object> response = baseMessage("read_result", id);
    response.put("points", results);
    send(response);
  }

  private void handleWrite(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = baseMessage("write_result", id);
    response.put("points", runtime.getWriteResolver().write(request, context));
    send(response);
  }

  private void handleSubscribe(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> points = runtime.getCodec().requireStringList(request, "points");
    requireMaxSize(points, "points", MAX_POINTS_PER_REQUEST);
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
          results.add(errorEntry(pointOrd, e.getCode(), e.getMessage()));
        }
      }
    }

    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = baseMessage("subscribed", id);
    response.put("points", results);
    send(response);
  }

  private void handleUnsubscribe(Map<String, Object> request) throws BaskStreamProtocolException
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

  private void handleReplaceSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String groupName = normalizeGroupName(runtime.getCodec().optionalString(request, "group"));
    List<String> requested = runtime.getCodec().requireStringList(request, "points");
    requireMaxSize(requested, "points", MAX_POINTS_PER_REQUEST);
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
      Set<String> oldPoints = group == null ? Collections.<String>emptySet() : new LinkedHashSet<String>(group.points);
      LinkedHashSet<String> newPoints = new LinkedHashSet<String>();

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
          results.add(errorEntry(pointOrd, e.getCode(), e.getMessage()));
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
    Map<String, Object> response = baseMessage("subscriptions_replaced", id);
    response.put("group", groupName);
    response.put("points", results);
    response.put("added", Long.valueOf(added));
    response.put("removed", Long.valueOf(removed));
    response.put("leaseSec", Long.valueOf(leaseSec));
    response.put("leaseExpiresAt", expiresAt == 0L ? null : Long.valueOf(expiresAt));
    response.put("pointSubscriptions", Long.valueOf(getPointSubscriptionCount()));
    response.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    send(response);
  }

  private void handleRenewSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
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

    Map<String, Object> response = baseMessage("subscriptions_renewed", id);
    response.put("group", groupName);
    response.put("pointCount", Long.valueOf(group.points.size()));
    response.put("leaseSec", Long.valueOf(leaseSec));
    response.put("leaseExpiresAt", expiresAt == 0L ? null : Long.valueOf(expiresAt));
    send(response);
  }

  private void handleReleaseSubscriptions(String id, Map<String, Object> request) throws BaskStreamProtocolException
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

    Map<String, Object> response = baseMessage("subscriptions_released", id);
    response.put("group", groupName);
    response.put("removed", Long.valueOf(removed));
    response.put("pointSubscriptions", Long.valueOf(getPointSubscriptionCount()));
    response.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    send(response);
  }

  private void handleSubscriptionStatus(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Boolean includePoints = optionalBoolean(request, "includePoints");
    sweepExpiredSubscriptionGroups();

    Map<String, Object> session = new LinkedHashMap<String, Object>();
    session.put("id", sessionId);
    session.put("user", user.getUsername());
    session.put("closed", Boolean.valueOf(closed.get()));
    session.put("pointSubscriptions", Long.valueOf(getPointSubscriptionCount()));
    session.put("directPointSubscriptions", Long.valueOf(directSubscriptions.size()));
    session.put("alarmSubscriptions", Long.valueOf(getAlarmSubscriptionCount()));
    session.put("modelSubscriptions", Long.valueOf(getModelSubscriptionCount()));
    session.put("subscriptionGroups", Long.valueOf(subscriptionGroups.size()));
    session.put("pendingCovPoints", Long.valueOf(getPendingCovPointCount()));
    session.put("pendingCovSourceEvents", Long.valueOf(getPendingCovEventCount()));

    Map<String, Object> limits = new LinkedHashMap<String, Object>();
    limits.put("maxSubscriptionsPerClient", Long.valueOf(runtime.getService().getMaxSubscriptionsPerClientValue()));
    limits.put("subscriptionLeaseSec", Long.valueOf(runtime.getService().getSubscriptionLeaseSecValue()));
    limits.put("covBatchWindowMillis", Long.valueOf(runtime.getService().getCovBatchWindowMillisValue()));

    Map<String, Object> response = baseMessage("subscription_status_result", id);
    response.put("session", session);
    response.put("limits", limits);
    response.put("groups", subscriptionGroupSummaries(Boolean.TRUE.equals(includePoints)));
    send(response);
  }

  private void handleBrowse(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String baseOrd = runtime.getCodec().optionalString(request, "base");
    int depth = runtime.getBrowseResolver().normalizeDepth(request.get("depth"));
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_NONE);

    Map<String, Object> response = baseMessage("browse_result", id);
    response.put("depth", Long.valueOf(depth));
    response.put("metadata", metadataMode);
    response.put("node", runtime.getBrowseResolver().browse(baseOrd, depth, metadataMode, context));
    send(response);
  }

  private void handleDescribe(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "base");
    }

    Map<String, Object> response = baseMessage("describe_result", id);
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_FULL);
    response.put("metadata", metadataMode);
    response.put("node", runtime.getBrowseResolver().describe(ord, metadataMode, context));
    send(response);
  }

  private void handleSearch(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String baseOrd = runtime.getCodec().optionalString(request, "base");
    Object searchDepth = request.containsKey("maxDepth") ? request.get("maxDepth") : request.get("depth");
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_NONE);
    Map<String, Object> response = baseMessage("search_result", id);
    response.put("result", runtime.getBrowseResolver().search(
        baseOrd,
        searchDepth,
        metadataMode,
        runtime.getCodec().optionalString(request, "query"),
        runtime.getCodec().optionalString(request, "kind"),
        optionalStringList(request, "features"),
        optionalStringList(request, "operations"),
        optionalBoolean(request, "writable"),
        request.get("limit"),
        request.get("maxVisited"),
        request.get("timeoutMillis"),
        context));
    send(response);
  }

  private void handleDescribeWrite(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = baseMessage("write_description", id);
    response.put("points", runtime.getWriteResolver().describe(request, context));
    send(response);
  }

  private Object metadataRequestValue(Map<String, Object> request)
  {
    if (request.containsKey("metadata"))
    {
      return request.get("metadata");
    }
    return request.get("includeMetadata");
  }

  private void handleReadHistory(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    Map<String, Object> response = baseMessage("history_result", id);
    response.put("history", runtime.getHistoryResolver().readHistory(
        ord,
        request.get("start"),
        request.get("end"),
        request.get("limit"),
        context));
    send(response);
  }

  private void handleDescribeHistory(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "source");
    }

    Map<String, Object> response = baseMessage("history_description", id);
    response.put("history", runtime.getHistoryResolver().describeHistory(ord, context));
    send(response);
  }

  private void handleReadAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    String scope = runtime.getCodec().optionalString(request, "scope");

    Map<String, Object> response = baseMessage("alarms_result", id);
    response.put("alarms", runtime.getAlarmResolver().readAlarms(source, scope, request.get("limit"), context));
    send(response);
  }

  private void handleAckAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    Map<String, Object> response = baseMessage("alarm_action_result", id);
    response.put("alarms", runtime.getAlarmResolver().acknowledgeAlarms(alarmUuidValue(request), source, context, user.getUsername()));
    send(response);
  }

  private void handleClearAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    Map<String, Object> response = baseMessage("alarm_action_result", id);
    response.put("alarms", runtime.getAlarmResolver().clearAlarms(alarmUuidValue(request), source, context, user.getUsername()));
    send(response);
  }

  private Object alarmUuidValue(Map<String, Object> request)
  {
    return request.containsKey("uuids") ? request.get("uuids") : request.get("uuid");
  }

  private void handleSubscribeAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    BaskStreamAlarmResolver.AlarmSubscriptionSpec spec = runtime.getAlarmResolver().normalizeSubscription(
        runtime.getCodec().optionalString(request, "source"),
        runtime.getCodec().optionalString(request, "scope"),
        request.get("limit"),
        runtime.getCodec().optionalString(request, "mode"));

    if (!alarmSubscriptions.containsKey(spec.key())
        && getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
    {
      throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
    }
    runtime.getAlarmResolver().requireAllowed(spec);
    ensureAlarmServiceSubscribed();
    alarmSubscriptions.put(spec.key(), spec);
    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = baseMessage("alarms_subscribed", id);
    response.put("mode", spec.mode);
    response.put("alarms", runtime.getAlarmResolver().readAlarms(spec.source, spec.scope, Integer.valueOf(spec.limit), context));
    send(response);
  }

  private void handleUnsubscribeAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    boolean hasFilter = request.containsKey("source") || request.containsKey("scope") || request.containsKey("limit") || request.containsKey("mode");
    if (!hasFilter)
    {
      alarmSubscriptions.clear();
      alarmSubscriber.unsubscribeAll();
      runtime.onSubscriptionCountChanged();
      sendUnsubscribedAlarms(id);
      return;
    }

    String mode = runtime.getCodec().optionalString(request, "mode");
    BaskStreamAlarmResolver.AlarmSubscriptionSpec spec = runtime.getAlarmResolver().normalizeSubscription(
        runtime.getCodec().optionalString(request, "source"),
        runtime.getCodec().optionalString(request, "scope"),
        request.get("limit"),
        mode);
    if (mode == null || mode.trim().length() == 0)
    {
      removeAlarmSubscriptions(spec);
    }
    else
    {
      alarmSubscriptions.remove(spec.key());
    }
    if (alarmSubscriptions.isEmpty())
    {
      alarmSubscriber.unsubscribeAll();
    }
    runtime.onSubscriptionCountChanged();
    sendUnsubscribedAlarms(id);
  }

  private void sendUnsubscribedAlarms(String id)
  {
    if (id == null)
    {
      return;
    }
    Map<String, Object> response = baseMessage("alarms_unsubscribed", id);
    response.put("remaining", Long.valueOf(alarmSubscriptions.size()));
    send(response);
  }

  private void removeAlarmSubscriptions(BaskStreamAlarmResolver.AlarmSubscriptionSpec spec)
  {
    for (BaskStreamAlarmResolver.AlarmSubscriptionSpec existing :
        alarmSubscriptions.values().toArray(new BaskStreamAlarmResolver.AlarmSubscriptionSpec[0]))
    {
      if (sameAlarmFilter(existing, spec))
      {
        alarmSubscriptions.remove(existing.key());
      }
    }
  }

  private boolean sameAlarmFilter(BaskStreamAlarmResolver.AlarmSubscriptionSpec left, BaskStreamAlarmResolver.AlarmSubscriptionSpec right)
  {
    if (left.limit != right.limit || !left.scope.equals(right.scope))
    {
      return false;
    }
    if (left.source == null)
    {
      return right.source == null;
    }
    return left.source.equals(right.source);
  }

  private void handleSubscribeModel(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> bases = modelBaseOrds(request);
    int depth = runtime.getBrowseResolver().normalizeDepth(request.get("depth"));
    List<Object> roots = new ArrayList<Object>();
    int before = modelSubscriptions.size();
    for (String base : bases)
    {
      BComponent component = resolveModelComponent(base);
      roots.add(componentSummary(component));
      subscribeModelComponent(component, depth);
    }
    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = baseMessage("model_subscribed", id);
    response.put("bases", roots);
    response.put("depth", Long.valueOf(depth));
    response.put("added", Long.valueOf(modelSubscriptions.size() - before));
    response.put("count", Long.valueOf(modelSubscriptions.size()));
    response.put("mode", "component_events");
    response.put("note", "Model events are change hints; refresh affected branches with browse/describe.");
    send(response);
  }

  private void handleUnsubscribeModel(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    if (!request.containsKey("base") && !request.containsKey("bases"))
    {
      modelSubscriptions.clear();
      modelSubscriber.unsubscribeAll();
    }
    else
    {
      for (String base : modelBaseOrds(request))
      {
        BComponent component = resolveModelComponent(base);
        unsubscribeModelComponent(component);
      }
    }
    runtime.onSubscriptionCountChanged();
    if (id != null)
    {
      Map<String, Object> response = baseMessage("model_unsubscribed", id);
      response.put("count", Long.valueOf(modelSubscriptions.size()));
      send(response);
    }
  }

  private List<String> modelBaseOrds(Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> bases = optionalStringList(request, "bases");
    if (bases != null && !bases.isEmpty())
    {
      requireMaxSize(bases, "bases", MAX_MODEL_BASES_PER_REQUEST);
      return bases;
    }
    String base = runtime.getCodec().optionalString(request, "base");
    if (base == null || base.trim().length() == 0)
    {
      base = "slot:/";
    }
    List<String> single = new ArrayList<String>(1);
    single.add(base);
    return single;
  }

  private void requireMaxSize(List<?> values, String key, int max) throws BaskStreamProtocolException
  {
    if (values != null && values.size() > max)
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' cannot contain more than " + max + " entries.");
    }
  }

  private BComponent resolveModelComponent(String ord) throws BaskStreamProtocolException
  {
    if (ord == null || !ord.startsWith("slot:/"))
    {
      throw new BaskStreamProtocolException("invalid_point", "Model subscriptions support slot:/ ORDs only.");
    }
    if (!runtime.getBrowseResolver().isAllowedOrd(ord))
    {
      throw new BaskStreamProtocolException("forbidden_point", "Model subscription base is outside allowedPathPatterns.");
    }
    try
    {
      OrdTarget target = BOrd.make(ord).resolve(runtime.getService(), context);
      if (!target.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_point", "Model subscription base is not readable for the authenticated user.");
      }
      BObject object = target.get();
      BComponent component = object instanceof BComponent ? (BComponent) object : target.getComponent();
      if (component == null)
      {
        throw new BaskStreamProtocolException("invalid_point", "Model subscription base did not resolve to a component.");
      }
      return component;
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("invalid_point",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private void subscribeModelComponent(BComponent component, int depth) throws BaskStreamProtocolException
  {
    String key = componentKey(component);
    if (key == null)
    {
      return;
    }
    if (!BaskStreamAccessPolicy.isAllowed(runtime.getService(), key) || !canReadModelComponent(component))
    {
      return;
    }
    if (!modelSubscriptions.containsKey(key))
    {
      if (getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
      {
        throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
      }
      modelSubscriptions.put(key, component);
      if (!modelSubscriber.isSubscribed(component))
      {
        modelSubscriber.subscribe(component, runtime.getService().getHeartbeatIntervalSecValue() * 1000, context);
      }
    }
    if (depth <= 0)
    {
      return;
    }
    BComponent[] children = component.getChildComponents();
    for (int i = 0; i < children.length; i++)
    {
      subscribeModelComponent(children[i], depth - 1);
    }
  }

  private void unsubscribeModelComponent(BComponent component)
  {
    String key = componentKey(component);
    if (key != null)
    {
      modelSubscriptions.remove(key);
      modelSubscriber.unsubscribe(component, context);
    }
    BComponent[] children = component.getChildComponents();
    for (int i = 0; i < children.length; i++)
    {
      unsubscribeModelComponent(children[i]);
    }
  }

  private String componentKey(BComponent component)
  {
    return component == null || component.getSlotPath() == null ? null : component.getSlotPath().toString();
  }

  private boolean canReadModelComponent(BComponent component)
  {
    String key = componentKey(component);
    if (key == null || !BaskStreamAccessPolicy.isAllowed(runtime.getService(), key))
    {
      return false;
    }
    try
    {
      OrdTarget target = BOrd.make(key).resolve(runtime.getService(), context);
      return target.canRead();
    }
    catch (Exception e)
    {
      return false;
    }
  }

  private Map<String, Object> componentSummary(BComponent component)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    if (component == null)
    {
      return summary;
    }
    summary.put("slotPath", component.getSlotPath() == null ? null : component.getSlotPath().toString());
    summary.put("name", component.getName());
    summary.put("display", component.getDisplayName(context));
    summary.put("typeSpec", component.getType().toString());
    return summary;
  }

  private void handleReadSchedule(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "source");
    }

    Map<String, Object> response = baseMessage("schedule_result", id);
    response.put("schedule", runtime.getScheduleResolver().readSchedule(ord, request.get("at"), context));
    send(response);
  }

  private void handleReadTags(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = baseMessage("tags_result", id);
    response.put("targets", runtime.getTagResolver().readTags(request, context));
    send(response);
  }

  private void handleWriteTags(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = baseMessage("tags_written", id);
    response.put("targets", runtime.getTagResolver().writeTags(request, context));
    send(response);
  }

  private void handleWriteRelations(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = baseMessage("relations_written", id);
    response.put("targets", runtime.getTagResolver().writeRelations(request, context));
    send(response);
  }

  private void ensureAlarmServiceSubscribed() throws BaskStreamProtocolException
  {
    BAlarmService alarmService = BAlarmService.getService();
    if (alarmService == null)
    {
      throw new BaskStreamProtocolException("alarm_failed", "Niagara AlarmService is not available.");
    }
    if (!alarmSubscriber.isSubscribed(alarmService))
    {
      alarmSubscriber.subscribe(alarmService, runtime.getService().getHeartbeatIntervalSecValue() * 1000, context);
    }
  }

  private BaskStreamPointResolver.ResolvedPoint ensurePointSubscription(String pointOrd) throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint existing = subscriptions.get(pointOrd);
    if (existing != null)
    {
      return existing;
    }

    if (getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
    {
      throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
    }

    BaskStreamPointResolver.ResolvedPoint resolved = runtime.getResolver().resolve(pointOrd, context);
    subscriptions.put(pointOrd, resolved);
    if (resolved.getComponent() != null && !subscriber.isSubscribed(resolved.getComponent()))
    {
      subscriber.subscribe(resolved.getComponent(), runtime.getService().getHeartbeatIntervalSecValue() * 1000, context);
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

  private Object resolveReadResult(String pointOrd, List<String> fields)
  {
    try
    {
      BaskStreamPointResolver.ResolvedPoint point = runtime.getResolver().resolve(pointOrd, context);
      return runtime.getResolver().snapshot(point, context).toWire(fields);
    }
    catch (BaskStreamProtocolException e)
    {
      return errorEntry(pointOrd, e.getCode(), e.getMessage());
    }
  }

  private List<String> normalizeSnapshotFields(Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> fields = optionalStringList(request, "fields");
    if (fields == null)
    {
      return null;
    }

    List<String> normalized = new ArrayList<String>(fields.size());
    for (String raw : fields)
    {
      String field = raw == null ? "" : raw.trim();
      if (field.length() == 0)
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'fields' cannot contain blank entries.");
      }
      if (!isSupportedSnapshotField(field))
      {
        throw new BaskStreamProtocolException("bad_request", "Unsupported point snapshot field: " + field);
      }
      if (!normalized.contains(field))
      {
        normalized.add(field);
      }
    }
    return normalized;
  }

  private boolean isSupportedSnapshotField(String field)
  {
    return "point".equals(field)
        || "ok".equals(field)
        || "display".equals(field)
        || "type".equals(field)
        || "valueType".equals(field)
        || "value".equals(field)
        || "displayValue".equals(field)
        || "status".equals(field)
        || "timestamp".equals(field)
        || "facets".equals(field)
        || "enumOrdinal".equals(field)
        || "enumTag".equals(field)
        || "enumDisplay".equals(field)
        || "enumOptions".equals(field);
  }

  private void onComponentEvent(BComponentEvent event)
  {
    if (closed.get() || event.getId() != BComponentEvent.PROPERTY_CHANGED)
    {
      return;
    }
    sweepExpiredSubscriptionGroups();

    String slotName = event.getSlotName();
    List<Object> changes = new ArrayList<Object>();
    for (BaskStreamPointResolver.ResolvedPoint point : subscriptions.values())
    {
      if (point.getComponent() == null || !point.getComponent().equals(event.getSourceComponent()))
      {
        continue;
      }

      if (!point.isTriggeredBy(slotName))
      {
        continue;
      }

      try
      {
        changes.add(runtime.getResolver().snapshot(point, context).toWire());
      }
      catch (BaskStreamProtocolException e)
      {
        changes.add(errorEntry(point.getPointOrd(), e.getCode(), e.getMessage()));
      }
    }

    if (!changes.isEmpty())
    {
      queueCovChanges(changes);
    }
  }

  private void onAlarmEvent(BComponentEvent event)
  {
    if (closed.get() || event.getId() != BComponentEvent.TOPIC_FIRED || !"alarm".equals(event.getSlotName()))
    {
      return;
    }

    BAlarmRecord record = alarmRecord(event);
    for (BaskStreamAlarmResolver.AlarmSubscriptionSpec spec : alarmSubscriptions.values())
    {
      try
      {
        runtime.getAlarmResolver().requireAllowed(spec);
        if (record != null && spec.source != null && !runtime.getAlarmResolver().matchesSource(record, spec.source))
        {
          continue;
        }

        Map<String, Object> message = baseMessage("alarm_cov", null);
        message.put("sequence", Long.valueOf(++alarmSequence));
        message.put("timestamp", Long.valueOf(Clock.millis()));
        message.put("source", spec.source);
        message.put("scope", spec.scope);
        message.put("limit", Long.valueOf(spec.limit));
        message.put("mode", spec.mode);

        if (record != null)
        {
          message.put("event", runtime.getAlarmResolver().toWire(record, context));
          message.put("inScope", Boolean.valueOf(runtime.getAlarmResolver().matchesScope(record, spec.scope)));
        }
        else
        {
          message.put("event", null);
          message.put("refreshRecommended", Boolean.TRUE);
        }

        if ("snapshot".equals(spec.mode) || "both".equals(spec.mode) || record == null)
        {
          message.put("alarms", runtime.getAlarmResolver().readAlarms(spec.source, spec.scope, Integer.valueOf(spec.limit), context));
        }
        send(message);
      }
      catch (BaskStreamProtocolException e)
      {
        sendError(null, e.getCode(), e.getMessage());
      }
    }
  }

  private void onModelEvent(BComponentEvent event)
  {
    if (closed.get())
    {
      return;
    }

    BComponent source = event.getSourceComponent();
    if (!canReadModelComponent(source))
    {
      return;
    }
    Map<String, Object> message = baseMessage("model_cov", null);
    message.put("sequence", Long.valueOf(++modelSequence));
    message.put("timestamp", Long.valueOf(Clock.millis()));
    message.put("eventId", Long.valueOf(event.getId()));
    message.put("event", modelEventName(event.getId()));
    message.put("slot", event.getSlotName());
    message.put("source", componentSummary(source));
    BValue value = event.getValue();
    if (value != null)
    {
      message.put("valueType", value.getType().toString());
      message.put("value", value.toString(context));
    }
    message.put("refreshRecommended", Boolean.TRUE);
    send(message);
  }

  private String modelEventName(int id)
  {
    switch (id)
    {
      case BComponentEvent.PROPERTY_ADDED:
        return "property_added";
      case BComponentEvent.PROPERTY_REMOVED:
        return "property_removed";
      case BComponentEvent.PROPERTY_RENAMED:
        return "property_renamed";
      case BComponentEvent.PROPERTIES_REORDERED:
        return "properties_reordered";
      case BComponentEvent.FLAGS_CHANGED:
        return "flags_changed";
      case BComponentEvent.FACETS_CHANGED:
        return "facets_changed";
      case BComponentEvent.KNOB_ADDED:
        return "knob_added";
      case BComponentEvent.KNOB_REMOVED:
        return "knob_removed";
      case BComponentEvent.RECATEGORIZED:
        return "recategorized";
      case BComponentEvent.COMPONENT_PARENTED:
        return "component_parented";
      case BComponentEvent.COMPONENT_UNPARENTED:
        return "component_unparented";
      case BComponentEvent.COMPONENT_RENAMED:
        return "component_renamed";
      case BComponentEvent.COMPONENT_REORDERED:
        return "component_reordered";
      case BComponentEvent.COMPONENT_FLAGS_CHANGED:
        return "component_flags_changed";
      case BComponentEvent.COMPONENT_FACETS_CHANGED:
        return "component_facets_changed";
      case BComponentEvent.RELATION_KNOB_ADDED:
        return "relation_added";
      case BComponentEvent.RELATION_KNOB_REMOVED:
        return "relation_removed";
      default:
        return "component_event";
    }
  }

  private BAlarmRecord alarmRecord(BComponentEvent event)
  {
    BValue value = event.getValue();
    return value instanceof BAlarmRecord ? (BAlarmRecord) value : null;
  }

  private void queueCovChanges(List<Object> changes)
  {
    int delayMillis = runtime.getService().getCovBatchWindowMillisValue();
    if (delayMillis <= 0)
    {
      sendCov(changes, false, 1);
      return;
    }

    synchronized (covLock)
    {
      for (Object change : changes)
      {
        String key = pointKey(change);
        if (key == null)
        {
          key = "entry-" + pendingCov.size();
        }
        if (pendingCov.containsKey(key))
        {
          pendingCov.remove(key);
        }
        pendingCov.put(key, change);
      }
      pendingCovEventCount++;
      if (covFlushFuture == null || covFlushFuture.isDone())
      {
        covFlushFuture = runtime.schedule(new Runnable()
        {
          @Override
          public void run()
          {
            flushPendingCov();
          }
        }, delayMillis);
      }
    }
  }

  private void flushPendingCov()
  {
    List<Object> changes;
    int sourceEvents;
    synchronized (covLock)
    {
      if (pendingCov.isEmpty())
      {
        covFlushFuture = null;
        pendingCovEventCount = 0;
        return;
      }
      changes = new ArrayList<Object>(pendingCov.values());
      pendingCov.clear();
      sourceEvents = pendingCovEventCount;
      pendingCovEventCount = 0;
      covFlushFuture = null;
    }
    sendCov(changes, true, sourceEvents);
  }

  private void sendCov(List<Object> changes, boolean batched, int sourceEvents)
  {
    if (changes == null || changes.isEmpty())
    {
      return;
    }
    Map<String, Object> cov = baseMessage("cov", null);
    cov.put("sequence", Long.valueOf(++covSequence));
    cov.put("timestamp", Long.valueOf(Clock.millis()));
    cov.put("batched", Boolean.valueOf(batched));
    cov.put("sourceEvents", Long.valueOf(sourceEvents));
    cov.put("points", changes);
    send(cov);
  }

  private String pointKey(Object change)
  {
    if (!(change instanceof Map))
    {
      return null;
    }
    Object point = ((Map<?, ?>) change).get("point");
    return point instanceof String ? (String) point : null;
  }

  private int getPendingCovPointCount()
  {
    synchronized (covLock)
    {
      return pendingCov.size();
    }
  }

  private int getPendingCovEventCount()
  {
    synchronized (covLock)
    {
      return pendingCovEventCount;
    }
  }

  private String normalizeGroupName(String group) throws BaskStreamProtocolException
  {
    if (group == null || group.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'group' is required.");
    }
    String normalized = group.trim();
    if (normalized.length() > MAX_GROUP_NAME_LENGTH)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'group' must be " + MAX_GROUP_NAME_LENGTH + " characters or fewer.");
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
    if (leaseSec > MAX_LEASE_SEC)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'leaseSec' cannot exceed " + MAX_LEASE_SEC + ".");
    }
    return leaseSec;
  }

  private void sweepExpiredSubscriptionGroups()
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
    cancelScheduled(leaseSweepFuture);
    leaseSweepFuture = null;
    if (closed.get())
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
    if (next == Long.MAX_VALUE)
    {
      return;
    }

    leaseSweepFuture = runtime.schedule(new Runnable()
    {
      @Override
      public void run()
      {
        sweepExpiredSubscriptionGroups();
      }
    }, Math.max(100L, next - now));
  }

  /**
   * Begin the periodic session revalidation sweep. Authentication is established once at the
   * WebSocket handshake, but the socket is long-lived; this re-checks that the connected user
   * is still valid and that every active subscription is still readable for that user, tearing
   * down or trimming as needed. Controlled by the service {@code revalidateIntervalSec} property
   * (0 disables).
   */
  void start()
  {
    scheduleRevalidation();
  }

  private void scheduleRevalidation()
  {
    if (closed.get())
    {
      return;
    }
    int intervalSec = runtime.getService().getRevalidateIntervalSecValue();
    if (intervalSec <= 0)
    {
      return;
    }
    synchronized (subscriptionLock)
    {
      cancelScheduled(revalidateFuture);
      revalidateFuture = runtime.schedule(new Runnable()
      {
        @Override
        public void run()
        {
          try
          {
            // Hop onto the per-session worker so component-space access stays single-threaded
            // and serialized with frame processing, matching the rest of the session.
            worker.execute(new Runnable()
            {
              @Override
              public void run()
              {
                revalidate();
              }
            });
          }
          catch (RejectedExecutionException ignored)
          {
            // Worker already shut down (session closing) — nothing to revalidate.
          }
        }
      }, intervalSec * 1000L);
    }
  }

  private void revalidate()
  {
    if (closed.get())
    {
      return;
    }
    try
    {
      if (userMountedAtStart && !user.isMounted())
      {
        teardown("Authenticated user is no longer present in the station.");
        return;
      }

      Set<String> subscribed = new LinkedHashSet<String>(directSubscriptions);
      synchronized (subscriptionLock)
      {
        for (SubscriptionGroup group : subscriptionGroups.values())
        {
          subscribed.addAll(group.points);
        }
      }

      List<String> revoked = new ArrayList<String>();
      for (String pointOrd : subscribed)
      {
        if (!stillAuthorized(pointOrd))
        {
          revoked.add(pointOrd);
        }
      }

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
        Map<String, Object> notice = baseMessage("subscriptions_revoked", null);
        notice.put("points", revoked);
        notice.put("reason", "authorization_revoked");
        send(notice);
        runtime.onSubscriptionCountChanged();
        runtime.getService().audit("subscriptions_revoked", "user=" + user.getUsername()
          + " session=" + sessionId + " count=" + revoked.size());
      }
    }
    catch (Throwable e)
    {
      runtime.getService().LOG.log(Level.WARNING, "baskStream revalidation failed for session " + sessionId, e);
    }
    finally
    {
      scheduleRevalidation();
    }
  }

  private boolean stillAuthorized(String pointOrd)
  {
    // The path policy may have been narrowed mid-session — re-check it explicitly.
    if (!BaskStreamAccessPolicy.isAllowed(runtime.getService(), pointOrd))
    {
      return false;
    }
    try
    {
      OrdTarget target = BOrd.make(pointOrd).resolve(runtime.getService(), context);
      return target.canRead();
    }
    catch (Exception e)
    {
      // A transient resolution failure (e.g. a point momentarily unmounted) is not a
      // permission revocation; keep the subscription rather than dropping it on a glitch.
      return true;
    }
  }

  private void teardown(String reason)
  {
    runtime.getService().audit("session_revoked", "user=" + user.getUsername() + " session=" + sessionId
      + " reason=" + reason);
    Map<String, Object> notice = baseMessage("session_revoked", null);
    notice.put("reason", reason);
    send(notice);
    connection.closeTransport(1008, "session revoked");
    close(reason);
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

  private void cancelScheduled(ScheduledFuture<?> future)
  {
    if (future != null)
    {
      future.cancel(false);
    }
  }

  private List<String> optionalStringList(Map<String, Object> request, String key) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null)
    {
      return null;
    }
    if (!(value instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of strings.");
    }
    List<?> raw = (List<?>) value;
    List<String> out = new ArrayList<String>(raw.size());
    for (Object entry : raw)
    {
      if (!(entry instanceof String))
      {
        throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of strings.");
      }
      out.add((String) entry);
    }
    return out;
  }

  private Boolean optionalBoolean(Map<String, Object> request, String key) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null)
    {
      return null;
    }
    if (value instanceof Boolean)
    {
      return (Boolean) value;
    }
    throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be a boolean.");
  }

  private List<Object> listOf(Object... values)
  {
    List<Object> out = new ArrayList<Object>(values.length);
    for (int i = 0; i < values.length; i++)
    {
      out.add(values[i]);
    }
    return out;
  }

  private void sendPong(String id)
  {
    Map<String, Object> pong = baseMessage("pong", id);
    send(pong);
  }

  private void sendError(String id, String code, String message)
  {
    Map<String, Object> error = baseMessage("error", id);
    error.put("code", code);
    error.put("message", message);
    send(error);
  }

  private synchronized void send(Map<String, Object> message)
  {
    if (closed.get())
    {
      return;
    }

    try
    {
      connection.send(runtime.getCodec().encodeMessage(message));
    }
    catch (IOException e)
    {
      runtime.getService().LOG.log(Level.WARNING, "Failed to write baskStream websocket frame", e);
      close(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private Map<String, Object> baseMessage(String op, String id)
  {
    Map<String, Object> message = new LinkedHashMap<String, Object>();
    message.put("op", op);
    if (id != null)
    {
      message.put("id", id);
    }
    return message;
  }

  private Map<String, Object> errorEntry(String pointOrd, String code, String message)
  {
    Map<String, Object> error = new LinkedHashMap<String, Object>();
    error.put("point", pointOrd);
    error.put("ok", Boolean.FALSE);
    error.put("code", code);
    error.put("message", message);
    return error;
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
