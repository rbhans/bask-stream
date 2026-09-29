package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.history.BHistoryRecord;
import javax.baja.history.BHistoryConfig;
import javax.baja.history.BHistoryService;
import javax.baja.history.BIHistory;
import javax.baja.history.BTrendRecord;
import javax.baja.history.HistorySpaceConnection;
import javax.baja.history.ext.BHistoryExt;
import javax.baja.naming.BOrd;
import javax.baja.naming.BOrdList;
import javax.baja.naming.OrdTarget;
import javax.baja.status.BStatus;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BObject;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Cursor;
import javax.baja.sys.Property;
import javax.baja.sys.Sys;


final class BaskStreamHistoryResolver
{
  private static final long DEFAULT_WINDOW_MILLIS = 24L * 60L * 60L * 1000L;
  private static final int DEFAULT_LIMIT = 500;
  private static final int MAX_LIMIT = 5000;
  private static final long MAX_ROLLUP_BUCKETS = 5000L;
  private static final long MAX_ROLLUP_RECORDS = 1000000L;
  private static final long ROLLUP_TIME_BUDGET_MILLIS = 20000L;

  private final BBaskStreamService service;
  private final BaskStreamAuthorizer authorizer;

  BaskStreamHistoryResolver(BBaskStreamService service)
  {
    this.service = service;
    this.authorizer = new BaskStreamAuthorizer(service);
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

    List<Object> histories = new ArrayList<Object>();
    for (Source source : readableHistories(candidate, context))
    {
      histories.add(readSingleHistory(source.history, source.ext, start, end, limit, context));
    }

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
      if (!(object instanceof BIHistory))
      {
        throw new BaskStreamProtocolException("invalid_point", "Resolved target is not a Niagara history.");
      }
      ensureDirectHistoryAllowed((BIHistory) object);

      List<Object> histories = new ArrayList<Object>(1);
      histories.add(describeSingleHistory((BIHistory) object, null, context));
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
      if (history != null && !authorizer.canReadHistory(history, context))
      {
        continue;
      }
      if (history != null)
      {
        histories.add(describeSingleHistory(history, historyExts[i], context));
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

  /** A history the user may read and, when reached through a point, the extension that records it. */
  private static final class Source
  {
    final BIHistory history;
    final BHistoryExt ext;

    Source(BIHistory history, BHistoryExt ext)
    {
      this.history = history;
      this.ext = ext;
    }
  }

  /**
   * The histories behind a history: ORD or a point's history extensions, with every access check
   * in one place so reads and rollups cannot drift apart.
   */
  private List<Source> readableHistories(String ord, Context context) throws BaskStreamProtocolException
  {
    List<Source> sources = new ArrayList<Source>();
    if (ord.startsWith("history:"))
    {
      try
      {
        OrdTarget target = BOrd.make(ord).resolve(service, context);
        if (!target.canRead())
        {
          throw new BaskStreamProtocolException("forbidden_point", "History is not readable for the authenticated user.");
        }
        BObject object = target.get();
        if (!(object instanceof BIHistory))
        {
          throw new BaskStreamProtocolException("invalid_point", "Resolved target is not a Niagara history.");
        }
        ensureDirectHistoryAllowed((BIHistory) object);
        sources.add(new Source((BIHistory) object, null));
        return sources;
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
    for (int i = 0; i < historyExts.length; i++)
    {
      BIHistory history = historyExts[i].getHistory();
      if (history != null && authorizer.canReadHistory(history, context))
      {
        sources.add(new Source(history, historyExts[i]));
      }
    }
    if (sources.isEmpty())
    {
      throw new BaskStreamProtocolException("history_failed", "Attached history extensions did not resolve to readable histories.");
    }
    return sources;
  }

  /**
   * Summarises records into fixed-width time buckets: count, min, max, sum, avg, first and last.
   * Numeric and boolean (as 0/1, so avg is the duty cycle) records are aggregated; other record
   * types report counts and the last value. Records whose status is not valid are skipped unless
   * includeInvalid is true.
   */
  Map<String, Object> rollupHistory(String ord, Object startValue, Object endValue, Object intervalValue,
      Object includeInvalidValue, Context context) throws BaskStreamProtocolException
  {
    String candidate = normalizeOrd(ord);
    long end = normalizeMillis(endValue, Clock.millis());
    long start = normalizeMillis(startValue, end - DEFAULT_WINDOW_MILLIS);
    if (start > end)
    {
      throw new BaskStreamProtocolException("bad_request", "History start must be less than or equal to end.");
    }
    if (!(intervalValue instanceof Number) || ((Number) intervalValue).longValue() < 1000L)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'interval' is required: bucket width in milliseconds, at least 1000.");
    }
    long interval = ((Number) intervalValue).longValue();
    long bucketCount = (end - start) / interval + 1;
    if (bucketCount > MAX_ROLLUP_BUCKETS)
    {
      throw new BaskStreamProtocolException("bad_request", "That range and interval make " + bucketCount
          + " buckets; the limit is " + MAX_ROLLUP_BUCKETS + ". Use a larger interval or a shorter range.");
    }
    if (includeInvalidValue != null && !(includeInvalidValue instanceof Boolean))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'includeInvalid' must be a boolean.");
    }
    boolean includeInvalid = Boolean.TRUE.equals(includeInvalidValue);

    List<Object> histories = new ArrayList<Object>();
    for (Source source : readableHistories(candidate, context))
    {
      histories.add(rollupSingleHistory(source.history, start, end, interval, includeInvalid, context));
    }

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("requestOrd", candidate);
    result.put("start", Long.valueOf(start));
    result.put("end", Long.valueOf(end));
    result.put("interval", Long.valueOf(interval));
    result.put("includeInvalid", Boolean.valueOf(includeInvalid));
    result.put("histories", histories);
    return result;
  }

  private Map<String, Object> rollupSingleHistory(BIHistory history, long start, long end, long interval,
      boolean includeInvalid, Context context) throws BaskStreamProtocolException
  {
    java.util.TreeMap<Long, Bucket> buckets = new java.util.TreeMap<Long, Bucket>();
    long examined = 0L;
    long skipped = 0L;
    String truncatedReason = null;
    long deadline = System.currentTimeMillis() + ROLLUP_TIME_BUDGET_MILLIS;
    HistorySpaceConnection connection = null;
    Cursor<BHistoryRecord> cursor = null;
    try
    {
      connection = openConnection(context);
      cursor = connection.timeQuery(history, BAbsTime.make(start), BAbsTime.make(end)).cursor();
      while (cursor.next())
      {
        if (++examined > MAX_ROLLUP_RECORDS) { truncatedReason = "record_limit"; break; }
        if ((examined & 1023L) == 0L && System.currentTimeMillis() > deadline) { truncatedReason = "time_limit"; break; }
        BHistoryRecord record = cursor.get();
        BStatus status = record instanceof BTrendRecord ? ((BTrendRecord) record).getStatus() : null;
        if (!includeInvalid && status != null && !status.isValid())
        {
          skipped++;
          continue;
        }
        long time = record.getTimestamp().getMillis();
        Long key = Long.valueOf(start + ((time - start) / interval) * interval);
        Bucket bucket = buckets.get(key);
        if (bucket == null)
        {
          bucket = new Bucket();
          buckets.put(key, bucket);
        }
        bucket.add(numericValue(record), lastValue(record, context));
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
      if (connection != null)
      {
        connection.close();
      }
    }

    List<Object> rows = new ArrayList<Object>(buckets.size());
    for (Map.Entry<Long, Bucket> entry : buckets.entrySet())
    {
      rows.add(entry.getValue().toWire(entry.getKey().longValue()));
    }
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("historyOrd", history.getNavOrd() == null ? history.getOrdInSpace().toString() : history.getNavOrd().toString());
    wire.put("historyId", history.getId() == null ? null : history.getId().toString());
    wire.put("recordType", history.getRecordType().toString());
    wire.put("buckets", rows);
    wire.put("bucketCount", Long.valueOf(rows.size()));
    wire.put("examined", Long.valueOf(Math.min(examined, MAX_ROLLUP_RECORDS)));
    wire.put("skippedInvalid", Long.valueOf(skipped));
    wire.put("truncated", Boolean.valueOf(truncatedReason != null));
    if (truncatedReason != null)
    {
      wire.put("truncatedReason", truncatedReason);
    }
    return wire;
  }

  /** The record's value as a number for aggregation, or null when it has none. */
  private static Double numericValue(BHistoryRecord record)
  {
    if (record instanceof javax.baja.history.BNumericTrendRecord)
    {
      double value = ((javax.baja.history.BNumericTrendRecord) record).getValue();
      return Double.isNaN(value) || Double.isInfinite(value) ? null : Double.valueOf(value);
    }
    if (record instanceof javax.baja.history.BBooleanTrendRecord)
    {
      return Double.valueOf(((javax.baja.history.BBooleanTrendRecord) record).getValue() ? 1.0 : 0.0);
    }
    return null;
  }

  /** The value to report as first/last for records that are not aggregated numerically. */
  private static Object lastValue(BHistoryRecord record, Context context)
  {
    if (record instanceof javax.baja.history.BEnumTrendRecord)
    {
      javax.baja.history.BEnumTrendRecord en = (javax.baja.history.BEnumTrendRecord) record;
      return en.getValue() == null ? null : en.getValue().toString(context);
    }
    if (record instanceof javax.baja.history.BStringTrendRecord)
    {
      return ((javax.baja.history.BStringTrendRecord) record).getValue();
    }
    return null;
  }

  private static final class Bucket
  {
    long count;
    long numericCount;
    double min = Double.POSITIVE_INFINITY;
    double max = Double.NEGATIVE_INFINITY;
    double sum;
    Object first;
    Object last;
    boolean hasFirst;

    void add(Double numeric, Object other)
    {
      count++;
      Object value = numeric != null ? numeric : other;
      if (!hasFirst)
      {
        first = value;
        hasFirst = true;
      }
      last = value;
      if (numeric != null)
      {
        numericCount++;
        double v = numeric.doubleValue();
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
      }
    }

    Map<String, Object> toWire(long bucketStart)
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("start", Long.valueOf(bucketStart));
      wire.put("count", Long.valueOf(count));
      if (numericCount > 0)
      {
        wire.put("min", Double.valueOf(min));
        wire.put("max", Double.valueOf(max));
        wire.put("sum", Double.valueOf(sum));
        wire.put("avg", Double.valueOf(sum / numericCount));
      }
      wire.put("first", first);
      wire.put("last", last);
      return wire;
    }
  }

  private void ensureDirectHistoryAllowed(BIHistory history) throws BaskStreamProtocolException
  {
    if (BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      return;
    }

    // An imported history's source is on another station, so it never matches a local path.
    BHistoryConfig config = history.getConfig();
    BOrdList sources = config == null ? null : config.getSource();
    for (int i = 0; sources != null && i < sources.size(); i++)
    {
      String slotOrd = sources.get(i) == null ? null : BaskStreamAccessPolicy.localSlotOrd(sources.get(i).toString());
      if (slotOrd != null && BaskStreamAccessPolicy.isAllowed(service, slotOrd))
      {
        return;
      }
    }
    throw new BaskStreamProtocolException("forbidden_point",
        "History source is outside the allowedPathPatterns policy.");
  }

  private Map<String, Object> readSingleHistory(BIHistory history, BHistoryExt historyExt, long start, long end, int limit,
      Context context) throws BaskStreamProtocolException
  {
    Map<String, Object> wire = describeSingleHistory(history, historyExt, context);

    List<Object> records = new ArrayList<Object>();
    BAbsTime startTime = BAbsTime.make(start);
    BAbsTime endTime = BAbsTime.make(end);

    boolean truncated = false;
    HistorySpaceConnection connection = null;
    Cursor<BHistoryRecord> cursor = null;
    try
    {
      connection = openConnection(context);
      cursor = connection.timeQuery(history, startTime, endTime).cursor();
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
      if (connection != null)
      {
        connection.close();
      }
    }

    wire.put("records", records);
    wire.put("truncated", Boolean.valueOf(truncated));
    wire.put("count", Long.valueOf(records.size()));
    wire.put("start", Long.valueOf(start));
    wire.put("end", Long.valueOf(end));
    return wire;
  }

  private Map<String, Object> describeSingleHistory(BIHistory history, BHistoryExt historyExt, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("historyOrd", history.getNavOrd() == null ? history.getOrdInSpace().toString() : history.getNavOrd().toString());
    wire.put("historyId", history.getId() == null ? null : history.getId().toString());
    wire.put("display", history.getNavDisplayName(context));
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

  private void appendHistorySummary(Map<String, Object> wire, BIHistory history, Context context)
  {
    HistorySpaceConnection connection = null;
    try
    {
      connection = openConnection(context);
      BAbsTime first = connection.getFirstTimestamp(history);
      BAbsTime last = connection.getLastTimestamp(history);
      BHistoryRecord lastRecord = connection.getLastRecord(history);
      wire.put("totalCount", Long.valueOf(connection.getRecordCount(history)));
      wire.put("firstTimestamp", first == null ? null : Long.valueOf(first.getMillis()));
      wire.put("lastTimestamp", last == null ? null : Long.valueOf(last.getMillis()));
      wire.put("lastRecord", lastRecord == null ? null : toWire(lastRecord, context));
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

  /** A connection to the station's history database: the public route to history records. */
  private static HistorySpaceConnection openConnection(Context context)
  {
    BHistoryService historyService = (BHistoryService) Sys.getService(BHistoryService.TYPE);
    return historyService.getDatabase().getConnection(context);
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
