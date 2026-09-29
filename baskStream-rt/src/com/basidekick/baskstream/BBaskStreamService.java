package com.basidekick.baskstream;

import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.baja.nre.annotations.NiagaraProperty;
import javax.baja.nre.annotations.NiagaraType;
import javax.baja.sys.BRelTime;
import javax.baja.sys.Flags;
import javax.baja.sys.Property;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;
import javax.baja.web.BWebServlet;
import javax.baja.web.WebOp;

@NiagaraType
@NiagaraProperty(
  name = "writesEnabled",
  type = "boolean",
  defaultValue = "true",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "modelEditsEnabled",
  type = "boolean",
  defaultValue = "false",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "wsPath",
  type = "baja:String",
  defaultValue = "/stream",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "maxConnections",
  type = "int",
  defaultValue = "10",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "maxConnectionsPerUser",
  type = "int",
  defaultValue = "0",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "maxMessageBytes",
  type = "int",
  defaultValue = "1048576",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "maxSubscriptionsPerClient",
  type = "int",
  defaultValue = "500",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "maxPointSnapshotPoints",
  type = "int",
  defaultValue = "1000",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "heartbeatIntervalSec",
  type = "int",
  defaultValue = "30",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "subscriptionLeaseSec",
  type = "int",
  defaultValue = "300",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "covBatchWindowMillis",
  type = "int",
  defaultValue = "100",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "writeSettleMillis",
  type = "int",
  defaultValue = "150",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "allowedPathPatterns",
  type = "baja:String",
  defaultValue = "slot:/*",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "allowedOrigins",
  type = "baja:String",
  defaultValue = "",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "requireAuthorizationHeader",
  type = "boolean",
  defaultValue = "false",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "rejectMissingOrigin",
  type = "boolean",
  defaultValue = "false",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "revalidateIntervalSec",
  type = "int",
  defaultValue = "0",
  flags = Flags.SUMMARY
)
@NiagaraProperty(
  name = "activeConnections",
  type = "int",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "totalSubscriptions",
  type = "int",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "requestCount",
  type = "long",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "errorCount",
  type = "long",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "writeRequestCount",
  type = "long",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "resyncCount",
  type = "long",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
@NiagaraProperty(
  name = "requestTimeoutCount",
  type = "long",
  defaultValue = "0",
  flags = Flags.READONLY | Flags.TRANSIENT
)
public final class BBaskStreamService extends BWebServlet
{
  public static final Logger LOG = Logger.getLogger(BBaskStreamService.class.getName());
  private static final AtomicReference<BBaskStreamService> ACTIVE = new AtomicReference<BBaskStreamService>();
  private volatile BaskStreamWebSocketRuntime runtime;

  public BBaskStreamService()
  {
    ensureServletNameDefault();
  }

//region /*+ ------------ BEGIN BAJA AUTO GENERATED CODE ------------ +*/
//@formatter:off
/*@ $com.basidekick.baskstream.BBaskStreamService(3979930858)1.0$ @*/
/* Generated Mon Sep 28 21:50:08 MST 2026 by Slot-o-Matic (c) Tridium, Inc. 2012-2026 */

  //region Property "writesEnabled"

  /**
   * Slot for the {@code writesEnabled} property.
   * @see #getWritesEnabled
   * @see #setWritesEnabled
   */
  public static final Property writesEnabled = newProperty(Flags.SUMMARY, true, null);

  /**
   * Get the {@code writesEnabled} property.
   * @see #writesEnabled
   */
  public boolean getWritesEnabled() { return getBoolean(writesEnabled); }

  /**
   * Set the {@code writesEnabled} property.
   * @see #writesEnabled
   */
  public void setWritesEnabled(boolean v) { setBoolean(writesEnabled, v, null); }

  //endregion Property "writesEnabled"

  //region Property "modelEditsEnabled"

  /**
   * Slot for the {@code modelEditsEnabled} property.
   * @see #getModelEditsEnabled
   * @see #setModelEditsEnabled
   */
  public static final Property modelEditsEnabled = newProperty(Flags.SUMMARY, false, null);

  /**
   * Get the {@code modelEditsEnabled} property.
   * @see #modelEditsEnabled
   */
  public boolean getModelEditsEnabled() { return getBoolean(modelEditsEnabled); }

  /**
   * Set the {@code modelEditsEnabled} property.
   * @see #modelEditsEnabled
   */
  public void setModelEditsEnabled(boolean v) { setBoolean(modelEditsEnabled, v, null); }

  //endregion Property "modelEditsEnabled"

  //region Property "wsPath"

  /**
   * Slot for the {@code wsPath} property.
   * @see #getWsPath
   * @see #setWsPath
   */
  public static final Property wsPath = newProperty(Flags.SUMMARY, "/stream", null);

  /**
   * Get the {@code wsPath} property.
   * @see #wsPath
   */
  public String getWsPath() { return getString(wsPath); }

  /**
   * Set the {@code wsPath} property.
   * @see #wsPath
   */
  public void setWsPath(String v) { setString(wsPath, v, null); }

  //endregion Property "wsPath"

  //region Property "maxConnections"

  /**
   * Slot for the {@code maxConnections} property.
   * @see #getMaxConnections
   * @see #setMaxConnections
   */
  public static final Property maxConnections = newProperty(Flags.SUMMARY, 10, null);

  /**
   * Get the {@code maxConnections} property.
   * @see #maxConnections
   */
  public int getMaxConnections() { return getInt(maxConnections); }

  /**
   * Set the {@code maxConnections} property.
   * @see #maxConnections
   */
  public void setMaxConnections(int v) { setInt(maxConnections, v, null); }

  //endregion Property "maxConnections"

  //region Property "maxConnectionsPerUser"

  /**
   * Slot for the {@code maxConnectionsPerUser} property.
   * @see #getMaxConnectionsPerUser
   * @see #setMaxConnectionsPerUser
   */
  public static final Property maxConnectionsPerUser = newProperty(Flags.SUMMARY, 0, null);

  /**
   * Get the {@code maxConnectionsPerUser} property.
   * @see #maxConnectionsPerUser
   */
  public int getMaxConnectionsPerUser() { return getInt(maxConnectionsPerUser); }

  /**
   * Set the {@code maxConnectionsPerUser} property.
   * @see #maxConnectionsPerUser
   */
  public void setMaxConnectionsPerUser(int v) { setInt(maxConnectionsPerUser, v, null); }

  //endregion Property "maxConnectionsPerUser"

  //region Property "maxMessageBytes"

  /**
   * Slot for the {@code maxMessageBytes} property.
   * @see #getMaxMessageBytes
   * @see #setMaxMessageBytes
   */
  public static final Property maxMessageBytes = newProperty(Flags.SUMMARY, 1048576, null);

  /**
   * Get the {@code maxMessageBytes} property.
   * @see #maxMessageBytes
   */
  public int getMaxMessageBytes() { return getInt(maxMessageBytes); }

  /**
   * Set the {@code maxMessageBytes} property.
   * @see #maxMessageBytes
   */
  public void setMaxMessageBytes(int v) { setInt(maxMessageBytes, v, null); }

  //endregion Property "maxMessageBytes"

  //region Property "maxSubscriptionsPerClient"

  /**
   * Slot for the {@code maxSubscriptionsPerClient} property.
   * @see #getMaxSubscriptionsPerClient
   * @see #setMaxSubscriptionsPerClient
   */
  public static final Property maxSubscriptionsPerClient = newProperty(Flags.SUMMARY, 500, null);

  /**
   * Get the {@code maxSubscriptionsPerClient} property.
   * @see #maxSubscriptionsPerClient
   */
  public int getMaxSubscriptionsPerClient() { return getInt(maxSubscriptionsPerClient); }

  /**
   * Set the {@code maxSubscriptionsPerClient} property.
   * @see #maxSubscriptionsPerClient
   */
  public void setMaxSubscriptionsPerClient(int v) { setInt(maxSubscriptionsPerClient, v, null); }

  //endregion Property "maxSubscriptionsPerClient"

  //region Property "maxPointSnapshotPoints"

  /**
   * Slot for the {@code maxPointSnapshotPoints} property.
   * @see #getMaxPointSnapshotPoints
   * @see #setMaxPointSnapshotPoints
   */
  public static final Property maxPointSnapshotPoints = newProperty(Flags.SUMMARY, 1000, null);

  /**
   * Get the {@code maxPointSnapshotPoints} property.
   * @see #maxPointSnapshotPoints
   */
  public int getMaxPointSnapshotPoints() { return getInt(maxPointSnapshotPoints); }

  /**
   * Set the {@code maxPointSnapshotPoints} property.
   * @see #maxPointSnapshotPoints
   */
  public void setMaxPointSnapshotPoints(int v) { setInt(maxPointSnapshotPoints, v, null); }

  //endregion Property "maxPointSnapshotPoints"

  //region Property "heartbeatIntervalSec"

  /**
   * Slot for the {@code heartbeatIntervalSec} property.
   * @see #getHeartbeatIntervalSec
   * @see #setHeartbeatIntervalSec
   */
  public static final Property heartbeatIntervalSec = newProperty(Flags.SUMMARY, 30, null);

  /**
   * Get the {@code heartbeatIntervalSec} property.
   * @see #heartbeatIntervalSec
   */
  public int getHeartbeatIntervalSec() { return getInt(heartbeatIntervalSec); }

  /**
   * Set the {@code heartbeatIntervalSec} property.
   * @see #heartbeatIntervalSec
   */
  public void setHeartbeatIntervalSec(int v) { setInt(heartbeatIntervalSec, v, null); }

  //endregion Property "heartbeatIntervalSec"

  //region Property "subscriptionLeaseSec"

  /**
   * Slot for the {@code subscriptionLeaseSec} property.
   * @see #getSubscriptionLeaseSec
   * @see #setSubscriptionLeaseSec
   */
  public static final Property subscriptionLeaseSec = newProperty(Flags.SUMMARY, 300, null);

  /**
   * Get the {@code subscriptionLeaseSec} property.
   * @see #subscriptionLeaseSec
   */
  public int getSubscriptionLeaseSec() { return getInt(subscriptionLeaseSec); }

  /**
   * Set the {@code subscriptionLeaseSec} property.
   * @see #subscriptionLeaseSec
   */
  public void setSubscriptionLeaseSec(int v) { setInt(subscriptionLeaseSec, v, null); }

  //endregion Property "subscriptionLeaseSec"

  //region Property "covBatchWindowMillis"

  /**
   * Slot for the {@code covBatchWindowMillis} property.
   * @see #getCovBatchWindowMillis
   * @see #setCovBatchWindowMillis
   */
  public static final Property covBatchWindowMillis = newProperty(Flags.SUMMARY, 100, null);

  /**
   * Get the {@code covBatchWindowMillis} property.
   * @see #covBatchWindowMillis
   */
  public int getCovBatchWindowMillis() { return getInt(covBatchWindowMillis); }

  /**
   * Set the {@code covBatchWindowMillis} property.
   * @see #covBatchWindowMillis
   */
  public void setCovBatchWindowMillis(int v) { setInt(covBatchWindowMillis, v, null); }

  //endregion Property "covBatchWindowMillis"

  //region Property "writeSettleMillis"

  /**
   * Slot for the {@code writeSettleMillis} property.
   * @see #getWriteSettleMillis
   * @see #setWriteSettleMillis
   */
  public static final Property writeSettleMillis = newProperty(Flags.SUMMARY, 150, null);

  /**
   * Get the {@code writeSettleMillis} property.
   * @see #writeSettleMillis
   */
  public int getWriteSettleMillis() { return getInt(writeSettleMillis); }

  /**
   * Set the {@code writeSettleMillis} property.
   * @see #writeSettleMillis
   */
  public void setWriteSettleMillis(int v) { setInt(writeSettleMillis, v, null); }

  //endregion Property "writeSettleMillis"

  //region Property "allowedPathPatterns"

  /**
   * Slot for the {@code allowedPathPatterns} property.
   * @see #getAllowedPathPatterns
   * @see #setAllowedPathPatterns
   */
  public static final Property allowedPathPatterns = newProperty(Flags.SUMMARY, "slot:/*", null);

  /**
   * Get the {@code allowedPathPatterns} property.
   * @see #allowedPathPatterns
   */
  public String getAllowedPathPatterns() { return getString(allowedPathPatterns); }

  /**
   * Set the {@code allowedPathPatterns} property.
   * @see #allowedPathPatterns
   */
  public void setAllowedPathPatterns(String v) { setString(allowedPathPatterns, v, null); }

  //endregion Property "allowedPathPatterns"

  //region Property "allowedOrigins"

  /**
   * Slot for the {@code allowedOrigins} property.
   * @see #getAllowedOrigins
   * @see #setAllowedOrigins
   */
  public static final Property allowedOrigins = newProperty(Flags.SUMMARY, "", null);

  /**
   * Get the {@code allowedOrigins} property.
   * @see #allowedOrigins
   */
  public String getAllowedOrigins() { return getString(allowedOrigins); }

  /**
   * Set the {@code allowedOrigins} property.
   * @see #allowedOrigins
   */
  public void setAllowedOrigins(String v) { setString(allowedOrigins, v, null); }

  //endregion Property "allowedOrigins"

  //region Property "requireAuthorizationHeader"

  /**
   * Slot for the {@code requireAuthorizationHeader} property.
   * @see #getRequireAuthorizationHeader
   * @see #setRequireAuthorizationHeader
   */
  public static final Property requireAuthorizationHeader = newProperty(Flags.SUMMARY, false, null);

  /**
   * Get the {@code requireAuthorizationHeader} property.
   * @see #requireAuthorizationHeader
   */
  public boolean getRequireAuthorizationHeader() { return getBoolean(requireAuthorizationHeader); }

  /**
   * Set the {@code requireAuthorizationHeader} property.
   * @see #requireAuthorizationHeader
   */
  public void setRequireAuthorizationHeader(boolean v) { setBoolean(requireAuthorizationHeader, v, null); }

  //endregion Property "requireAuthorizationHeader"

  //region Property "rejectMissingOrigin"

  /**
   * Slot for the {@code rejectMissingOrigin} property.
   * @see #getRejectMissingOrigin
   * @see #setRejectMissingOrigin
   */
  public static final Property rejectMissingOrigin = newProperty(Flags.SUMMARY, false, null);

  /**
   * Get the {@code rejectMissingOrigin} property.
   * @see #rejectMissingOrigin
   */
  public boolean getRejectMissingOrigin() { return getBoolean(rejectMissingOrigin); }

  /**
   * Set the {@code rejectMissingOrigin} property.
   * @see #rejectMissingOrigin
   */
  public void setRejectMissingOrigin(boolean v) { setBoolean(rejectMissingOrigin, v, null); }

  //endregion Property "rejectMissingOrigin"

  //region Property "revalidateIntervalSec"

  /**
   * Slot for the {@code revalidateIntervalSec} property.
   * @see #getRevalidateIntervalSec
   * @see #setRevalidateIntervalSec
   */
  public static final Property revalidateIntervalSec = newProperty(Flags.SUMMARY, 0, null);

  /**
   * Get the {@code revalidateIntervalSec} property.
   * @see #revalidateIntervalSec
   */
  public int getRevalidateIntervalSec() { return getInt(revalidateIntervalSec); }

  /**
   * Set the {@code revalidateIntervalSec} property.
   * @see #revalidateIntervalSec
   */
  public void setRevalidateIntervalSec(int v) { setInt(revalidateIntervalSec, v, null); }

  //endregion Property "revalidateIntervalSec"

  //region Property "activeConnections"

  /**
   * Slot for the {@code activeConnections} property.
   * @see #getActiveConnections
   * @see #setActiveConnections
   */
  public static final Property activeConnections = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code activeConnections} property.
   * @see #activeConnections
   */
  public int getActiveConnections() { return getInt(activeConnections); }

  /**
   * Set the {@code activeConnections} property.
   * @see #activeConnections
   */
  public void setActiveConnections(int v) { setInt(activeConnections, v, null); }

  //endregion Property "activeConnections"

  //region Property "totalSubscriptions"

  /**
   * Slot for the {@code totalSubscriptions} property.
   * @see #getTotalSubscriptions
   * @see #setTotalSubscriptions
   */
  public static final Property totalSubscriptions = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code totalSubscriptions} property.
   * @see #totalSubscriptions
   */
  public int getTotalSubscriptions() { return getInt(totalSubscriptions); }

  /**
   * Set the {@code totalSubscriptions} property.
   * @see #totalSubscriptions
   */
  public void setTotalSubscriptions(int v) { setInt(totalSubscriptions, v, null); }

  //endregion Property "totalSubscriptions"

  //region Property "requestCount"

  /**
   * Slot for the {@code requestCount} property.
   * @see #getRequestCount
   * @see #setRequestCount
   */
  public static final Property requestCount = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code requestCount} property.
   * @see #requestCount
   */
  public long getRequestCount() { return getLong(requestCount); }

  /**
   * Set the {@code requestCount} property.
   * @see #requestCount
   */
  public void setRequestCount(long v) { setLong(requestCount, v, null); }

  //endregion Property "requestCount"

  //region Property "errorCount"

  /**
   * Slot for the {@code errorCount} property.
   * @see #getErrorCount
   * @see #setErrorCount
   */
  public static final Property errorCount = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code errorCount} property.
   * @see #errorCount
   */
  public long getErrorCount() { return getLong(errorCount); }

  /**
   * Set the {@code errorCount} property.
   * @see #errorCount
   */
  public void setErrorCount(long v) { setLong(errorCount, v, null); }

  //endregion Property "errorCount"

  //region Property "writeRequestCount"

  /**
   * Slot for the {@code writeRequestCount} property.
   * @see #getWriteRequestCount
   * @see #setWriteRequestCount
   */
  public static final Property writeRequestCount = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code writeRequestCount} property.
   * @see #writeRequestCount
   */
  public long getWriteRequestCount() { return getLong(writeRequestCount); }

  /**
   * Set the {@code writeRequestCount} property.
   * @see #writeRequestCount
   */
  public void setWriteRequestCount(long v) { setLong(writeRequestCount, v, null); }

  //endregion Property "writeRequestCount"

  //region Property "resyncCount"

  /**
   * Slot for the {@code resyncCount} property.
   * @see #getResyncCount
   * @see #setResyncCount
   */
  public static final Property resyncCount = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code resyncCount} property.
   * @see #resyncCount
   */
  public long getResyncCount() { return getLong(resyncCount); }

  /**
   * Set the {@code resyncCount} property.
   * @see #resyncCount
   */
  public void setResyncCount(long v) { setLong(resyncCount, v, null); }

  //endregion Property "resyncCount"

  //region Property "requestTimeoutCount"

  /**
   * Slot for the {@code requestTimeoutCount} property.
   * @see #getRequestTimeoutCount
   * @see #setRequestTimeoutCount
   */
  public static final Property requestTimeoutCount = newProperty(Flags.READONLY | Flags.TRANSIENT, 0, null);

  /**
   * Get the {@code requestTimeoutCount} property.
   * @see #requestTimeoutCount
   */
  public long getRequestTimeoutCount() { return getLong(requestTimeoutCount); }

  /**
   * Set the {@code requestTimeoutCount} property.
   * @see #requestTimeoutCount
   */
  public void setRequestTimeoutCount(long v) { setLong(requestTimeoutCount, v, null); }

  //endregion Property "requestTimeoutCount"

  //region Type

  @Override
  public Type getType() { return TYPE; }
  public static final Type TYPE = Sys.loadType(BBaskStreamService.class);

  //endregion Type

