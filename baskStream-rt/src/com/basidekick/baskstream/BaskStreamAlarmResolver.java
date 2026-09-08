package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.alarm.AlarmSpaceConnection;
import javax.baja.alarm.BAckState;
import javax.baja.alarm.BAlarmRecord;
import javax.baja.alarm.BAlarmService;
import javax.baja.alarm.BSourceState;
import javax.baja.naming.BOrd;
import javax.baja.naming.BOrdList;
import javax.baja.sys.BObject;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Cursor;
import javax.baja.util.BUuid;

final class BaskStreamAlarmResolver
{
  private static final int DEFAULT_LIMIT = 500;
  private static final int MAX_LIMIT = 5000;

  private final BBaskStreamService service;

  BaskStreamAlarmResolver(BBaskStreamService service)
  {
    this.service = service;
  }

  AlarmSubscriptionSpec normalizeSubscription(String sourceOrd, String scope, Object limitValue)
      throws BaskStreamProtocolException
  {
    return normalizeSubscription(sourceOrd, scope, limitValue, null);
  }

  AlarmSubscriptionSpec normalizeSubscription(String sourceOrd, String scope, Object limitValue, String mode)
      throws BaskStreamProtocolException
  {
    return new AlarmSubscriptionSpec(
        normalizeSource(sourceOrd),
        normalizeScope(scope),
        normalizeLimit(limitValue),
        normalizeMode(mode));
  }

