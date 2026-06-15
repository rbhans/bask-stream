package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.control.BBooleanWritable;
import javax.baja.control.BEnumWritable;
import javax.baja.control.BIWritablePoint;
import javax.baja.control.BNumericWritable;
import javax.baja.control.BStringWritable;
import javax.baja.control.enums.BPriorityLevel;
import javax.baja.control.util.BEnumOverride;
import javax.baja.control.util.BNumericOverride;
import javax.baja.control.util.BOverride;
import javax.baja.control.util.BStringOverride;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.Action;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BBoolean;
import javax.baja.sys.BComponent;
import javax.baja.sys.BDouble;
import javax.baja.sys.BDynamicEnum;
import javax.baja.sys.BEnum;
import javax.baja.sys.BEnumRange;
import javax.baja.sys.BFacets;
import javax.baja.sys.BNumber;
import javax.baja.sys.BObject;
import javax.baja.sys.BRelTime;
import javax.baja.sys.BString;
import javax.baja.sys.BValue;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Property;
import javax.baja.status.BIStatusValue;
import javax.baja.status.BStatusValue;

final class BaskStreamWriteResolver
{
  private static final int MAX_WRITE_POINTS_PER_REQUEST = 1000;

  private final BBaskStreamService service;
  private final BaskStreamPointResolver pointResolver;

  BaskStreamWriteResolver(BBaskStreamService service, BaskStreamPointResolver pointResolver)
  {
    this.service = service;
    this.pointResolver = pointResolver;
  }

