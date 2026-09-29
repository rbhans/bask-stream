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
  static final int MAX_GROUP_NAME_LENGTH = 128;
  static final int MAX_LEASE_SEC = 86400;
  static final int MAX_POINTS_PER_REQUEST = 1000;
  // Replies above this size are replaced by a response_too_large error instead of risking the
  // transport's 16 MiB queue limit, which would close the whole session.
  private static final int MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;
  // Queued event tasks per session before the backlog is dropped for a resync notice.
  private static final int MAX_QUEUED_EVENTS = 1000;
  // A request running longer than this closes the session (see checkWatchdog).
  static final long REQUEST_TIMEOUT_MILLIS = 10L * 60L * 1000L;

  final BaskStreamWebSocketRuntime runtime;
  private final BaskStreamTransport connection;
  final BUser user;
  final Context context;
  final String sessionId;
  // Baseline mounted state of the authenticated principal. If the principal is a live station
  // component it is mounted here and a later unmount means the user was removed (tear down). If
  // the handshake hands back a detached copy (never mounted), this stays false and we never use
  // the unmount signal — avoiding a false mass-disconnect on every session.
  private final boolean userMountedAtStart;
  private final BaskStreamAlarmStream alarms;
  private final BaskStreamModelStream models;
  final AtomicBoolean closed = new AtomicBoolean(false);
  final ExecutorService worker;
  final BaskStreamPointSubscriptions points;
  final BaskStreamCovBatcher cov;
  private final BaskStreamRequests requests;
  private final BaskStreamCapabilities capabilities;
  private final Object timerLock = new Object();
  final BaskStreamEventLane events;
  final BaskStreamAuthorizer authorizer;
  private volatile long requestStartedAt;
  private volatile String requestOp;
  private ScheduledFuture<?> revalidateFuture;
  private final Map<String, RequestHandler> handlers = bindHandlers();

  BaskStreamClientSession(BaskStreamWebSocketRuntime runtime, BaskStreamTransport connection, BUser user, Context context)
  {
    this.runtime = runtime;
    this.connection = connection;
    this.user = user;
    this.context = context;
    this.userMountedAtStart = user.isMounted();
    this.sessionId = UUID.randomUUID().toString();
    this.authorizer = new BaskStreamAuthorizer(runtime.getService());
    this.events = new BaskStreamEventLane(runtime.getEventPool(), MAX_QUEUED_EVENTS,
        dropped -> () -> sendResync(dropped), runtime.getService().LOG);
    this.worker = new java.util.concurrent.ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        new java.util.concurrent.ArrayBlockingQueue<Runnable>(32), new ThreadFactory()
    {
      @Override
      public Thread newThread(Runnable r)
      {
        Thread t = new Thread(r, "baskStream-session-" + sessionId);
        t.setDaemon(true);
        return t;
      }
    })
    {
      @Override
      protected void terminated()
      {
        // Runs once the worker has really stopped, so a request that was still subscribing
        // when the session closed cannot leave Niagara subscriptions behind.
        releaseSubscriptions();
      }
    };
    this.points = new BaskStreamPointSubscriptions(this);
    this.cov = new BaskStreamCovBatcher(this, points.subscriptions);
    this.requests = new BaskStreamRequests(this);
    this.capabilities = new BaskStreamCapabilities(this);
    this.alarms = new BaskStreamAlarmStream(this);
    this.models = new BaskStreamModelStream(this);
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
    return points.count() + alarms.count() + models.count();
  }

  int getPointSubscriptionCount()
  {
    return points.count();
  }

  int getAlarmSubscriptionCount()
  {
    return alarms.count();
  }

  int getModelSubscriptionCount()
  {
    return models.count();
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
      if (!closed.get())
      {
        connection.closeTransport(1013, "Request queue limit reached.");
        close("request queue limit");
      }
    }
  }

  private interface RequestHandler
  {
    void handle(String id, String op, Map<String, Object> request) throws Exception;
  }

  /**
   * Binds every operation in {@link BaskStreamOperations} to its handler. Gates are not
   * applied here: dispatch reads them from the operation table.
   */
  private Map<String, RequestHandler> bindHandlers()
  {
    Map<String, RequestHandler> bound = new java.util.HashMap<String, RequestHandler>();
    bound.put("ping", (id, op, request) -> sendPong(id));
    bound.put("capabilities", (id, op, request) -> capabilities.handleCapabilities(id));
    bound.put("browse", (id, op, request) -> requests.handleBrowse(id, request));
    bound.put("describe", (id, op, request) -> requests.handleDescribe(id, request));
    bound.put("search", (id, op, request) -> requests.handleSearch(id, request));
    bound.put("read", (id, op, request) -> requests.handleRead(id, request));
    bound.put("subscribe", (id, op, request) -> points.handleSubscribe(id, request));
    bound.put("unsubscribe", (id, op, request) -> points.handleUnsubscribe(request));
    bound.put("replace_subscriptions", (id, op, request) -> points.handleReplaceSubscriptions(id, request));
    bound.put("renew_subscriptions", (id, op, request) -> points.handleRenewSubscriptions(id, request));
    bound.put("release_subscriptions", (id, op, request) -> points.handleReleaseSubscriptions(id, request));
    bound.put("subscription_status", (id, op, request) -> points.handleSubscriptionStatus(id, request));
    bound.put("write", (id, op, request) -> requests.handleWrite(id, request));
    bound.put("describe_write", (id, op, request) -> requests.handleDescribeWrite(id, request));
    bound.put("read_history", (id, op, request) -> requests.handleReadHistory(id, request));
    bound.put("describe_history", (id, op, request) -> requests.handleDescribeHistory(id, request));
    bound.put("read_history_rollup", (id, op, request) -> requests.handleReadHistoryRollup(id, request));
    bound.put("read_alarms", (id, op, request) -> requests.handleReadAlarms(id, request));
    bound.put("ack_alarm", (id, op, request) -> requests.handleAckAlarms(id, request));
    bound.put("ack_alarms", (id, op, request) -> requests.handleAckAlarms(id, request));
    bound.put("clear_alarm", (id, op, request) -> requests.handleClearAlarms(id, request));
    bound.put("clear_alarms", (id, op, request) -> requests.handleClearAlarms(id, request));
    bound.put("subscribe_alarms", (id, op, request) -> alarms.handleSubscribeAlarms(id, request));
    bound.put("unsubscribe_alarms", (id, op, request) -> alarms.handleUnsubscribeAlarms(id, request));
    bound.put("read_schedule", (id, op, request) -> requests.handleReadSchedule(id, request));
    bound.put("read_schedule_events", (id, op, request) -> requests.handleReadScheduleEvents(id, request));
    bound.put("write_schedule", (id, op, request) -> requests.handleWriteSchedule(id, request));
    bound.put("subscribe_model", (id, op, request) -> models.handleSubscribeModel(id, request));
    bound.put("unsubscribe_model", (id, op, request) -> models.handleUnsubscribeModel(id, request));
    bound.put("read_tags", (id, op, request) -> requests.handleReadTags(id, request));
    bound.put("write_tags", (id, op, request) -> requests.handleWriteTags(id, request));
    bound.put("write_relations", (id, op, request) -> requests.handleWriteRelations(id, request));
    for (String model : new String[] {
        "describe_component_types", "describe_component", "preview_model_changes", "apply_model_changes",
        "model_plan_status", "cancel_model_plan", "create_components", "update_component_properties",
        "rename_component", "move_components", "delete_components", "create_hierarchy", "configure_hierarchy" })
    {
      bound.put(model, (id, op, request) -> requests.handleModelOperation(id, op, request));
    }

    if (!bound.keySet().equals(new java.util.HashSet<String>(BaskStreamOperations.names())))
    {
      throw new IllegalStateException("baskStream handlers do not match the operation table: handlers="
          + new java.util.TreeSet<String>(bound.keySet()) + " operations=" + BaskStreamOperations.names());
    }
    return bound;
  }

  private void processFrame(byte[] payload)
  {
    if (closed.get())
    {
      return;
    }
    points.sweepExpiredSubscriptionGroups();

    String id = null;
    try
    {
      Map<String, Object> request = runtime.getCodec().decodeMessage(payload, runtime.getService().getMaxMessageBytesValue());
      String op = runtime.getCodec().requireString(request, "op");
      id = runtime.getCodec().optionalString(request, "id");
      requestOp = op;
      requestStartedAt = System.currentTimeMillis();
      runtime.getMetrics().requests.incrementAndGet();

      BaskStreamOperations.Operation operation = BaskStreamOperations.get(op);
      RequestHandler handler = operation == null ? null : handlers.get(op);
      if (handler == null)
      {
        sendError(id, "unsupported_op", "Unsupported operation: " + op);
        return;
      }
      if (operation.gate != BaskStreamOperations.Gate.NONE)
      {
        runtime.getMetrics().writeRequests.incrementAndGet();
      }
      if (operation.gate == BaskStreamOperations.Gate.WRITES)
      {
        runtime.getService().requireWritesEnabled();
      }
      else if (operation.gate == BaskStreamOperations.Gate.MODEL_EDITS)
      {
        runtime.getService().requireModelEditsEnabled();
      }
      handler.handle(id, op, request);
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
    finally
    {
      requestStartedAt = 0L;
    }
  }

  /**
   * Called periodically from the runtime. A request that has run longer than
   * REQUEST_TIMEOUT_MILLIS closes the session, so a stuck request cannot silently freeze a
   * client. Java cannot stop a thread that ignores interrupts; the close at least frees the
   * client and interrupts waits and batches.
   */
  void checkWatchdog(long now)
  {
    long started = requestStartedAt;
    if (started == 0L || closed.get() || now - started < REQUEST_TIMEOUT_MILLIS)
    {
      return;
    }
    String op = requestOp;
    runtime.getMetrics().requestTimeouts.incrementAndGet();
    runtime.getService().audit("request_timeout", "user=" + user.getUsername() + " session=" + sessionId
        + " op=" + op + " elapsedMillis=" + (now - started));
    Map<String, Object> notice = baseMessage("request_timeout", null);
    notice.put("requestOp", op);
    notice.put("elapsedMillis", Long.valueOf(now - started));
    send(notice);
    connection.closeTransport(1011, "Request exceeded the time limit.");
    close("request timeout");
  }

  void close(String reason)
  {
    if (!closed.compareAndSet(false, true))
    {
      return;
    }

    // Never wait here. close() can run on Niagara event threads, the shared scheduler, or
    // Jetty threads, sometimes while holding this session's send lock. Waiting for the worker
    // would stall those threads for every client.
    try
    {
      connection.closeTransport(1000, "Session closed.");
      events.close();
      cov.close();
      // Drop queued requests and interrupt settle waits. The executor's terminated() hook
      // releases subscriptions once the running request, if any, has finished.
      worker.shutdownNow();
    }
    finally
    {
      // Connection accounting must never leak even if a cleanup operation fails. Without
      // this guarantee, ordinary short-lived clients can permanently exhaust maxConnections.
      runtime.onClose(this);
      runtime.getService().audit("disconnect", "user=" + user.getUsername() + " session=" + sessionId + " reason=" + reason);
    }
  }

  private void releaseSubscriptions()
  {
    try
    {
      synchronized (timerLock)
      {
        cancelScheduled(revalidateFuture);
        revalidateFuture = null;
      }
      points.release();
      alarms.release();
      models.release();
      runtime.onSubscriptionCountChanged();
    }
    catch (RuntimeException e)
    {
      // This can run on whichever thread stops the executor; never let cleanup fail its caller.
      runtime.getService().LOG.log(Level.WARNING, "baskStream subscription cleanup failed for session " + sessionId, e);
    }
  }

  void requireMaxSize(List<?> values, String key, int max) throws BaskStreamProtocolException
  {
    if (values != null && values.size() > max)
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' cannot contain more than " + max + " entries.");
    }
  }

  /** The runtime's post-apply fan-out; the model stream matches and queues the notice. */
  void modelChanged(Set<String> affected)
  {
    models.modelChanged(affected);
  }

  /** Sent after the event lane dropped a backlog: the client should re-read what it shows. */
  private void sendResync(int dropped)
  {
    runtime.getMetrics().resyncs.incrementAndGet();
    Map<String, Object> notice = baseMessage("resync_required", null);
    notice.put("reason", "event_backlog");
    notice.put("droppedEvents", Long.valueOf(dropped));
    notice.put("timestamp", Long.valueOf(Clock.millis()));
    send(notice);
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
    synchronized (timerLock)
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

      List<String> revoked = points.revalidate();
      List<String> revokedAlarms = alarms.revalidate();

      List<String> revokedModels = models.revalidate();

      if (!revoked.isEmpty() || !revokedAlarms.isEmpty() || !revokedModels.isEmpty())
      {
        Map<String, Object> notice = baseMessage("subscriptions_revoked", null);
        notice.put("points", revoked);
        notice.put("alarmSubscriptions", revokedAlarms);
        notice.put("modelSubscriptions", revokedModels);
        notice.put("reason", "authorization_revoked");
        send(notice);
        runtime.onSubscriptionCountChanged();
        runtime.getService().audit("subscriptions_revoked", "user=" + user.getUsername()
          + " session=" + sessionId + " points=" + revoked.size() + " alarms=" + revokedAlarms.size()
          + " models=" + revokedModels.size());
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

  void cancelScheduled(ScheduledFuture<?> future)
  {
    if (future != null)
    {
      future.cancel(false);
    }
  }

  List<String> optionalStringList(Map<String, Object> request, String key) throws BaskStreamProtocolException
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

  Boolean optionalBoolean(Map<String, Object> request, String key) throws BaskStreamProtocolException
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

  List<Object> listOf(Object... values)
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

  void sendError(String id, String code, String message)
  {
    runtime.getMetrics().errors.incrementAndGet();
    Map<String, Object> error = baseMessage("error", id);
    error.put("code", code);
    error.put("message", message);
    send(error);
  }

  synchronized void send(Map<String, Object> message)
  {
    if (closed.get())
    {
      return;
    }

    try
    {
      byte[] frame = runtime.getCodec().encodeMessage(message);
      if (frame.length > MAX_OUTBOUND_BYTES)
      {
        Object id = message.get("id");
        Map<String, Object> error = baseMessage("error", id instanceof String ? (String) id : null);
        error.put("code", "response_too_large");
        error.put("message", "The '" + message.get("op") + "' reply would be " + frame.length + " bytes, over the "
            + MAX_OUTBOUND_BYTES + "-byte limit. Request less: a smaller depth, limit, time range or field list.");
        frame = runtime.getCodec().encodeMessage(error);
      }
      connection.send(frame);
    }
    catch (IOException e)
    {
      runtime.getService().LOG.log(Level.WARNING, "Failed to write baskStream websocket frame", e);
      close(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  Map<String, Object> baseMessage(String op, String id)
  {
    Map<String, Object> message = new LinkedHashMap<String, Object>();
    message.put("op", op);
    if (id != null)
    {
      message.put("id", id);
    }
    return message;
  }

  Map<String, Object> errorEntry(String pointOrd, String code, String message)
  {
    Map<String, Object> error = new LinkedHashMap<String, Object>();
    error.put("point", pointOrd);
    error.put("ok", Boolean.FALSE);
    error.put("code", code);
    error.put("message", message);
    return error;
  }

}
