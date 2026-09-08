package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.history.BHistoryRecord;
import javax.baja.history.BHistoryConfig;
import javax.baja.history.BIHistory;
import javax.baja.history.BTrendRecord;
import javax.baja.history.HistorySpaceConnection;
import javax.baja.history.ext.BHistoryExt;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.status.BStatus;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BObject;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Cursor;
import javax.baja.sys.Property;

import com.tridium.history.BHistory;

final class BaskStreamHistoryResolver
{
  private static final long DEFAULT_WINDOW_MILLIS = 24L * 60L * 60L * 1000L;
  private static final int DEFAULT_LIMIT = 500;
  private static final int MAX_LIMIT = 5000;

  private final BBaskStreamService service;

  BaskStreamHistoryResolver(BBaskStreamService service)
  {
    this.service = service;
  }

  Map<String, Object> readHistory(String ord, Object startValue, Object endValue, Object limitValue, Context context)
      throws BaskStreamProtocolException
  {
    String candidate = normalizeOrd(ord);
    long end = normalizeMillis(endValue, Clock.millis());
    long start = normalizeMillis(startValue, end - DEFAULT_WINDOW_MILLIS);
    int limit = normalizeLimit(limitValue);

    if (start > end)
    {
      throw new BaskStreamProtocolException("bad_request", "History start must be less than or equal to end.");
    }

    List<Object> histories = candidate.startsWith("history:")
        ? resolveDirectHistory(candidate, start, end, limit, context)
        : resolvePointHistory(candidate, start, end, limit, context);

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("requestOrd", candidate);
    result.put("start", Long.valueOf(start));
    result.put("end", Long.valueOf(end));
    result.put("limit", Long.valueOf(limit));
    result.put("histories", histories);
    return result;
  }

  Map<String, Object> describeHistory(String ord, Context context) throws BaskStreamProtocolException
  {
    String candidate = normalizeOrd(ord);
    List<Object> histories = candidate.startsWith("history:")
        ? describeDirectHistory(candidate, context)
        : describePointHistories(candidate, context);

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("requestOrd", candidate);
    result.put("count", Long.valueOf(histories.size()));
    result.put("histories", histories);
    return result;
  }

