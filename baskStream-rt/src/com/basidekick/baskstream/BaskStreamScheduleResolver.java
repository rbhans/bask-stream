package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.schedule.BAbstractSchedule;
import javax.baja.schedule.BCompositeSchedule;
import javax.baja.schedule.BControlSchedule;
import javax.baja.schedule.BDailySchedule;
import javax.baja.schedule.BDateRangeSchedule;
import javax.baja.schedule.BDateSchedule;
import javax.baja.schedule.BDaySchedule;
import javax.baja.schedule.BTimeSchedule;
import javax.baja.schedule.BWeekSchedule;
import javax.baja.schedule.BWeeklySchedule;
import javax.baja.status.BIStatusValue;
import javax.baja.status.BStatus;
import javax.baja.status.BStatusBoolean;
import javax.baja.status.BStatusEnum;
import javax.baja.status.BStatusNumeric;
import javax.baja.status.BStatusString;
import javax.baja.status.BStatusValue;
import javax.baja.sys.BDynamicEnum;
import javax.baja.sys.BEnumRange;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BBoolean;
import javax.baja.sys.BComplex;
import javax.baja.sys.BNumber;
import javax.baja.sys.BObject;
import javax.baja.sys.BSimple;
import javax.baja.sys.BString;
import javax.baja.sys.BTime;
import javax.baja.sys.BValue;
import javax.baja.sys.BWeekday;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;

final class BaskStreamScheduleResolver
{
  private static final long DAY_MILLIS = 24L * 60L * 60L * 1000L;
  private static final int MAX_EVENTS = 1000;
  private static final int MAX_ENTRIES_PER_DAY = 48;

  private final BBaskStreamService service;

  BaskStreamScheduleResolver(BBaskStreamService service)
  {
    this.service = service;
  }

  Map<String, Object> readSchedule(String ord, Object atValue, Context context) throws BaskStreamProtocolException
  {
    long at = normalizeMillis(atValue, Clock.millis());
    Resolved resolved = resolveSchedule(ord, context, false);
    return toWire(resolved.schedule, resolved.target, BAbsTime.make(at), context);
  }

  private static final class Resolved
  {
    final BAbstractSchedule schedule;
    final OrdTarget target;

    Resolved(BAbstractSchedule schedule, OrdTarget target)
    {
      this.schedule = schedule;
      this.target = target;
    }
  }

