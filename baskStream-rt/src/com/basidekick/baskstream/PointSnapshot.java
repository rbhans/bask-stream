package com.basidekick.baskstream;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class PointSnapshot
{
  private final String pointOrd;
  private final String displayName;
  private final String valueType;
  private final Object value;
  private final String displayValue;
  private final String status;
  private final boolean ok;
  private final long timestamp;
  private final Map<String, Object> extra;

  PointSnapshot(String pointOrd, String displayName, String valueType, Object value,
      String displayValue, String status, boolean ok, long timestamp)
  {
    this(pointOrd, displayName, valueType, value, displayValue, status, ok, timestamp, null);
  }

  PointSnapshot(String pointOrd, String displayName, String valueType, Object value,
      String displayValue, String status, boolean ok, long timestamp, Map<String, Object> extra)
  {
    this.pointOrd = pointOrd;
    this.displayName = displayName;
    this.valueType = valueType;
    this.value = value;
    this.displayValue = displayValue;
    this.status = status;
    this.ok = ok;
    this.timestamp = timestamp;
    this.extra = extra;
  }

  Map<String, Object> toWire()
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("point", pointOrd);
    wire.put("ok", Boolean.valueOf(ok));
    wire.put("display", displayName);
    wire.put("valueType", valueType);
    wire.put("value", value);
    wire.put("displayValue", displayValue);
    wire.put("status", status);
    wire.put("timestamp", Long.valueOf(timestamp));
    if (extra != null)
    {
      wire.putAll(extra);
    }
    return wire;
  }

  Map<String, Object> toWire(List<String> fields)
  {
    Map<String, Object> full = toWire();
    if (fields == null || fields.isEmpty())
    {
      return full;
    }

    Map<String, Object> filtered = new LinkedHashMap<String, Object>();
    filtered.put("point", pointOrd);
    filtered.put("ok", Boolean.valueOf(ok));
    for (String field : fields)
    {
      if ("point".equals(field) || "ok".equals(field))
      {
        continue;
      }
      if ("type".equals(field))
      {
        filtered.put("type", valueType);
        continue;
      }
      if (full.containsKey(field))
      {
        filtered.put(field, full.get(field));
      }
    }
    return filtered;
  }
}
