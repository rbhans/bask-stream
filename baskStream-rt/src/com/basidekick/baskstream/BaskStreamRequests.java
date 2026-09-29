package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.sys.Clock;
import javax.baja.sys.Context;

/** Request handlers that call a resolver and reply once: reads, writes, history, alarms, schedules, tags and model plans. */
final class BaskStreamRequests
{
  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;

  BaskStreamRequests(BaskStreamClientSession session)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
  }

  void handleRead(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> points = runtime.getCodec().requireStringList(request, "points");
    session.requireMaxSize(points, "points", runtime.getService().getMaxPointSnapshotPointsValue());
    List<String> fields = normalizeSnapshotFields(request);
    List<Object> results = new ArrayList<Object>(points.size());
    for (String pointOrd : points)
    {
      results.add(resolveReadResult(pointOrd, fields));
    }

    Map<String, Object> response = session.baseMessage("read_result", id);
    response.put("points", results);
    session.send(response);
  }

  void handleWrite(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("write_result", id);
    response.put("points", runtime.getWriteResolver().write(request, context, () -> session.closed.get()));
    session.send(response);
  }

  void handleBrowse(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String baseOrd = runtime.getCodec().optionalString(request, "base");
    int depth = runtime.getBrowseResolver().normalizeDepth(request.get("depth"));
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_NONE);

    Map<String, Object> response = session.baseMessage("browse_result", id);
    response.put("depth", Long.valueOf(depth));
    response.put("metadata", metadataMode);
    response.put("node", runtime.getBrowseResolver().browse(baseOrd, depth, metadataMode, context));
    session.send(response);
  }

  void handleDescribe(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "base");
    }

    Map<String, Object> response = session.baseMessage("describe_result", id);
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_FULL);
    response.put("metadata", metadataMode);
    response.put("node", runtime.getBrowseResolver().describe(ord, metadataMode, context));
    session.send(response);
  }

  void handleSearch(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String baseOrd = runtime.getCodec().optionalString(request, "base");
    Object searchDepth = request.containsKey("maxDepth") ? request.get("maxDepth") : request.get("depth");
    String metadataMode = runtime.getBrowseResolver().normalizeMetadataMode(
        metadataRequestValue(request),
        BaskStreamBrowseResolver.METADATA_NONE);
    Map<String, Object> response = session.baseMessage("search_result", id);
    response.put("result", runtime.getBrowseResolver().search(
        baseOrd,
        searchDepth,
        metadataMode,
        runtime.getCodec().optionalString(request, "query"),
        runtime.getCodec().optionalString(request, "kind"),
        session.optionalStringList(request, "features"),
        session.optionalStringList(request, "operations"),
        session.optionalBoolean(request, "writable"),
        request.get("limit"),
        request.get("maxVisited"),
        request.get("timeoutMillis"),
        context));
    session.send(response);
  }

  void handleDescribeWrite(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("write_description", id);
    response.put("points", runtime.getWriteResolver().describe(request, context));
    session.send(response);
  }

  private Object metadataRequestValue(Map<String, Object> request)
  {
    if (request.containsKey("metadata"))
    {
      return request.get("metadata");
    }
    return request.get("includeMetadata");
  }

  void handleReadHistory(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    Map<String, Object> response = session.baseMessage("history_result", id);
    response.put("history", runtime.getHistoryResolver().readHistory(
        ord,
        request.get("start"),
        request.get("end"),
        request.get("limit"),
        context));
    session.send(response);
  }

  void handleReadHistoryRollup(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("history_rollup_result", id);
    response.put("rollup", runtime.getHistoryResolver().rollupHistory(
        runtime.getCodec().optionalString(request, "ord"),
        request.get("start"),
        request.get("end"),
        request.get("interval"),
        request.get("includeInvalid"),
        context));
    session.send(response);
  }

  void handleDescribeHistory(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "source");
    }

    Map<String, Object> response = session.baseMessage("history_description", id);
    response.put("history", runtime.getHistoryResolver().describeHistory(ord, context));
    session.send(response);
  }

  void handleReadAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    String scope = runtime.getCodec().optionalString(request, "scope");

    Object order = request.get("order");
    if (order != null && !"newest".equals(order) && !"oldest".equals(order))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'order' must be 'newest' or 'oldest'.");
    }
    Map<String, Object> response = session.baseMessage("alarms_result", id);
    response.put("alarms", runtime.getAlarmResolver().readAlarms(source, scope, request.get("limit"),
        BaskStreamAlarmResolver.AlarmFilter.parse(request.get("filter")), "newest".equals(order), context));
    session.send(response);
  }

  void handleAckAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    Map<String, Object> response = session.baseMessage("alarm_action_result", id);
    response.put("alarms", runtime.getAlarmResolver().alarmActionRequest("ack_alarm", alarmUuidValue(request),
        request.get("filter"), runtime.getCodec().optionalString(request, "scope"), request.get("limit"), source,
        request.get("dryRun"), context, session.user.getUsername()));
    session.send(response);
  }

  void handleClearAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String source = runtime.getCodec().optionalString(request, "source");
    Map<String, Object> response = session.baseMessage("alarm_action_result", id);
    response.put("alarms", runtime.getAlarmResolver().alarmActionRequest("clear_alarm", alarmUuidValue(request),
        request.get("filter"), runtime.getCodec().optionalString(request, "scope"), request.get("limit"), source,
        request.get("dryRun"), context, session.user.getUsername()));
    session.send(response);
  }

  private Object alarmUuidValue(Map<String, Object> request)
  {
    return request.containsKey("uuids") ? request.get("uuids") : request.get("uuid");
  }

  void handleModelOperation(String id, String op, Map<String, Object> request) throws Exception
  {
    BaskStreamModelResolver model = runtime.getModelResolver();
    Map<String, Object> result;
    if ("describe_component_types".equals(op)) result = model.types(request, context);
    else if ("describe_component".equals(op)) result = model.describe(request, context);
    else if ("apply_model_changes".equals(op))
    {
      result = model.apply(request, context);
      runtime.modelChanged(result);
    }
    else if ("model_plan_status".equals(op)) result = model.status(request, context);
    else if ("cancel_model_plan".equals(op)) result = model.cancel(request, context);
    else if ("preview_model_changes".equals(op)) result = model.preview(request, context);
    else
    {
      // Convenience operation names compile into the same preview/apply engine.
      // None is a second, unreviewed path around an approved plan.
      String action = "create_components".equals(op) ? "create" : "update_component_properties".equals(op) ? "update"
          : "rename_component".equals(op) ? "rename" : "move_components".equals(op) ? "move"
          : "delete_components".equals(op) ? "delete" : op;
      Object raw = request.get("changes");
      List<Object> changes = new ArrayList<Object>();
      if (raw != null && !(raw instanceof List)) throw new BaskStreamProtocolException("bad_request", "changes must be an array.");
      List<?> inputs = raw == null ? java.util.Collections.singletonList(request) : (List<?>)raw;
      for (Object input : inputs)
      {
        Map<String, Object> change = new LinkedHashMap<String, Object>(BaskStreamModelResolver.object(input, "change"));
        change.remove("op"); change.remove("id"); change.put("action", action); changes.add(change);
      }
      result = model.preview(BaskStreamModelPlans.map("changes", changes), context);
    }
    Map<String, Object> response = session.baseMessage("model_result", id);
    response.put("operation", op); response.put("result", result);
    session.send(response);
  }

  void handleReadSchedule(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String ord = runtime.getCodec().optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = runtime.getCodec().optionalString(request, "source");
    }

    Map<String, Object> response = session.baseMessage("schedule_result", id);
    response.put("schedule", runtime.getScheduleResolver().readSchedule(ord, request.get("at"), context));
    session.send(response);
  }

  void handleReadScheduleEvents(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("schedule_events_result", id);
    response.put("schedule", runtime.getScheduleResolver().readScheduleEvents(
        runtime.getCodec().optionalString(request, "ord"), request.get("start"), request.get("end"), request.get("limit"), context));
    session.send(response);
  }

  void handleWriteSchedule(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("schedule_write_result", id);
    response.put("schedule", runtime.getScheduleResolver().writeSchedule(
        runtime.getCodec().optionalString(request, "ord"), request.get("days"), request.get("dryRun"), context));
    session.send(response);
  }

  void handleReadTags(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("tags_result", id);
    response.put("targets", runtime.getTagResolver().readTags(request, context));
    session.send(response);
  }

  void handleWriteTags(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("tags_written", id);
    response.put("targets", runtime.getTagResolver().writeTags(request, context));
    session.send(response);
  }

  void handleWriteRelations(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Map<String, Object> response = session.baseMessage("relations_written", id);
    response.put("targets", runtime.getTagResolver().writeRelations(request, context));
    session.send(response);
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
      return session.errorEntry(pointOrd, e.getCode(), e.getMessage());
    }
  }

  private List<String> normalizeSnapshotFields(Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> fields = session.optionalStringList(request, "fields");
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
}