  List<Object> write(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    List<Map<String, Object>> specs = normalizeSpecs(request);
    List<Object> results = new ArrayList<Object>(specs.size());
    for (Map<String, Object> spec : specs)
    {
      String pointOrd = optionalString(spec, "point");
      if (pointOrd == null || pointOrd.trim().length() == 0)
      {
        pointOrd = optionalString(spec, "ord");
      }

      try
      {
        results.add(writeOne(pointOrd, spec, context));
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(pointOrd, e.getCode(), e.getMessage()));
      }
    }
    return results;
  }

  List<Object> describe(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    List<String> points = normalizeDescribePoints(request);
    List<Object> results = new ArrayList<Object>(points.size());
    for (String pointOrd : points)
    {
      try
      {
        results.add(describeOne(pointOrd, context));
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(pointOrd, e.getCode(), e.getMessage()));
      }
    }
    return results;
  }

  private Map<String, Object> describeOne(String pointOrd, Context context) throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint point = pointResolver.resolve(pointOrd, context);
    OrdTarget target = point.getTarget();
    BComponent component = writableComponentOrComponent(target);

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("point", pointOrd);
    result.put("ok", Boolean.TRUE);
    result.put("display", point.getDisplayName());
    result.put("typeSpec", component == null ? null : component.getType().toString());
    result.put("canInvoke", Boolean.valueOf(target.canInvoke()));
    result.put("writable", Boolean.valueOf(component instanceof BIWritablePoint));
    result.put("valueKind", valueKind(component));
    result.put("actions", writeActions(component));
    result.put("supportsDuration", Boolean.valueOf(supportsAction(component, "override")
        || supportsAction(component, "active") || supportsAction(component, "inactive")));

    if (component instanceof BIWritablePoint)
    {
      BIWritablePoint writablePoint = (BIWritablePoint) component;
      result.put("activeLevel", enumSummary(writablePoint.getActiveLevel(), context));
      result.put("overrideExpiration", absTime(componentValue(component, "overrideExpiration"), context));
      result.put("fallback", statusValueSummary(componentValue(component, "fallback"), context));
      result.put("levels", priorityLevels(writablePoint, context));
    }
    if (component instanceof BEnumWritable)
    {
      result.put("enumOptions", enumOptions(enumRange((BEnumWritable) component), context));
    }
    return result;
  }

  private Map<String, Object> writeOne(String pointOrd, Map<String, Object> spec, Context context)
      throws BaskStreamProtocolException
  {
    BaskStreamPointResolver.ResolvedPoint point = pointResolver.resolve(pointOrd, context);
    OrdTarget target = point.getTarget();
    if (!target.canInvoke())
    {
      throw new BaskStreamProtocolException("forbidden_point", "Point actions are not invokable for the authenticated user.");
    }

    BComponent component = writableComponent(target);
    if (!(component instanceof BIWritablePoint))
    {
      throw new BaskStreamProtocolException("not_writable", "Resolved target is not a Niagara writable point.");
    }

    String requestedAction = normalizeAction(optionalString(spec, "action"));
    ActionInvocation invocation = buildInvocation(component, requestedAction, spec);
    component.invoke(invocation.action, invocation.parameter, context);

    Map<String, Object> result = snapshotAfterWrite(point, context).toWire();
    result.put("action", invocation.name);
    result.put("writable", Boolean.TRUE);
    result.put("activeLevel", activeLevel(component, context));
    result.put("writeTime", Long.valueOf(Clock.millis()));
    return result;
  }

  private PointSnapshot snapshotAfterWrite(BaskStreamPointResolver.ResolvedPoint point, Context context)
      throws BaskStreamProtocolException
  {
    try
    {
      Thread.sleep(150L);
    }
    catch (InterruptedException e)
    {
      Thread.currentThread().interrupt();
    }
    return pointResolver.snapshot(point, context);
  }

  private ActionInvocation buildInvocation(BComponent component, String actionName, Map<String, Object> spec)
      throws BaskStreamProtocolException
  {
    if ("auto".equals(actionName))
    {
      return noArg(component, "auto", actionName);
    }
    if ("emergency_auto".equals(actionName))
    {
      return noArg(component, "emergencyAuto", actionName);
    }

    if (component instanceof BBooleanWritable)
    {
      return booleanInvocation((BBooleanWritable) component, actionName, spec);
    }
    if (component instanceof BNumericWritable)
    {
      return numericInvocation((BNumericWritable) component, actionName, spec);
    }
    if (component instanceof BStringWritable)
    {
      return stringInvocation((BStringWritable) component, actionName, spec);
    }
    if (component instanceof BEnumWritable)
    {
      return enumInvocation((BEnumWritable) component, actionName, spec);
    }

    throw new BaskStreamProtocolException("not_writable", "Unsupported writable point type: " + component.getType());
  }

  private ActionInvocation numericInvocation(BNumericWritable point, String actionName, Map<String, Object> spec)
      throws BaskStreamProtocolException
  {
    double value = requireDouble(spec.get("value"));
    if ("set".equals(actionName))
    {
      return withParam(point, "set", actionName, BDouble.make(value));
    }
    if ("override".equals(actionName))
    {
      BRelTime duration = optionalDuration(spec);
      BNumericOverride override = duration == null ? new BNumericOverride(value) : new BNumericOverride(duration, value);
      return withParam(point, "override", actionName, override);
    }
    if ("emergency_override".equals(actionName))
    {
      return withParam(point, "emergencyOverride", actionName, BDouble.make(value));
    }
    throw unsupportedAction(actionName);
  }

  private ActionInvocation booleanInvocation(BBooleanWritable point, String actionName, Map<String, Object> spec)
      throws BaskStreamProtocolException
  {
    boolean value = requireBoolean(spec.get("value"));
    if ("set".equals(actionName))
    {
      return withParam(point, "set", actionName, BBoolean.make(value));
    }
    if ("override".equals(actionName))
    {
      BOverride override = new BOverride();
      BRelTime duration = optionalDuration(spec);
      if (duration != null)
      {
        override.setDuration(duration);
      }
      return withParam(point, value ? "active" : "inactive", actionName, override);
    }
    if ("emergency_override".equals(actionName))
    {
      return noArg(point, value ? "emergencyActive" : "emergencyInactive", actionName);
    }
    throw unsupportedAction(actionName);
  }

  private ActionInvocation stringInvocation(BStringWritable point, String actionName, Map<String, Object> spec)
      throws BaskStreamProtocolException
  {
    String value = requireStringValue(spec.get("value"));
    if ("set".equals(actionName))
    {
      return withParam(point, "set", actionName, BString.make(value));
    }
    if ("override".equals(actionName))
    {
      BRelTime duration = optionalDuration(spec);
      BStringOverride override = duration == null ? new BStringOverride(value) : new BStringOverride(duration, value);
      return withParam(point, "override", actionName, override);
    }
    if ("emergency_override".equals(actionName))
    {
      return withParam(point, "emergencyOverride", actionName, BString.make(value));
    }
    throw unsupportedAction(actionName);
  }

  private ActionInvocation enumInvocation(BEnumWritable point, String actionName, Map<String, Object> spec)
      throws BaskStreamProtocolException
  {
    BDynamicEnum value = requireEnum(point, spec.get("value"));
    if ("set".equals(actionName))
    {
      return withParam(point, "set", actionName, value);
    }
    if ("override".equals(actionName))
    {
      BRelTime duration = optionalDuration(spec);
      BEnumOverride override = duration == null ? new BEnumOverride(value) : new BEnumOverride(duration, value);
      return withParam(point, "override", actionName, override);
    }
    if ("emergency_override".equals(actionName))
    {
      return withParam(point, "emergencyOverride", actionName, value);
    }
    throw unsupportedAction(actionName);
  }

  private ActionInvocation noArg(BComponent component, String slotName, String wireName) throws BaskStreamProtocolException
  {
    Action action = requireAction(component, slotName);
    return new ActionInvocation(wireName, action, component.getActionParameterDefault(action));
  }

  private ActionInvocation withParam(BComponent component, String slotName, String wireName, BValue parameter)
      throws BaskStreamProtocolException
  {
    return new ActionInvocation(wireName, requireAction(component, slotName), parameter);
  }

  private Action requireAction(BComponent component, String slotName) throws BaskStreamProtocolException
  {
    Action action = component.getAction(slotName);
    if (action == null)
    {
      throw new BaskStreamProtocolException("unsupported_action",
          "Writable point does not support action '" + slotName + "'.");
    }
    return action;
  }

  private BComponent writableComponent(OrdTarget target) throws BaskStreamProtocolException
  {
    BObject object = target.get();
    if (object instanceof BComponent && ((BComponent) object) instanceof BIWritablePoint)
    {
      return (BComponent) object;
    }
    if (target.getComponent() instanceof BIWritablePoint)
    {
      return target.getComponent();
    }
    throw new BaskStreamProtocolException("not_writable", "Resolved target is not a Niagara writable point.");
  }

  private BComponent writableComponentOrComponent(OrdTarget target)
  {
    BObject object = target.get();
    if (object instanceof BComponent)
    {
      return (BComponent) object;
    }
    return target.getComponent();
  }

  private List<String> normalizeDescribePoints(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object rawPoints = request.get("points");
    if (rawPoints instanceof List)
    {
      List<?> rawList = (List<?>) rawPoints;
      requireMaxSize(rawList, "points");
      List<String> points = new ArrayList<String>(rawList.size());
      for (Object raw : rawList)
      {
        if (!(raw instanceof String))
        {
          throw new BaskStreamProtocolException("bad_request", "Field 'points' must be an array of point ORD strings.");
        }
        points.add((String) raw);
      }
      return points;
    }

    String pointOrd = optionalString(request, "point");
    if (pointOrd == null || pointOrd.trim().length() == 0)
    {
      pointOrd = optionalString(request, "ord");
    }
    if (pointOrd == null || pointOrd.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'point', 'ord', or 'points' is required.");
    }
    List<String> single = new ArrayList<String>(1);
    single.add(pointOrd);
    return single;
  }

  private String valueKind(BComponent component)
  {
    if (component instanceof BBooleanWritable)
    {
      return "boolean";
    }
    if (component instanceof BNumericWritable)
    {
      return "numeric";
    }
    if (component instanceof BEnumWritable)
    {
      return "enum";
    }
    if (component instanceof BStringWritable)
    {
      return "string";
    }
    return component == null ? null : component.getType().toString();
  }

  private List<Object> writeActions(BComponent component)
  {
    List<Object> actions = new ArrayList<Object>();
    if (component == null)
    {
      return actions;
    }
    if (supportsAction(component, "set"))
    {
      actions.add("set");
    }
    if (supportsAction(component, "override") || supportsAction(component, "active") || supportsAction(component, "inactive"))
    {
      actions.add("override");
    }
    if (supportsAction(component, "auto"))
    {
      actions.add("auto");
    }
    if (supportsAction(component, "emergencyOverride") || supportsAction(component, "emergencyActive") || supportsAction(component, "emergencyInactive"))
    {
      actions.add("emergency_override");
    }
    if (supportsAction(component, "emergencyAuto"))
    {
      actions.add("emergency_auto");
    }
    return actions;
  }

  private boolean supportsAction(BComponent component, String actionName)
  {
    if (component == null)
    {
      return false;
    }
    try
    {
      return component.getAction(actionName) != null;
    }
    catch (ClassCastException e)
    {
      return false;
    }
  }

  private List<Object> priorityLevels(BIWritablePoint writablePoint, Context context)
  {
    BPriorityLevel[] levels = new BPriorityLevel[] {
      BPriorityLevel.level_1,
      BPriorityLevel.level_2,
      BPriorityLevel.level_3,
      BPriorityLevel.level_4,
      BPriorityLevel.level_5,
      BPriorityLevel.level_6,
      BPriorityLevel.level_7,
      BPriorityLevel.level_8,
      BPriorityLevel.level_9,
      BPriorityLevel.level_10,
      BPriorityLevel.level_11,
      BPriorityLevel.level_12,
      BPriorityLevel.level_13,
      BPriorityLevel.level_14,
      BPriorityLevel.level_15,
      BPriorityLevel.level_16
    };

    List<Object> out = new ArrayList<Object>(levels.length);
    for (int i = 0; i < levels.length; i++)
    {
      BPriorityLevel level = levels[i];
      Map<String, Object> entry = new LinkedHashMap<String, Object>();
      entry.put("level", Long.valueOf(i + 1));
      entry.put("name", level.toString(context));
      Property property = writablePoint.getInProperty(level);
      entry.put("property", property == null ? null : property.getName());
      entry.put("input", statusValueSummary(writablePoint.getInStatusValue(level), context));
      out.add(entry);
    }
    return out;
  }

  private Map<String, Object> enumSummary(BEnum value, Context context)
  {
    if (value == null)
    {
      return null;
    }
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("ordinal", Long.valueOf(value.getOrdinal()));
    summary.put("tag", value.getTag());
    summary.put("display", value.getDisplayTag(context));
    return summary;
  }

  private Object absTime(BValue value, Context context)
  {
    if (value instanceof BAbsTime)
    {
      BAbsTime time = (BAbsTime) value;
      if (time.isNull())
      {
        return null;
      }
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("timestamp", Long.valueOf(time.getMillis()));
      wire.put("display", time.toString(context));
      return wire;
    }
    return value == null ? null : value.toString(context);
  }

  private BValue componentValue(BComponent component, String propertyName)
  {
    if (component == null)
    {
      return null;
    }
    Property property = component.getProperty(propertyName);
    if (property == null)
    {
      return null;
    }
    try
    {
      return component.get(property);
    }
    catch (Exception e)
    {
      return null;
    }
  }

  private Object statusValueSummary(Object value, Context context)
  {
    if (value == null)
    {
      return null;
    }
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    if (value instanceof BIStatusValue)
    {
      BStatusValue statusValue = ((BIStatusValue) value).getStatusValue();
      wire.put("status", statusValue.getStatus() == null ? null : statusValue.getStatus().toString(context));
      wire.put("ok", Boolean.valueOf(statusValue.getStatus() != null && statusValue.getStatus().isOk()));
      wire.put("value", simpleValue(statusValue.getValueValue(), context));
      wire.put("display", statusValue.toString(context));
      return wire;
    }
    if (value instanceof BValue)
    {
      wire.put("value", simpleValue((BValue) value, context));
      wire.put("display", ((BValue) value).toString(context));
      return wire;
    }
    wire.put("value", String.valueOf(value));
    return wire;
  }

  private Object simpleValue(BValue value, Context context)
  {
    if (value == null)
    {
      return null;
    }
    if (value instanceof BBoolean)
    {
      return Boolean.valueOf(((BBoolean) value).getBoolean());
    }
    if (value instanceof BNumber)
    {
      return Double.valueOf(((BNumber) value).getDouble());
    }
    if (value instanceof BString)
    {
      return ((BString) value).getString();
    }
    if (value instanceof BEnum)
    {
      return ((BEnum) value).getTag();
    }
    return value.toString(context);
  }

  private List<Object> enumOptions(BEnumRange range, Context context)
  {
    List<Object> options = new ArrayList<Object>();
    if (range == null || range.isNull())
    {
      return options;
    }
    int[] ordinals = range.getOrdinals();
    for (int i = 0; i < ordinals.length; i++)
    {
      Map<String, Object> option = new LinkedHashMap<String, Object>();
      option.put("ordinal", Long.valueOf(ordinals[i]));
      option.put("tag", range.getTag(ordinals[i]));
      option.put("display", range.getDisplayTag(ordinals[i], context));
      options.add(option);
    }
    return options;
  }

  private List<Map<String, Object>> normalizeSpecs(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object rawPoints = request.get("points");
    if (rawPoints == null)
    {
      List<Map<String, Object>> single = new ArrayList<Map<String, Object>>(1);
      single.add(request);
      return single;
    }
    if (!(rawPoints instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'points' must be an array of write objects.");
    }

    List<?> rawList = (List<?>) rawPoints;
    requireMaxSize(rawList, "points");
    List<Map<String, Object>> specs = new ArrayList<Map<String, Object>>(rawList.size());
    for (Object raw : rawList)
    {
      if (!(raw instanceof Map))
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'points' must be an array of write objects.");
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> spec = (Map<String, Object>) raw;
      specs.add(spec);
    }
    return specs;
  }

  private static String normalizeAction(String action)
  {
    if (action == null || action.trim().length() == 0)
    {
      return "set";
    }
    return action.trim().toLowerCase().replace('-', '_');
  }

  private BRelTime optionalDuration(Map<String, Object> spec) throws BaskStreamProtocolException
  {
    Object value = spec.get("durationMillis");
    if (value == null)
    {
      value = spec.get("durationMs");
    }
    if (value == null)
    {
      value = spec.get("durationSec");
      if (value instanceof Number)
      {
        return BRelTime.make(((Number) value).longValue() * 1000L);
      }
    }
    if (value == null)
    {
      value = spec.get("duration");
      if (value instanceof String)
      {
        try
        {
          return BRelTime.make((String) value);
        }
        catch (Exception e)
        {
          throw new BaskStreamProtocolException("bad_request", "Field 'duration' is not a valid Niagara relative time.");
        }
      }
    }
    if (value == null)
    {
      return null;
    }
    if (!(value instanceof Number))
    {
      throw new BaskStreamProtocolException("bad_request", "Duration fields must be numeric milliseconds/seconds.");
    }
    return BRelTime.make(((Number) value).longValue());
  }

  private double requireDouble(Object value) throws BaskStreamProtocolException
  {
    if (value instanceof Number)
    {
      return ((Number) value).doubleValue();
    }
    if (value instanceof String)
    {
      try
      {
        return Double.parseDouble(((String) value).trim());
      }
      catch (NumberFormatException e)
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'value' must be numeric for this writable point.");
      }
    }
    throw new BaskStreamProtocolException("bad_request", "Field 'value' is required and must be numeric.");
  }

  private boolean requireBoolean(Object value) throws BaskStreamProtocolException
  {
    if (value instanceof Boolean)
    {
      return ((Boolean) value).booleanValue();
    }
    if (value instanceof String)
    {
      String candidate = ((String) value).trim().toLowerCase();
      if ("true".equals(candidate) || "active".equals(candidate) || "on".equals(candidate) || "1".equals(candidate))
      {
        return true;
      }
      if ("false".equals(candidate) || "inactive".equals(candidate) || "off".equals(candidate) || "0".equals(candidate))
      {
        return false;
      }
    }
    throw new BaskStreamProtocolException("bad_request", "Field 'value' is required and must be boolean-like.");
  }

  private String requireStringValue(Object value) throws BaskStreamProtocolException
  {
    if (value == null)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'value' is required for this writable point.");
    }
    return String.valueOf(value);
  }

  private BDynamicEnum requireEnum(BEnumWritable point, Object value) throws BaskStreamProtocolException
  {
    BEnumRange range = enumRange(point);
    if (value instanceof Number)
    {
      return BDynamicEnum.make(((Number) value).intValue(), range);
    }
    if (value instanceof String)
    {
      String candidate = ((String) value).trim();
      if (range.isTag(candidate))
      {
        return BDynamicEnum.make(range.tagToOrdinal(candidate), range);
      }
      Integer ordinal = findEnumOrdinal(range, candidate, null);
      if (ordinal != null)
      {
        return BDynamicEnum.make(ordinal.intValue(), range);
      }
      try
      {
        return BDynamicEnum.make(Integer.parseInt(candidate), range);
      }
      catch (NumberFormatException e)
      {
        throw new BaskStreamProtocolException("bad_request", "Enum value must be a valid tag or ordinal.");
      }
    }
    throw new BaskStreamProtocolException("bad_request", "Field 'value' is required for this enum writable point.");
  }

  private Integer findEnumOrdinal(BEnumRange range, String candidate, Context context)
  {
    int[] ordinals = range.getOrdinals();
    for (int i = 0; i < ordinals.length; i++)
    {
      String tag = range.getTag(ordinals[i]);
      String display = range.getDisplayTag(ordinals[i], context);
      if (candidate.equalsIgnoreCase(tag) || candidate.equalsIgnoreCase(display))
      {
        return Integer.valueOf(ordinals[i]);
      }
    }
    return null;
  }

  private BEnumRange enumRange(BEnumWritable point) throws BaskStreamProtocolException
  {
    BObject range = point.getEnumFacets().get(BFacets.RANGE);
    if (range instanceof BEnumRange)
    {
      return (BEnumRange) range;
    }
    throw new BaskStreamProtocolException("write_failed", "Enum writable point does not expose an enum range.");
  }

  private String activeLevel(BComponent component, Context context)
  {
    try
    {
      return ((BIWritablePoint) component).getActiveLevel().toString(context);
    }
    catch (Exception e)
    {
      return null;
    }
  }

  private static String optionalString(Map<String, Object> request, String key)
  {
    Object value = request.get(key);
    return value instanceof String ? (String) value : null;
  }

  private void requireMaxSize(List<?> values, String key) throws BaskStreamProtocolException
  {
    if (values != null && values.size() > MAX_WRITE_POINTS_PER_REQUEST)
    {
      throw new BaskStreamProtocolException("bad_request",
          "Field '" + key + "' cannot contain more than " + MAX_WRITE_POINTS_PER_REQUEST + " entries.");
    }
  }

  private BaskStreamProtocolException unsupportedAction(String actionName)
  {
    return new BaskStreamProtocolException("unsupported_action",
        "Unsupported write action '" + actionName + "'.");
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

  private static final class ActionInvocation
  {
    final String name;
    final Action action;
    final BValue parameter;

    ActionInvocation(String name, Action action, BValue parameter)
    {
      this.name = name;
      this.action = action;
      this.parameter = parameter;
    }
  }
}