//@formatter:on
//endregion /*+ ------------ END BAJA AUTO GENERATED CODE -------------- +*/

  public static BBaskStreamService getActiveService()
  {
    return ACTIVE.get();
  }

  // Slot-o-matic supplies the new property members at the user-owned build.
  // Keep the accessors distinct from generated getters.
  boolean writesAllowed()
  {
    Property p = getProperty("writesEnabled");
    return p != null && getBoolean(p);
  }

  boolean modelEditsAllowed()
  {
    Property p = getProperty("modelEditsEnabled");
    return writesAllowed() && p != null && getBoolean(p);
  }

  void requireWritesEnabled() throws BaskStreamProtocolException
  {
    if (!getEnabled() || !writesAllowed())
      throw new BaskStreamProtocolException("writes_disabled", "Station writes are disabled on BASkStreamService.");
    if (Thread.currentThread().isInterrupted())
      throw new BaskStreamProtocolException("write_cancelled", "Write was cancelled.");
  }

  void requireModelEditsEnabled() throws BaskStreamProtocolException
  {
    requireWritesEnabled();
    if (!modelEditsAllowed())
      throw new BaskStreamProtocolException("model_edits_disabled", "Enable modelEditsEnabled on BASkStreamService to apply model plans.");
  }

  @Override
  public void serviceStarted() throws Exception
  {
    ensureServletNameDefault();
    super.serviceStarted();
    ensureServletNameDefault();
    runtime = new BaskStreamWebSocketRuntime(this);
    ACTIVE.set(this);
    setRuntimeMetrics(0, 0);
    configOk();
  }

  @Override
  public void serviceStopped() throws Exception
  {
    if (ACTIVE.compareAndSet(this, null))
    {
      setRuntimeMetrics(0, 0);
    }
    BaskStreamWebSocketRuntime current = runtime;
    runtime = null;
    if (current != null)
    {
      current.stop();
    }
    super.serviceStopped();
  }

  @Override
  public void doGet(WebOp op) throws Exception
  {
    if (!getEnabled())
    {
      op.getResponse().sendError(503, "BASkStreamService is disabled.");
      return;
    }

    BaskStreamWebSocketRuntime current = runtime;
    if (current == null)
    {
      op.getResponse().sendError(503, "BASkStreamService is not running.");
      return;
    }

    String pathInfo = op.getPathInfo();
    if (pathInfo == null || pathInfo.length() == 0 || "/".equals(pathInfo))
    {
      if (isWebSocketUpgrade(op))
      {
        current.getTransport().handleUpgrade(op.getRequest(), op.getResponse());
        return;
      }

      op.getResponse().setStatus(426);
      op.setContentType("text/plain;charset=UTF-8");
      op.getWriter().write("Use an authenticated WebSocket upgrade request.");
      return;
    }

    if ("/health".equals(pathInfo))
    {
      writeHealth(op);
      return;
    }

    if ("/metrics".equals(pathInfo))
    {
      writeMetrics(op, current.getMetrics());
      return;
    }


    op.getResponse().sendError(404);
  }

  /**
   * Records a change in the station's audit history. Niagara audits component changes made with
   * a user Context by itself; this covers the APIs that take no Context (tags and relations).
   * Auditing never fails the change it describes.
   */
  void auditChange(String operation, javax.baja.sys.BComponent target, String slot, String oldValue, String newValue,
      javax.baja.sys.Context context)
  {
    try
    {
      javax.baja.security.Auditor auditor = Sys.getAuditor();
      if (auditor == null || target == null)
      {
        return;
      }
      String user = context == null || context.getUser() == null ? null : context.getUser().getUsername();
      String where = target.getSlotPath() == null ? target.getName() : target.getSlotPath().toString();
      auditor.audit(new javax.baja.security.AuditEvent(operation, where, slot, oldValue, newValue, user));
    }
    catch (RuntimeException e)
    {
      LOG.log(Level.WARNING, "baskStream could not record an audit event", e);
    }
  }

  /** Copies the runtime's traffic counters onto the read-only properties. */
  synchronized void setTrafficMetrics(BaskStreamMetrics metrics)
  {
    setLong(requestCount, metrics.requests.get(), null);
    setLong(errorCount, metrics.errors.get(), null);
    setLong(writeRequestCount, metrics.writeRequests.get(), null);
    setLong(resyncCount, metrics.resyncs.get(), null);
    setLong(requestTimeoutCount, metrics.requestTimeouts.get(), null);
  }

  synchronized void setRuntimeMetrics(int active, int subscriptions)
  {
    setInt(activeConnections, Math.max(0, active), null);
    setInt(totalSubscriptions, Math.max(0, subscriptions), null);
  }

  int getMaxConnectionsValue()
  {
    return getMaxConnections();
  }

  int getMaxConnectionsPerUserValue()
  {
    return Math.max(0, getMaxConnectionsPerUser());
  }

  int getMaxMessageBytesValue()
  {
    // Floor at 4 KiB so an accidental tiny/zero value cannot make every frame unreadable.
    return Math.max(4096, getMaxMessageBytes());
  }

  int getMaxSubscriptionsPerClientValue()
  {
    return getMaxSubscriptionsPerClient();
  }

  int getMaxPointSnapshotPointsValue()
  {
    return Math.max(1, getMaxPointSnapshotPoints());
  }

  int getHeartbeatIntervalSecValue()
  {
    return Math.max(1, getHeartbeatIntervalSec());
  }

  int getSubscriptionLeaseSecValue()
  {
    return Math.max(0, getSubscriptionLeaseSec());
  }

  int getCovBatchWindowMillisValue()
  {
    return Math.max(0, getCovBatchWindowMillis());
  }

  int getWriteSettleMillisValue()
  {
    // Capped: the delay runs once per point, and a batch can hold 1,000 points.
    return Math.min(5000, Math.max(0, getWriteSettleMillis()));
  }

  boolean getRequireAuthorizationHeaderValue()
  {
    return getRequireAuthorizationHeader();
  }

  boolean getRejectMissingOriginValue()
  {
    return getRejectMissingOrigin();
  }

  int getRevalidateIntervalSecValue()
  {
    return Math.max(0, getRevalidateIntervalSec());
  }

  int getActiveConnectionsValue()
  {
    return getActiveConnections();
  }

  int getTotalSubscriptionsValue()
  {
    return getTotalSubscriptions();
  }

  BRelTime getHeartbeatInterval()
  {
    return BRelTime.makeSeconds(getHeartbeatIntervalSecValue());
  }

  private void ensureServletNameDefault()
  {
    String current = getServletName();
    if (current != null && current.trim().length() > 0)
    {
      return;
    }

    String configuredPath = getWsPath();
    if (configuredPath == null || configuredPath.trim().length() == 0)
    {
      setServletName("stream");
      return;
    }

    String normalized = configuredPath.trim();
    while (normalized.startsWith("/"))
    {
      normalized = normalized.substring(1);
    }
    int slash = normalized.indexOf('/');
    if (slash >= 0)
    {
      normalized = normalized.substring(0, slash);
    }
    setServletName(normalized.length() == 0 ? "stream" : normalized);
  }

  void logFine(String message)
  {
    if (LOG.isLoggable(Level.FINE))
    {
      LOG.fine(message);
    }
  }

  /**
   * Security audit trail for connection and authentication events. Emitted at INFO with a stable
   * {@code AUDIT baskStream} prefix so it can be grepped/routed from the station log. Routing these
   * into Niagara's formal audit-history (BAuditRecord/audit service) is a deferred follow-up that
   * needs the audit-service API confirmed on a real station.
   */
  void audit(String event, String detail)
  {
    LOG.info("AUDIT baskStream " + event + (detail == null || detail.length() == 0 ? "" : " " + detail));
  }

  private boolean isWebSocketUpgrade(WebOp op)
  {
    String upgrade = op.getRequest().getHeader("Upgrade");
    return upgrade != null && "websocket".equalsIgnoreCase(upgrade.trim());
  }

  /** Prometheus/OpenMetrics text: counters since the service started, plus live gauges. */
  private void writeMetrics(WebOp op, BaskStreamMetrics metrics) throws java.io.IOException
  {
    op.getResponse().setStatus(200);
    op.setContentType("text/plain; version=0.0.4; charset=UTF-8");
    StringBuilder out = new StringBuilder();
    metric(out, "baskstream_requests_total", "counter", "Requests handled since the service started.", metrics.requests.get());
    metric(out, "baskstream_errors_total", "counter", "Requests answered with an error.", metrics.errors.get());
    metric(out, "baskstream_write_requests_total", "counter", "Requests that change station data.", metrics.writeRequests.get());
    metric(out, "baskstream_resyncs_total", "counter", "Resync notices after an event backlog overflowed.", metrics.resyncs.get());
    metric(out, "baskstream_request_timeouts_total", "counter", "Sessions closed by the request watchdog.", metrics.requestTimeouts.get());
    metric(out, "baskstream_active_connections", "gauge", "Open WebSocket sessions.", getActiveConnectionsValue());
    metric(out, "baskstream_subscriptions", "gauge", "Point, alarm and model subscriptions across sessions.", getTotalSubscriptionsValue());
    op.getWriter().write(out.toString());
  }

  private static void metric(StringBuilder out, String name, String type, String help, long value)
  {
    out.append("# HELP ").append(name).append(' ').append(help).append('\n');
    out.append("# TYPE ").append(name).append(' ').append(type).append('\n');
    out.append(name).append(' ').append(value).append('\n');
  }

  private void writeHealth(WebOp op) throws java.io.IOException
  {
    java.security.Principal principal = op.getRequest().getUserPrincipal();
    String user = principal == null ? null : principal.getName();

    op.getResponse().setStatus(200);
    op.setContentType("application/json;charset=UTF-8");
    op.getWriter().write("{"
      + "\"service\":\"BASkStreamService\","
      + "\"enabled\":" + getEnabled() + ","
      + "\"wsPath\":\"" + escapeJson(getWsPath()) + "\","
      + "\"apiVersion\":\"1.6\","
      + "\"writesEnabled\":" + writesAllowed() + ","
      + "\"modelEditsEnabled\":" + modelEditsAllowed() + ","
      + "\"servletName\":\"" + escapeJson(getServletName()) + "\","
      + "\"pathInfo\":\"" + escapeJson(op.getPathInfo()) + "\","
      + "\"maxConnections\":" + getMaxConnectionsValue() + ","
      + "\"maxConnectionsPerUser\":" + getMaxConnectionsPerUserValue() + ","
      + "\"maxMessageBytes\":" + getMaxMessageBytesValue() + ","
      + "\"maxSubscriptionsPerClient\":" + getMaxSubscriptionsPerClientValue() + ","
      + "\"maxPointSnapshotPoints\":" + getMaxPointSnapshotPointsValue() + ","
      + "\"heartbeatIntervalSec\":" + getHeartbeatIntervalSecValue() + ","
      + "\"subscriptionLeaseSec\":" + getSubscriptionLeaseSecValue() + ","
      + "\"covBatchWindowMillis\":" + getCovBatchWindowMillisValue() + ","
      + "\"revalidateIntervalSec\":" + getRevalidateIntervalSecValue() + ","
      + "\"requireAuthorizationHeader\":" + getRequireAuthorizationHeaderValue() + ","
      + "\"rejectMissingOrigin\":" + getRejectMissingOriginValue() + ","
      + "\"allowedOrigins\":\"" + escapeJson(getAllowedOrigins()) + "\","
      + "\"activeConnections\":" + getActiveConnectionsValue() + ","
      + "\"totalSubscriptions\":" + getTotalSubscriptionsValue() + ","
      + "\"authenticatedUser\":" + toJsonString(user)
      + "}");
  }

  private static String toJsonString(String value)
  {
    return value == null ? "null" : "\"" + escapeJson(value) + "\"";
  }

  private static String escapeJson(String value)
  {
    if (value == null)
    {
      return "";
    }

    StringBuilder out = new StringBuilder(value.length() + 8);
    for (int i = 0; i < value.length(); i++)
    {
      char ch = value.charAt(i);
      switch (ch)
      {
        case '\\':
          out.append("\\\\");
          break;
        case '"':
          out.append('\\').append('\"');
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          out.append(ch);
          break;
      }
    }
    return out.toString();
  }
}