  private List<Object> describeDirectHistory(String ord, Context context) throws BaskStreamProtocolException
  {
    try
    {
      OrdTarget target = BOrd.make(ord).resolve(service, context);
      if (!target.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_point", "History is not readable for the authenticated user.");
      }

      BObject object = target.get();
      if (!(object instanceof BHistory))
      {
        throw new BaskStreamProtocolException("invalid_point", "Resolved target is not a Niagara history.");
      }
      ensureDirectHistoryAllowed((BHistory) object);

      List<Object> histories = new ArrayList<Object>(1);
      histories.add(describeSingleHistory((BHistory) object, null, context));
      return histories;
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("history_failed",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private List<Object> describePointHistories(String ord, Context context) throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint point = new BaskStreamPointResolver(service).resolve(ord, context);
    if (point.getComponent() == null)
    {
      throw new BaskStreamProtocolException("history_failed", "Resolved point has no backing component.");
    }

    BHistoryExt[] historyExts = point.getComponent().getChildren(BHistoryExt.class);
    List<Object> histories = new ArrayList<Object>(historyExts.length);
    for (int i = 0; i < historyExts.length; i++)
    {
      BIHistory history = historyExts[i].getHistory();
      if (history instanceof BHistory)
      {
        histories.add(describeSingleHistory((BHistory) history, historyExts[i], context));
      }
      else
      {
        Map<String, Object> summary = extensionSummary(historyExts[i], context);
        summary.put("historyError", "Attached history did not resolve to a readable local history.");
        histories.add(summary);
      }
    }
    return histories;
  }

  private List<Object> resolveDirectHistory(String ord, long start, long end, int limit, Context context)
      throws BaskStreamProtocolException
  {
    try
    {
      OrdTarget target = BOrd.make(ord).resolve(service, context);
      if (!target.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_point", "History is not readable for the authenticated user.");
      }

      BObject object = target.get();
      if (!(object instanceof BHistory))
      {
        throw new BaskStreamProtocolException("invalid_point", "Resolved target is not a Niagara history.");
      }
      ensureDirectHistoryAllowed((BHistory) object);

      List<Object> histories = new ArrayList<Object>(1);
      histories.add(readSingleHistory((BHistory) object, null, start, end, limit, context));
      return histories;
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("history_failed",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private List<Object> resolvePointHistory(String ord, long start, long end, int limit, Context context)
      throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint point = new BaskStreamPointResolver(service).resolve(ord, context);
    if (point.getComponent() == null)
    {
      throw new BaskStreamProtocolException("history_failed", "Resolved point has no backing component.");
    }

    BHistoryExt[] historyExts = point.getComponent().getChildren(BHistoryExt.class);
    if (historyExts.length == 0)
    {
      throw new BaskStreamProtocolException("history_failed", "Point does not have any attached history extensions.");
    }

    List<Object> histories = new ArrayList<Object>(historyExts.length);
    for (int i = 0; i < historyExts.length; i++)
    {
      BHistory history = historyExts[i].getHistory() instanceof BHistory ? (BHistory) historyExts[i].getHistory() : null;
      if (history == null)
      {
        continue;
      }
      histories.add(readSingleHistory(history, historyExts[i], start, end, limit, context));
    }

    if (histories.isEmpty())
    {
      throw new BaskStreamProtocolException("history_failed", "Attached history extensions did not resolve to readable histories.");
    }

    return histories;
  }

  private void ensureDirectHistoryAllowed(BHistory history) throws BaskStreamProtocolException
  {
    if (BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      return;
    }

    BHistoryConfig config = history.getConfig();
    String source = config == null || config.getSource() == null ? null : config.getSource().toString();
    String slotOrd = BaskStreamAccessPolicy.extractSlotOrd(source);
    if (slotOrd == null || !slotOrd.startsWith("slot:/") || !BaskStreamAccessPolicy.isAllowed(service, slotOrd))
    {
      throw new BaskStreamProtocolException("forbidden_point",
          "History source is outside the allowedPathPatterns policy.");
    }
  }

  private Map<String, Object> readSingleHistory(BHistory history, BHistoryExt historyExt, long start, long end, int limit,
      Context context) throws BaskStreamProtocolException
  {
    Map<String, Object> wire = describeSingleHistory(history, historyExt, context);

    List<Object> records = new ArrayList<Object>();
    BAbsTime startTime = BAbsTime.make(start);
    BAbsTime endTime = BAbsTime.make(end);

    boolean truncated = false;
    Cursor<BHistoryRecord> cursor = null;
    try
    {
      cursor = history.timeQueryCursor(startTime, endTime, false, context);
      int count = 0;
      while (cursor.next())
      {
        if (count >= limit) { truncated = true; break; }
        records.add(toWire(cursor.get(), context));
        count++;
      }
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("history_failed",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    finally
    {
      if (cursor != null)
      {
        cursor.close();
      }
    }

    wire.put("records", records);
    wire.put("truncated", Boolean.valueOf(truncated));
    wire.put("count", Long.valueOf(records.size()));
    wire.put("start", Long.valueOf(start));
    wire.put("end", Long.valueOf(end));
    return wire;
  }

  private Map<String, Object> describeSingleHistory(BHistory history, BHistoryExt historyExt, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("historyOrd", history.getNavOrd() == null ? history.getOrdInSpace().toString() : history.getNavOrd().toString());
    wire.put("historyId", history.getId() == null ? null : history.getId().toString());
    wire.put("display", history.getDisplayName(context));
    wire.put("recordType", history.getRecordType().toString());
    wire.put("sourceOrd", historyExt == null || historyExt.getSourceOrd() == null ? null : historyExt.getSourceOrd().toString());
    wire.put("extension", historyExt == null ? null : extensionSummary(historyExt, context));
    appendHistoryConfig(wire, history.getConfig(), context);
    appendHistorySummary(wire, history, context);
    return wire;
  }

  private Map<String, Object> extensionSummary(BHistoryExt historyExt, Context context)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("slotPath", historyExt.getSlotPath() == null ? null : historyExt.getSlotPath().toString());
    summary.put("name", historyExt.getName());
    summary.put("display", historyExt.getDisplayName(context));
    summary.put("typeSpec", historyExt.getType().toString());
    summary.put("enabled", Boolean.valueOf(historyExt.getEnabled()));
    summary.put("active", Boolean.valueOf(historyExt.getActive()));
    summary.put("status", historyExt.getStatus() == null ? null : historyExt.getStatus().toString(context));
    summary.put("faultCause", historyExt.getFaultCause());
    summary.put("historyName", historyExt.resolveHistoryName());
    summary.put("recordType", historyExt.getRecordType() == null ? null : historyExt.getRecordType().toString());
    appendHistoryConfig(summary, historyExt.getHistoryConfig(), context);
    return summary;
  }

  private void appendHistoryConfig(Map<String, Object> wire, BHistoryConfig config, Context context)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    if (config != null)
    {
      summary.put("id", config.getId() == null ? null : config.getId().toString());
      summary.put("historyName", config.getHistoryName());
      summary.put("source", config.getSource() == null ? null : config.getSource().toString());
      summary.put("recordType", config.getRecordType() == null ? null : config.getRecordType().toString());
      summary.put("capacity", config.getCapacity() == null ? null : config.getCapacity().toString(context));
      summary.put("fullPolicy", config.getFullPolicy() == null ? null : config.getFullPolicy().toString(context));
      summary.put("storageType", config.getStorageType() == null ? null : config.getStorageType().toString(context));
      summary.put("interval", config.getInterval() == null ? null : config.getInterval().toString(context));
      summary.put("timeZone", config.getTimeZone() == null ? null : config.getTimeZone().toString(context));
    }
    wire.put("config", summary);
  }

  private void appendHistorySummary(Map<String, Object> wire, BHistory history, Context context)
  {
    HistorySpaceConnection connection = null;
    try
    {
      connection = history.getHistorySpace().getConnection(context);
      wire.put("totalCount", Long.valueOf(connection.getRecordCount(history)));
      wire.put("firstTimestamp", connection.getFirstTimestamp(history) == null ? null
          : Long.valueOf(connection.getFirstTimestamp(history).getMillis()));
      wire.put("lastTimestamp", connection.getLastTimestamp(history) == null ? null
          : Long.valueOf(connection.getLastTimestamp(history).getMillis()));
      wire.put("lastRecord", connection.getLastRecord(history) == null ? null
          : toWire(connection.getLastRecord(history), context));
    }
    catch (Exception e)
    {
      wire.put("summaryError", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    finally
    {
      if (connection != null)
      {
        connection.close();
      }
    }
  }

  private Map<String, Object> toWire(BHistoryRecord record, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("timestamp", Long.valueOf(record.getTimestamp().getMillis()));
    wire.put("recordType", record.getType().toString());
    wire.put("summary", record.toDataSummary(context));

    if (record instanceof javax.baja.history.BNumericTrendRecord)
    {
      javax.baja.history.BNumericTrendRecord numeric = (javax.baja.history.BNumericTrendRecord) record;
      wire.put("value", Double.valueOf(numeric.getValue()));
      wire.put("valueType", "numeric");
      wire.put("status", numeric.getStatus().toString(context));
      wire.put("trendFlags", numeric.getTrendFlags().toString(context));
    }
    else if (record instanceof javax.baja.history.BBooleanTrendRecord)
    {
      javax.baja.history.BBooleanTrendRecord bool = (javax.baja.history.BBooleanTrendRecord) record;
      wire.put("value", Boolean.valueOf(bool.getValue()));
      wire.put("valueType", "boolean");
      wire.put("status", bool.getStatus().toString(context));
      wire.put("trendFlags", bool.getTrendFlags().toString(context));
    }
    else if (record instanceof javax.baja.history.BStringTrendRecord)
    {
      javax.baja.history.BStringTrendRecord str = (javax.baja.history.BStringTrendRecord) record;
      wire.put("value", str.getValue());
      wire.put("valueType", "string");
      wire.put("status", str.getStatus().toString(context));
      wire.put("trendFlags", str.getTrendFlags().toString(context));
    }
    else if (record instanceof javax.baja.history.BEnumTrendRecord)
    {
      javax.baja.history.BEnumTrendRecord en = (javax.baja.history.BEnumTrendRecord) record;
      wire.put("value", en.getValue() == null ? null : en.getValue().toString(context));
      wire.put("valueType", "enum");
      wire.put("status", en.getStatus().toString(context));
      wire.put("trendFlags", en.getTrendFlags().toString(context));
    }
    else if (record instanceof BTrendRecord)
    {
      BTrendRecord trend = (BTrendRecord) record;
      Property valueProperty = trend.getValueProperty();
      Object value = valueProperty == null ? null : trend.get(valueProperty);
      wire.put("value", value == null ? null : value.toString());
      wire.put("valueType", trend.getType().toString());
      wire.put("status", trend.getStatus().toString(context));
      wire.put("trendFlags", trend.getTrendFlags().toString(context));
    }
    else
    {
      wire.put("value", record.toString(context));
      wire.put("valueType", record.getType().toString());
    }

    return wire;
  }

  private String normalizeOrd(String ord) throws BaskStreamProtocolException
  {
    if (ord == null || ord.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'ord' is required for read_history.");
    }
    String candidate = ord.trim();
    if (!candidate.startsWith("slot:/") && !candidate.startsWith("history:"))
    {
      throw new BaskStreamProtocolException("invalid_point", "read_history supports slot:/ or history: ords only.");
    }
    return candidate;
  }

  private long normalizeMillis(Object value, long defaultValue) throws BaskStreamProtocolException
  {
    if (value == null)
    {
      return defaultValue;
    }
    if (!(value instanceof Number))
    {
      throw new BaskStreamProtocolException("bad_request", "History time fields must be epoch milliseconds.");
    }
    return ((Number) value).longValue();
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
}