  /** Path policy, read (and optionally write) permission, and the schedule behind the ORD. */
  private Resolved resolveSchedule(String ord, Context context, boolean write) throws BaskStreamProtocolException
  {
    String candidate = normalizeOrd(ord);
    if (!BaskStreamAccessPolicy.isAllowed(service, candidate))
    {
      throw new BaskStreamProtocolException("forbidden_point", "Schedule is outside the allowedPathPatterns policy.");
    }
    try
    {
      OrdTarget target = BOrd.make(candidate).resolve(service, context);
      if (!target.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_point", "Schedule is not readable for the authenticated user.");
      }
      if (write && !target.canWrite())
      {
        throw new BaskStreamProtocolException("forbidden_point", "Schedule is not writable for the authenticated user.");
      }
      BObject object = target.get();
      BAbstractSchedule schedule = object instanceof BAbstractSchedule
          ? (BAbstractSchedule) object
          : (target.getComponent() instanceof BAbstractSchedule ? (BAbstractSchedule) target.getComponent() : null);
      if (schedule == null)
      {
        throw new BaskStreamProtocolException("invalid_point", "Resolved target is not a Niagara schedule.");
      }
      return new Resolved(schedule, target);
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("schedule_failed",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  /**
   * The times the schedule's output may change within [start, end], each with the output from
   * that moment. The first entry is the output at start.
   */
  Map<String, Object> readScheduleEvents(String ord, Object startValue, Object endValue, Object limitValue,
      Context context) throws BaskStreamProtocolException
  {
    long start = normalizeMillis(startValue, Clock.millis());
    long end = normalizeMillis(endValue, start + 7L * DAY_MILLIS);
    if (end < start || end - start > 366L * DAY_MILLIS)
    {
      throw new BaskStreamProtocolException("bad_request", "Use an end after start, at most 366 days later.");
    }
    int limit = limitValue instanceof Number ? Math.max(1, Math.min(MAX_EVENTS, ((Number) limitValue).intValue())) : 100;
    Resolved resolved = resolveSchedule(ord, context, false);
    BAbstractSchedule schedule = resolved.schedule;

    List<Object> events = new ArrayList<Object>();
    events.add(eventAt(schedule, BAbsTime.make(start), context));
    boolean truncated = false;
    BAbsTime cursor = BAbsTime.make(start);
    while (true)
    {
      BAbsTime next = schedule.nextEvent(cursor);
      if (next == null || next.getMillis() > end || next.getMillis() <= cursor.getMillis())
      {
        break;
      }
      if (events.size() >= limit)
      {
        truncated = true;
        break;
      }
      events.add(eventAt(schedule, next, context));
      cursor = next;
    }

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("ord", resolved.target.getOrd().toString());
    result.put("start", Long.valueOf(start));
    result.put("end", Long.valueOf(end));
    result.put("events", events);
    result.put("count", Long.valueOf(events.size()));
    result.put("truncated", Boolean.valueOf(truncated));
    return result;
  }

  private Map<String, Object> eventAt(BAbstractSchedule schedule, BAbsTime at, Context context)
  {
    Map<String, Object> event = new LinkedHashMap<String, Object>();
    event.put("time", Long.valueOf(at.getMillis()));
    BObject output = schedule instanceof BControlSchedule ? ((BControlSchedule) schedule).getOutput(at) : null;
    event.put("value", output == null ? null : valueToWire(output, context));
    return event;
  }

  /**
   * Replaces the entries of the given weekdays on a weekly schedule. The change is built on a copy,
   * checked for overlaps, and applied with auditableCopyFrom, the path Niagara's own scheduler uses,
   * so it is recorded in the station's audit history. dryRun returns the before/after without applying.
   */
  Map<String, Object> writeSchedule(String ord, Object daysValue, Object dryRunValue, Context context)
      throws BaskStreamProtocolException
  {
    if (!(daysValue instanceof Map) || ((Map<?, ?>) daysValue).isEmpty())
    {
      throw new BaskStreamProtocolException("bad_request",
          "Field 'days' is required: an object such as {\"monday\": [{\"start\": \"07:00\", \"finish\": \"18:00\", \"value\": true}]}.");
    }
    if (dryRunValue != null && !(dryRunValue instanceof Boolean))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'dryRun' must be a boolean.");
    }
    boolean dryRun = Boolean.TRUE.equals(dryRunValue);
    Resolved resolved = resolveSchedule(ord, context, true);
    if (!(resolved.schedule instanceof BWeeklySchedule))
    {
      throw new BaskStreamProtocolException("invalid_point", "write_schedule supports weekly schedules only.");
    }
    BWeeklySchedule schedule = (BWeeklySchedule) resolved.schedule;
    BStatusValue template = schedule instanceof BControlSchedule ? ((BControlSchedule) schedule).getDefaultOutput() : null;
    BWeeklySchedule copy = (BWeeklySchedule) schedule.newCopy();

    Map<String, Object> days = new LinkedHashMap<String, Object>();
    for (Map.Entry<?, ?> entry : ((Map<?, ?>) daysValue).entrySet())
    {
      String dayName = String.valueOf(entry.getKey()).toLowerCase(java.util.Locale.ROOT);
      BWeekday weekday;
      try
      {
        weekday = BWeekday.make(dayName);
      }
      catch (Exception e)
      {
        throw new BaskStreamProtocolException("bad_request", "Unknown day '" + entry.getKey() + "'; use sunday to saturday.");
      }
      if (!(entry.getValue() instanceof List))
      {
        throw new BaskStreamProtocolException("bad_request", "Day '" + dayName + "' must be a list of entries.");
      }
      List<?> entries = (List<?>) entry.getValue();
      if (entries.size() > MAX_ENTRIES_PER_DAY)
      {
        throw new BaskStreamProtocolException("bad_request", "At most " + MAX_ENTRIES_PER_DAY + " entries per day.");
      }
      BDaySchedule before = schedule.getWeek().get(weekday);
      BDaySchedule day = copy.getWeek().get(weekday);
      List<Object> beforeWire = dayToWire(before, context);
      day.clear();
      for (Object raw : entries)
      {
        if (!(raw instanceof Map))
        {
          throw new BaskStreamProtocolException("bad_request", "Each entry needs start, finish and value.");
        }
        Map<?, ?> item = (Map<?, ?>) raw;
        BTime start = parseTime(item.get("start"), "start");
        BTime finish = parseTime(item.get("finish"), "finish");
        BStatusValue value = toStatusValue(template, item.get("value"));
        if (!day.add(start, finish, value))
        {
          throw new BaskStreamProtocolException("bad_request",
              "Entry " + item.get("start") + "-" + item.get("finish") + " on " + dayName + " overlaps another entry.");
        }
      }
      Map<String, Object> change = new LinkedHashMap<String, Object>();
      change.put("before", beforeWire);
      change.put("after", dayToWire(day, context));
      days.put(dayName, change);
    }

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("ord", resolved.target.getOrd().toString());
    result.put("days", days);
    if (dryRun)
    {
      result.put("dryRun", Boolean.TRUE);
      return result;
    }
    service.requireWritesEnabled();
    boolean changed = schedule.auditableCopyFrom(copy, context);
    result.put("applied", Boolean.TRUE);
    result.put("changed", Boolean.valueOf(changed));
    return result;
  }

  /** "HH:MM" or "HH:MM:SS"; "24:00" means the end of the day. */
  private static BTime parseTime(Object value, String field) throws BaskStreamProtocolException
  {
    if (!(value instanceof String) || !((String) value).matches("\\d{1,2}:\\d{2}(:\\d{2})?"))
    {
      throw new BaskStreamProtocolException("bad_request", "Entry '" + field + "' must be a time such as \"07:30\".");
    }
    String[] parts = ((String) value).split(":");
    int hour = Integer.parseInt(parts[0]);
    int minute = Integer.parseInt(parts[1]);
    int second = parts.length > 2 ? Integer.parseInt(parts[2]) : 0;
    if (hour == 24 && minute == 0 && second == 0)
    {
      return BTime.make(0, 0, 0);
    }
    if (hour > 23 || minute > 59 || second > 59)
    {
      throw new BaskStreamProtocolException("bad_request", "Entry '" + field + "' is not a valid time: " + value);
    }
    return BTime.make(hour, minute, second);
  }

  /** Builds the entry value in the schedule's own output type. */
  private static BStatusValue toStatusValue(BStatusValue template, Object value) throws BaskStreamProtocolException
  {
    if (template instanceof BStatusBoolean)
    {
      if (!(value instanceof Boolean)) throw new BaskStreamProtocolException("bad_request", "This is a boolean schedule; value must be true or false.");
      return new BStatusBoolean(((Boolean) value).booleanValue());
    }
    if (template instanceof BStatusNumeric)
    {
      if (!(value instanceof Number)) throw new BaskStreamProtocolException("bad_request", "This is a numeric schedule; value must be a number.");
      return new BStatusNumeric(((Number) value).doubleValue());
    }
    if (template instanceof BStatusEnum)
    {
      BEnumRange range = ((BStatusEnum) template).getValue().getRange();
      if (value instanceof Number) return new BStatusEnum(BDynamicEnum.make(((Number) value).intValue(), range));
      if (value instanceof String && range.isTag((String) value)) return new BStatusEnum(BDynamicEnum.make(range.tagToOrdinal((String) value), range));
      throw new BaskStreamProtocolException("bad_request", "This is an enum schedule; value must be an ordinal or one of its tags.");
    }
    if (template instanceof BStatusString)
    {
      if (value == null) throw new BaskStreamProtocolException("bad_request", "Entry value is required.");
      return new BStatusString(String.valueOf(value));
    }
    throw new BaskStreamProtocolException("invalid_point", "This schedule's output type is not supported for editing.");
  }

  private Map<String, Object> toWire(BAbstractSchedule schedule, OrdTarget target, BAbsTime at, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("ord", target.getOrd().toString());
    wire.put("slotPath", target.getComponent() == null || target.getComponent().getSlotPath() == null
        ? null
        : target.getComponent().getSlotPath().toString());
    wire.put("name", target.getComponent() == null ? schedule.getType().toString() : target.getComponent().getName());
    wire.put("display", target.getComponent() == null ? schedule.toString(context) : target.getComponent().getDisplayName(context));
    wire.put("description", schedule.toString(context));
    wire.put("typeSpec", schedule.getType().toString());
    wire.put("kind", "schedule");
    wire.put("at", Long.valueOf(at.getMillis()));
    wire.put("alwaysEffective", Boolean.valueOf(schedule.getAlwaysEffective()));
    wire.put("effectiveValue", valueToWire(schedule.getEffectiveValue(), context));
    wire.put("effectiveNow", Boolean.valueOf(schedule.isEffective(at)));
    wire.put("nextEvent", schedule.nextEvent(at) == null ? null : Long.valueOf(schedule.nextEvent(at).getMillis()));
    wire.put("tree", scheduleTree(schedule, at, context));

    if (schedule instanceof BControlSchedule)
    {
      BControlSchedule control = (BControlSchedule) schedule;
      wire.put("status", control.getStatus().toString(context));
      wire.put("defaultOutput", valueToWire(control.getDefaultOutput(), context));
      wire.put("currentOutput", valueToWire(control.getOutput(at), context));
      wire.put("lastModified", control.getLastModified() == null ? null : Long.valueOf(control.getLastModified().getMillis()));

      BAbstractSchedule outputSource = control.getOutputSource(at);
      if (outputSource != null)
      {
        Map<String, Object> outputSourceWire = new LinkedHashMap<String, Object>();
        outputSourceWire.put("typeSpec", outputSource.getType().toString());
        outputSourceWire.put("display", outputSource.toString(context));
        outputSourceWire.put("name", outputSource.getName());
        wire.put("outputSource", outputSourceWire);
      }
    }

    return wire;
  }

  private Map<String, Object> scheduleTree(BAbstractSchedule schedule, BAbsTime at, Context context)
  {
    Map<String, Object> tree = new LinkedHashMap<String, Object>();
    tree.put("typeSpec", schedule.getType().toString());
    tree.put("name", schedule.getName());
    tree.put("display", schedule.toString(context));
    tree.put("alwaysEffective", Boolean.valueOf(schedule.getAlwaysEffective()));
    tree.put("effectiveNow", Boolean.valueOf(schedule.isEffective(at)));
    tree.put("effectiveValue", valueToWire(schedule.getEffectiveValue(), context));

    if (schedule instanceof BWeeklySchedule)
    {
      BWeeklySchedule weekly = (BWeeklySchedule) schedule;
      tree.put("effectiveRange", dateRangeToWire(weekly.getEffective(), context));
      tree.put("week", weekToWire(weekly.getWeek(), at, context));
      tree.put("specialEvents", dailySchedulesToWire(weekly.getSpecialEventsChildren(), at, context));
      tree.put("summary", weekly.getSummary(weekly, context));
    }
    else if (schedule instanceof BWeekSchedule)
    {
      tree.put("week", weekToWire((BWeekSchedule) schedule, at, context));
    }
    else if (schedule instanceof BDailySchedule)
    {
      BDailySchedule daily = (BDailySchedule) schedule;
      tree.put("day", dayToWire(daily.getDay(), context));
      if (daily.getDays() != null)
      {
        tree.put("days", scheduleTree(daily.getDays(), at, context));
      }
    }
    else if (schedule instanceof BDaySchedule)
    {
      tree.put("entries", dayToWire((BDaySchedule) schedule, context));
    }
    else if (schedule instanceof BTimeSchedule)
    {
      tree.put("entry", timeToWire((BTimeSchedule) schedule, context));
    }
    else if (schedule instanceof BDateRangeSchedule)
    {
      tree.put("range", dateRangeToWire((BDateRangeSchedule) schedule, context));
    }
    else if (schedule instanceof BDateSchedule)
    {
      tree.put("date", schedule.toString(context));
    }

    if (schedule instanceof BCompositeSchedule)
    {
      BAbstractSchedule[] children = ((BCompositeSchedule) schedule).getSchedules();
      if (children != null && children.length > 0)
      {
        List<Object> childWires = new ArrayList<Object>(children.length);
        for (int i = 0; i < children.length; i++)
        {
          childWires.add(scheduleTree(children[i], at, context));
        }
        tree.put("children", childWires);
      }
    }

    return tree;
  }

  private Map<String, Object> weekToWire(BWeekSchedule week, BAbsTime at, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    if (week == null)
    {
      return wire;
    }

    BWeekday[] days = BWeekSchedule.daysInOrder(context);
    BDailySchedule[] schedules = week.schedulesInOrder(context);
    for (int i = 0; i < days.length && i < schedules.length; i++)
    {
      BWeekday day = days[i];
      BDailySchedule daily = schedules[i];
      wire.put(day.getTag(), dailyToWire(daily, at, context));
    }
    return wire;
  }

  private List<Object> dailySchedulesToWire(BDailySchedule[] schedules, BAbsTime at, Context context)
  {
    List<Object> wire = new ArrayList<Object>();
    if (schedules == null)
    {
      return wire;
    }

    for (int i = 0; i < schedules.length; i++)
    {
      wire.add(dailyToWire(schedules[i], at, context));
    }
    return wire;
  }

  private Map<String, Object> dailyToWire(BDailySchedule daily, BAbsTime at, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    if (daily == null)
    {
      return wire;
    }

    wire.put("name", daily.getName());
    wire.put("display", daily.toString(context));
    wire.put("effectiveNow", Boolean.valueOf(daily.isEffective(at)));
    wire.put("day", dayToWire(daily.getDay(), context));
    if (daily.getDays() != null)
    {
      wire.put("days", scheduleTree(daily.getDays(), at, context));
    }
    return wire;
  }

  private List<Object> dayToWire(BDaySchedule day, Context context)
  {
    List<Object> entries = new ArrayList<Object>();
    if (day == null)
    {
      return entries;
    }

    BTimeSchedule[] times = day.getTimesInOrder();
    for (int i = 0; i < times.length; i++)
    {
      entries.add(timeToWire(times[i], context));
    }
    return entries;
  }

  private Map<String, Object> timeToWire(BTimeSchedule time, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("start", time.getStart() == null ? null : formatTime(time.getStart(), context));
    wire.put("finish", time.getFinish() == null ? null : formatTime(time.getFinish(), context));
    wire.put("effectiveValue", valueToWire(time.getEffectiveValue(), context));
    wire.put("display", time.toString(context));
    return wire;
  }

  private Map<String, Object> dateRangeToWire(BDateRangeSchedule range, Context context)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    if (range == null)
    {
      return wire;
    }

    wire.put("start", range.getStart() == null ? null : range.getStart().toString(context));
    wire.put("end", range.getEnd() == null ? null : range.getEnd().toString(context));
    wire.put("display", range.toString(context));
    return wire;
  }

  private Map<String, Object> valueToWire(BObject source, Context context)
  {
    if (source == null)
    {
      return null;
    }

    String status = BStatus.ok.toString(context);
    boolean ok = true;
    Object wireValue = null;
    String displayValue = null;
    String valueType = source.getType().toString();

    if (source instanceof BIStatusValue)
    {
      BStatusValue statusValue = ((BIStatusValue) source).getStatusValue();
      status = statusValue.getStatus().toString(context);
      ok = statusValue.getStatus().isOk();
      source = statusValue.getValueValue();
      valueType = source.getType().toString();
    }

    if (source instanceof BBoolean)
    {
      wireValue = Boolean.valueOf(((BBoolean) source).getBoolean());
    }
    else if (source instanceof BNumber)
    {
      wireValue = Double.valueOf(((BNumber) source).getDouble());
    }
    else if (source instanceof BString)
    {
      wireValue = ((BString) source).getString();
    }
    else if (source instanceof BSimple)
    {
      wireValue = source.toString(context);
    }
    else if (source instanceof BValue)
    {
      wireValue = source.toString(context);
    }

    displayValue = source.toString(context);

    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("ok", Boolean.valueOf(ok));
    wire.put("valueType", valueType);
    wire.put("value", wireValue);
    wire.put("displayValue", displayValue);
    wire.put("status", status);
    return wire;
  }

  private static String formatTime(BTime time, Context context)
  {
    return time == null ? null : time.toString(context);
  }

  private String normalizeOrd(String ord) throws BaskStreamProtocolException
  {
    if (ord == null || ord.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'ord' is required for read_schedule.");
    }

    String candidate = ord.trim();
    if (!candidate.startsWith("slot:/"))
    {
      throw new BaskStreamProtocolException("invalid_point", "read_schedule supports slot:/ ords only.");
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
      throw new BaskStreamProtocolException("bad_request", "Schedule time fields must be epoch milliseconds.");
    }
    return ((Number) value).longValue();
  }
}
