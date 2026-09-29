package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.sys.Clock;
import javax.baja.sys.Context;

/** Builds the capabilities reply: API version, operations, limits, schemas and policy. */
final class BaskStreamCapabilities
{
  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;

  BaskStreamCapabilities(BaskStreamClientSession session)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
  }

  void handleCapabilities(String id)
  {
    Map<String, Object> capabilities = new LinkedHashMap<String, Object>();
    capabilities.put("apiVersion", "1.6");
    capabilities.put("module", "baskStream");
    capabilities.put("transport", "websocket-msgpack");
    capabilities.put("serverTime", Long.valueOf(Clock.millis()));
    capabilities.put("authenticatedUser", session.user.getUsername());
    capabilities.put("operations", BaskStreamOperations.names());
    capabilities.put("writesEnabled", runtime.getService().writesAllowed());
    capabilities.put("modelEditing", BaskStreamModelPlans.map("enabled", runtime.getService().modelEditsAllowed(),
        "actions", java.util.Arrays.asList(BaskStreamModelResolver.ACTIONS), "maxChanges", BaskStreamModelResolver.MAX_CHANGES,
        "previewRequired", true, "atomic", false, "planTtlMillis", BaskStreamModelPlans.PREVIEW_TTL,
        "resultTtlMillis", BaskStreamModelPlans.RESULT_TTL, "survivesReconnect", true, "survivesRestart", false));

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
    limits.put("maxSubscriptionLeaseSec", Long.valueOf(BaskStreamClientSession.MAX_LEASE_SEC));
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

    Map<String, Object> sessionInfo = new LinkedHashMap<String, Object>();
    sessionInfo.put("id", session.sessionId);
    sessionInfo.put("pointSubscriptions", Long.valueOf(session.getPointSubscriptionCount()));
    sessionInfo.put("directPointSubscriptions", Long.valueOf(session.points.directCount()));
    sessionInfo.put("subscriptionGroups", Long.valueOf(session.points.groupCount()));
    sessionInfo.put("alarmSubscriptions", Long.valueOf(session.getAlarmSubscriptionCount()));
    sessionInfo.put("modelSubscriptions", Long.valueOf(session.getModelSubscriptionCount()));
    capabilities.put("session", sessionInfo);

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
    pointSnapshot.put("fields", session.listOf(
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

    Map<String, Object> response = session.baseMessage("capabilities_result", id);
    response.put("capabilities", capabilities);
    session.send(response);
  }
}