  Map<String, Object> readAlarms(String sourceOrd, String scope, Object limitValue, Context context)
      throws BaskStreamProtocolException
  {
    AlarmSubscriptionSpec spec = normalizeSubscription(sourceOrd, scope, limitValue);
    requireAllowed(spec);

    BAlarmService alarmService = BAlarmService.getService();
    if (alarmService == null)
    {
      throw new BaskStreamProtocolException("alarm_failed", "Niagara AlarmService is not available.");
    }

    List<Object> alarms = new ArrayList<Object>();
    boolean truncated = false;

    try (AlarmSpaceConnection connection = alarmService.getAlarmDb().getConnection(context))
    {
      Cursor<BAlarmRecord> cursor = null;
      try
      {
        cursor = openCursor(connection, spec.scope);
        int count = 0;
        while (cursor.next())
        {
          BAlarmRecord record = cursor.get();
          if (spec.source != null && !matchesSource(record, spec.source))
          {
            continue;
          }
          if (count >= spec.limit) { truncated = true; break; }
          alarms.add(toWire(record, context));
          count++;
        }
      }
      finally
      {
        if (cursor != null)
        {
          cursor.close();
        }
      }
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException(
          "alarm_failed",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }

    Map<String, Object> response = result(spec, alarms);
    response.put("truncated", Boolean.valueOf(truncated));
    return response;
  }

  Map<String, Object> acknowledgeAlarms(Object uuidValue, String sourceOrd, Context context, String userName)
      throws BaskStreamProtocolException
  {
    return alarmAction("ack_alarm", uuidValue, sourceOrd, context, userName);
  }

  Map<String, Object> clearAlarms(Object uuidValue, String sourceOrd, Context context, String userName)
      throws BaskStreamProtocolException
  {
    return alarmAction("clear_alarm", uuidValue, sourceOrd, context, userName);
  }

  void requireAllowed(AlarmSubscriptionSpec spec) throws BaskStreamProtocolException
  {
    if (BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      return;
    }
    if (spec == null || spec.source == null || !BaskStreamAccessPolicy.isAllowed(service, spec.source))
    {
      throw new BaskStreamProtocolException("forbidden_point",
          "Alarm source is outside the allowedPathPatterns policy.");
    }
  }

  Map<String, Object> result(AlarmSubscriptionSpec spec, List<Object> alarms)
  {
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("scope", spec.scope);
    result.put("source", spec.source);
    result.put("limit", Long.valueOf(spec.limit));
    result.put("count", Long.valueOf(alarms.size()));
    result.put("alarms", alarms);
    return result;
  }

  private Map<String, Object> alarmAction(String action, Object uuidValue, String sourceOrd, Context context, String userName)
      throws BaskStreamProtocolException
  {
    String source = normalizeSource(sourceOrd);
    List<String> uuids = normalizeUuids(uuidValue);
    BAlarmService alarmService = BAlarmService.getService();
    if (alarmService == null)
    {
      throw new BaskStreamProtocolException("alarm_failed", "Niagara AlarmService is not available.");
    }

    List<Object> results = new ArrayList<Object>(uuids.size());
    for (String uuid : uuids)
    {
      try
      {
        BAlarmRecord record = resolveAlarmRecord(alarmService, uuid, context);
        requireAllowedRecord(record);
        if (source != null && !matchesSource(record, source))
        {
          throw new BaskStreamProtocolException("forbidden_point", "Alarm record did not match the requested source filter.");
        }
        if ("ack_alarm".equals(action))
        {
          acknowledgeAlarm(alarmService, record, context, userName);
        }
        else
        {
          forceClearAlarm(alarmService, record, context, userName);
        }

        Map<String, Object> result = toWire(record, context);
        result.put("ok", Boolean.TRUE);
        result.put("action", action);
        results.add(result);
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(uuid, e.getCode(), e.getMessage()));
      }
      catch (Exception e)
      {
        results.add(errorEntry(uuid, "alarm_failed",
            e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
      }
    }

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("action", action);
    result.put("source", source);
    result.put("count", Long.valueOf(results.size()));
    result.put("alarms", results);
    return result;
  }

  private BAlarmRecord resolveAlarmRecord(BAlarmService alarmService, String uuid, Context context)
      throws Exception
  {
    try (AlarmSpaceConnection connection = alarmService.getAlarmDb().getConnection(context))
    {
      BAlarmRecord record = connection.getRecord(BUuid.make(uuid));
      if (record == null)
      {
        throw new BaskStreamProtocolException("invalid_alarm", "Alarm record was not found.");
      }
      return record;
    }
  }

  private void acknowledgeAlarm(BAlarmService alarmService, BAlarmRecord record, Context context, String userName)
      throws Exception
  {
    if (record.isAcknowledged() || record.isAckPending())
    {
      return;
    }
    record.ackAlarm(userName);
    alarmService.invoke(BAlarmService.ackAlarm, record, context);
  }

  private void forceClearAlarm(BAlarmService alarmService, BAlarmRecord record, Context context, String userName)
      throws Exception
  {
    alarmService.invoke(BAlarmService.auditForceClear, record, context);
    record.setSourceState(BSourceState.normal);
    record.setAlarmTransition(BSourceState.normal);
    record.setAckState(BAckState.acked);
    record.setUser(userName);
    if (record.getNormalTime() == null)
    {
      record.setNormalTime(Clock.time());
    }
    if (record.getAckTime() == null)
    {
      record.setAckTime(Clock.time());
    }
    record.setLastUpdate(Clock.time());

    try (AlarmSpaceConnection connection = alarmService.getAlarmDb().getConnection(context))
    {
      connection.update(record);
      connection.flush();
    }
  }

  private void requireAllowedRecord(BAlarmRecord record) throws BaskStreamProtocolException
  {
    if (BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      return;
    }

    BOrdList sources = record.getSource();
    if (sources != null)
    {
      for (int i = 0; i < sources.size(); i++)
      {
        BOrd ord = sources.get(i);
        String candidate = ord == null ? null : normalizeSlotOrd(ord.toString());
        if (candidate != null && BaskStreamAccessPolicy.isAllowed(service, candidate))
        {
          return;
        }
      }
    }
    throw new BaskStreamProtocolException("forbidden_point",
        "Alarm source is outside the allowedPathPatterns policy.");
  }

  private List<String> normalizeUuids(Object value) throws BaskStreamProtocolException
  {
    List<String> uuids = new ArrayList<String>();
    if (value instanceof String)
    {
      addUuid(uuids, (String) value);
    }
    else if (value instanceof List)
    {
      List<?> raw = (List<?>) value;
      for (Object item : raw)
      {
        if (!(item instanceof String))
        {
          throw new BaskStreamProtocolException("bad_request", "Field 'uuid' or 'uuids' must contain string UUIDs.");
        }
        addUuid(uuids, (String) item);
      }
    }
    else
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'uuid' or 'uuids' is required.");
    }

    if (uuids.isEmpty())
    {
      throw new BaskStreamProtocolException("bad_request", "At least one alarm UUID is required.");
    }
    return uuids;
  }

  private void addUuid(List<String> uuids, String uuid) throws BaskStreamProtocolException
  {
    if (uuid == null || uuid.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Alarm UUID cannot be blank.");
    }
    uuids.add(uuid.trim());
  }

  private Map<String, Object> errorEntry(String uuid, String code, String message)
  {
    Map<String, Object> error = new LinkedHashMap<String, Object>();
    error.put("uuid", uuid);
    error.put("ok", Boolean.FALSE);
    error.put("code", code);
    error.put("message", message);
    return error;
  }

  private Cursor<BAlarmRecord> openCursor(AlarmSpaceConnection connection, String scope)
      throws Exception
  {
    if ("ack_pending".equals(scope))
    {
      return connection.getAckPendingAlarms();
    }
    if ("all".equals(scope))
    {
      return connection.scan();
    }
    return connection.getOpenAlarms();
  }

  Map<String, Object> toWire(BAlarmRecord record, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("timestamp", record.getTimestamp() == null ? null : Long.valueOf(record.getTimestamp().getMillis()));
    wire.put("uuid", record.getUuid() == null ? null : record.getUuid().toString());
    wire.put("sourceState", sourceStateName(record.getSourceState()));
    wire.put("ackState", ackStateName(record.getAckState()));
    wire.put("ackRequired", Boolean.valueOf(record.getAckRequired()));
    wire.put("alarmClass", record.getAlarmClass());
    wire.put("alarmClassDisplay", record.getAlarmClassDisplayName(context));
    wire.put("priority", Long.valueOf(record.getPriority()));
    wire.put("normalTime", record.getNormalTime() == null ? null : Long.valueOf(record.getNormalTime().getMillis()));
    wire.put("ackTime", record.getAckTime() == null ? null : Long.valueOf(record.getAckTime().getMillis()));
    wire.put("lastUpdate", record.getLastUpdate() == null ? null : Long.valueOf(record.getLastUpdate().getMillis()));
    wire.put("user", record.getUser());
    wire.put("transition", sourceStateName(record.getAlarmTransition()));
    wire.put("summary", record.toSummaryString());
    wire.put("display", record.toString(context));
    wire.put("isOpen", Boolean.valueOf(record.isOpen()));
    wire.put("isAlarm", Boolean.valueOf(record.isAlarm()));
    wire.put("isAcknowledged", Boolean.valueOf(record.isAcknowledged()));
    wire.put("isAckPending", Boolean.valueOf(record.isAckPending()));
    wire.put("isNormal", Boolean.valueOf(record.isNormal()));
    wire.put("sources", toSourceList(record.getSource()));
    wire.put("data", toAlarmData(record, context));
    return wire;
  }

  private List<Object> toSourceList(BOrdList ords)
  {
    List<Object> sources = new ArrayList<Object>();
    if (ords == null)
    {
      return sources;
    }
    for (int i = 0; i < ords.size(); i++)
    {
      BOrd ord = ords.get(i);
      sources.add(ord == null ? null : ord.toString());
    }
    return sources;
  }

  private Map<String, Object> toAlarmData(BAlarmRecord record, Context context)
  {
    Map<String, Object> data = new LinkedHashMap<String, Object>();
    if (record.getAlarmData() == null)
    {
      return data;
    }

    String[] keys = record.getAlarmData().list();
    for (int i = 0; i < keys.length; i++)
    {
      BObject value = record.getAlarmData().get(keys[i]);
      data.put(keys[i], value == null ? null : value.toString(context));
    }
    return data;
  }

  boolean matchesSource(BAlarmRecord record, String sourceOrd)
  {
    String filter = normalizeSlotOrd(sourceOrd);
    BOrdList sources = record.getSource();
    if (sources == null)
    {
      return false;
    }

    for (int i = 0; i < sources.size(); i++)
    {
      BOrd ord = sources.get(i);
      if (ord == null)
      {
        continue;
      }

      String candidate = normalizeSlotOrd(ord.toString());
      if (candidate == null)
      {
        continue;
      }
      if (!BaskStreamAccessPolicy.isDefaultWideOpen(service) && !BaskStreamAccessPolicy.isAllowed(service, candidate))
      {
        continue;
      }

      if (filter.equals(candidate)
          || candidate.startsWith(filter + "/")
          || filter.startsWith(candidate + "/"))
      {
        return true;
      }
    }
    return false;
  }

  boolean matchesScope(BAlarmRecord record, String scope)
  {
    if (record == null)
    {
      return false;
    }
    if ("all".equals(scope))
    {
      return true;
    }
    if ("ack_pending".equals(scope))
    {
      return record.isAckPending();
    }
    return record.isOpen();
  }

  private static String normalizeSlotOrd(String ord)
  {
    if (ord == null)
    {
      return null;
    }

    int index = ord.indexOf("slot:/");
    return index >= 0 ? ord.substring(index) : ord;
  }

  private String normalizeSource(String sourceOrd) throws BaskStreamProtocolException
  {
    if (sourceOrd == null || sourceOrd.trim().length() == 0)
    {
      return null;
    }

    String candidate = sourceOrd.trim();
    if (!candidate.startsWith("slot:/"))
    {
      throw new BaskStreamProtocolException("invalid_point", "Alarm source filter supports slot:/ ORDs only.");
    }
    return candidate;
  }

  private String normalizeScope(String scope) throws BaskStreamProtocolException
  {
    if (scope == null || scope.trim().length() == 0)
    {
      return "open";
    }

    String candidate = scope.trim().toLowerCase();
    if ("open".equals(candidate) || "ack_pending".equals(candidate) || "all".equals(candidate))
    {
      return candidate;
    }

    throw new BaskStreamProtocolException("bad_request", "Alarm scope must be one of: open, ack_pending, all.");
  }

  private String normalizeMode(String mode) throws BaskStreamProtocolException
  {
    if (mode == null || mode.trim().length() == 0)
    {
      return "event";
    }

    String candidate = mode.trim().toLowerCase().replace('-', '_');
    if ("event".equals(candidate) || "snapshot".equals(candidate) || "both".equals(candidate))
    {
      return candidate;
    }

    throw new BaskStreamProtocolException("bad_request", "Alarm subscription mode must be one of: event, snapshot, both.");
  }

  private int normalizeLimit(Object value) throws BaskStreamProtocolException
  {
    if (value == null)
    {
      return DEFAULT_LIMIT;
    }
    if (!(value instanceof Number))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'limit' must be a number.");
    }
    int limit = ((Number) value).intValue();
    if (limit <= 0)
    {
      return DEFAULT_LIMIT;
    }
    return Math.min(limit, MAX_LIMIT);
  }

  private static String sourceStateName(BSourceState state)
  {
    return state == null ? null : state.toString();
  }

  private static String ackStateName(BAckState state)
  {
    return state == null ? null : state.toString();
  }

  static final class AlarmSubscriptionSpec
  {
    final String source;
    final String scope;
    final int limit;
    final String mode;

    AlarmSubscriptionSpec(String source, String scope, int limit, String mode)
    {
      this.source = source;
      this.scope = scope;
      this.limit = limit;
      this.mode = mode;
    }

    String key()
    {
      return (source == null ? "*" : source) + "|" + scope + "|" + limit + "|" + mode;
    }
  }
}
