package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.job.BIJobService;
import javax.baja.job.BJob;
import javax.baja.job.BJobService;
import javax.baja.job.JobLogItem;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.naming.SlotPath;
import javax.baja.sys.Action;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BBoolean;
import javax.baja.sys.BComplex;
import javax.baja.sys.BComponent;
import javax.baja.sys.BEnum;
import javax.baja.sys.BFacets;
import javax.baja.sys.BInteger;
import javax.baja.sys.BLink;
import javax.baja.sys.BNumber;
import javax.baja.sys.BObject;
import javax.baja.sys.BSimple;
import javax.baja.sys.BString;
import javax.baja.sys.BValue;
import javax.baja.sys.Context;
import javax.baja.sys.Property;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;

/**
 * Station jobs (list, read, cancel) and driver discovery. Discovery starts the driver's own
 * discovery job through its public action, the job's results are read like any job's, and
 * {@code add_discovered} turns chosen results into an ordinary model plan to preview and apply.
 * BACnet is built in; it is reached by type name and slot name only, so the module still loads
 * on a station without the bacnet module.
 */
final class BaskStreamJobResolver
{
  static final int MAX_LOG_ITEMS = 200;
  static final int MAX_LOG_DETAIL = 2000;
  static final int DEFAULT_RESULT_LIMIT = 200;
  static final int MAX_RESULT_LIMIT = 1000;

  private static final String BACNET_NETWORK = "bacnet:BacnetNetwork";
  private static final String BACNET_DEVICE = "bacnet:BacnetDevice";
  private static final String BACNET_POINTS = "bacnet:BacnetPointDeviceExt";
  private static final String BACNET_DEVICES_JOB = "bacnet:BacnetDiscoverDevicesJob";
  private static final String BACNET_POINTS_JOB = "bacnet:BacnetDiscoverPointsJob";

  private final BBaskStreamService service;
  private final BaskStreamAuthorizer authorizer;

  BaskStreamJobResolver(BBaskStreamService service)
  {
    this.service = service;
    this.authorizer = new BaskStreamAuthorizer(service);
  }

  List<Object> list(Context context) throws BaskStreamProtocolException
  {
    BIJobService jobs;
    try
    {
      jobs = BJobService.getService();
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("invalid_job", "This station has no JobService.");
    }
    List<Object> out = new ArrayList<Object>();
    for (BJob job : jobs.getJobs())
    {
      if (job.getSlotPath() != null && authorizer.canRead(job, context)) out.add(summary(job, context));
    }
    return out;
  }

  Map<String, Object> read(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    BJob job = job(request, context);
    Map<String, Object> result = summary(job, context);

    JobLogItem[] items = job.log().getItems();
    List<Object> log = new ArrayList<Object>();
    for (int i = Math.max(0, items.length - MAX_LOG_ITEMS); i < items.length; i++)
    {
      Map<String, Object> entry = new LinkedHashMap<String, Object>();
      entry.put("kind", items[i].getIdString());
      entry.put("timestamp", millis(items[i].getTimestamp()));
      entry.put("message", items[i].getMessage(context));
      String details = items[i].getDetails(context);
      if (details != null && details.length() > 0)
      {
        entry.put("details", details.length() > MAX_LOG_DETAIL ? details.substring(0, MAX_LOG_DETAIL) : details);
      }
      log.add(entry);
    }
    result.put("log", log);
    result.put("logItems", Long.valueOf(items.length));

    // What the job found (discovered devices or points, for example) sits on it as dynamic slots.
    int offset = BaskStreamWire.integer(request, "offset", 0, 0, 1000000);
    int limit = BaskStreamWire.integer(request, "limit", DEFAULT_RESULT_LIMIT, 1, MAX_RESULT_LIMIT);
    List<Property> found = results(job);
    List<Object> page = new ArrayList<Object>();
    for (int i = offset; i < found.size() && page.size() < limit; i++)
    {
      Property property = found.get(i);
      BValue value = job.get(property);
      Map<String, Object> entry = new LinkedHashMap<String, Object>();
      entry.put("slot", property.getName());
      entry.put("typeSpec", value.getType().toString());
      entry.put("values", BaskStreamWire.plain(value, property.getName(), context, 1));
      page.add(entry);
    }
    result.put("results", page);
    result.put("resultCount", Long.valueOf(found.size()));
    result.put("nextOffset", offset + page.size() < found.size() ? Long.valueOf(offset + page.size()) : null);
    String kind = discoveryKind(job);
    if (kind != null) result.put("discovery", kind);
    return result;
  }

  Map<String, Object> cancel(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    BJob job = job(request, context);
    if (!authorizer.canInvoke(job, BJob.cancel, context))
    {
      throw new BaskStreamProtocolException("forbidden_action", "The authenticated user may not cancel this job.");
    }
    service.requireWritesEnabled();
    try
    {
      job.invoke(BJob.cancel, null, context);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("invalid_job", "Could not cancel the job: " + message(e));
    }
    return summary(job, context);
  }

  /**
   * Starts discovery on a driver component and returns its job. A BACnet network discovers
   * devices; a BACnet device (or its points container) discovers that device's points.
   */
  Map<String, Object> discover(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    BComponent target = component(BaskStreamWire.string(request, "ord"), context);
    BComponent host;
    String actionName;
    String kind;
    BValue parameter = null;
    if (isType(target.getType(), BACNET_NETWORK))
    {
      host = target;
      actionName = "submitDeviceManagerJob";
      kind = "devices";
      parameter = deviceDiscoveryConfig(request);
    }
    else if (isType(target.getType(), BACNET_DEVICE) || isType(target.getType(), BACNET_POINTS))
    {
      BValue points = isType(target.getType(), BACNET_DEVICE) ? target.get("points") : target;
      if (!(points instanceof BComponent))
      {
        throw new BaskStreamProtocolException("discovery_unsupported", "This device has no points container to discover into.");
      }
      host = (BComponent) points;
      actionName = "submitPointDiscoveryJob";
      kind = "points";
    }
    else
    {
      throw new BaskStreamProtocolException("discovery_unsupported", "No built-in discovery for " + target.getType()
          + ". Use a BACnet network or device, or invoke the driver's own discovery action in a model plan and follow it with read_job.");
    }
    Action action = host.getAction(actionName);
    if (action == null)
    {
      throw new BaskStreamProtocolException("discovery_unsupported", target.getType() + " has no " + actionName + " action on this Niagara version.");
    }
    if (!authorizer.canRead(host, context) || !authorizer.canInvoke(host, action, context))
    {
      throw new BaskStreamProtocolException("forbidden_action", "The authenticated user may not start discovery here.");
    }
    service.requireWritesEnabled();
    BValue returned;
    try
    {
      returned = host.invoke(action, parameter, context);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("discovery_failed", "Discovery did not start: " + message(e));
    }
    if (!(returned instanceof BOrd) || ((BOrd) returned).isNull())
    {
      throw new BaskStreamProtocolException("discovery_failed", "Discovery did not return a job.");
    }
    String jobOrd = returned.toString();
    try
    {
      BComponent job = ((BOrd) returned).resolve(service, context).getComponent();
      if (job != null && job.getSlotPath() != null) jobOrd = job.getSlotPathOrd().toString();
    }
    catch (RuntimeException e)
    {
      // Keep the ORD the driver returned.
    }
    String user = context == null || context.getUser() == null ? null : context.getUser().getUsername();
    service.audit("discover", "user=" + user + " target=" + target.getSlotPathOrd() + " kind=" + kind + " job=" + jobOrd);
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("job", jobOrd);
    result.put("kind", kind);
    result.put("driver", "bacnet");
    result.put("target", target.getSlotPathOrd().toString());
    return result;
  }

  /**
   * Model-plan "create" changes for chosen discovery results: one BACnet device per discovered
   * device, or one proxy point per discovered object with the facets the device reports. The
   * caller previews them, so every model-editing check and the usual apply step still run.
   * Returns {changes, items}; items says what each change was built from.
   */
  Map<String, Object> discoveredChanges(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    BJob job = job(request, context);
    String kind = discoveryKind(job);
    if (kind == null)
    {
      throw new BaskStreamProtocolException("discovery_unsupported", job.getType() + " is not a discovery job baskStream can add from.");
    }
    Object raw = request.get("items");
    if (!(raw instanceof List) || ((List<?>) raw).isEmpty() || ((List<?>) raw).size() > BaskStreamModelResolver.MAX_CHANGES)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'items' must list 1 to " + BaskStreamModelResolver.MAX_CHANGES
          + " discovery results, each {slot} from read_job.");
    }
    String defaultParent = BaskStreamWire.string(request, "parent");
    if (defaultParent == null && "points".equals(kind)) defaultParent = pointsContainer(job, context);
    List<Object> changes = new ArrayList<Object>();
    List<Object> items = new ArrayList<Object>();
    for (Object entry : (List<?>) raw)
    {
      if (!(entry instanceof Map))
      {
        throw new BaskStreamProtocolException("bad_request", "Each item must be an object with a 'slot'.");
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> item = (Map<String, Object>) entry;
      String slot = BaskStreamWire.string(item, "slot");
      Property property = slot == null ? null : job.getProperty(slot);
      BValue found = property == null ? null : job.get(property);
      if (!(found instanceof BComplex) || found instanceof BLink)
      {
        throw new BaskStreamProtocolException("bad_request", "No discovery result named '" + slot + "' on this job.");
      }
      String parent = BaskStreamWire.string(item, "parent");
      if (parent == null) parent = defaultParent;
      if (parent == null)
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'parent' is required: the network or device folder to add devices to.");
      }
      Map<String, Object> info = new LinkedHashMap<String, Object>();
      info.put("slot", slot);
      Map<String, Object> change = "devices".equals(kind)
          ? deviceChange((BComplex) found, item, info)
          : pointChange(job, (BComplex) found, item, info, context);
      change.put("action", "create");
      change.put("parent", parent);
      change.put("collision", "suffix".equals(item.get("collision")) ? "suffix" : "fail");
      info.put("parent", parent);
      info.put("name", change.get("name"));
      info.put("typeSpec", change.get("typeSpec"));
      changes.add(change);
      items.add(info);
    }
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("changes", changes);
    result.put("items", items);
    result.put("kind", kind);
    return result;
  }

  private Map<String, Object> deviceChange(BComplex found, Map<String, Object> item, Map<String, Object> info)
      throws BaskStreamProtocolException
  {
    BValue objectId = found.get("objectId");
    BValue address = found.get("address");
    if (objectId == null || address == null)
    {
      throw new BaskStreamProtocolException("discovery_unsupported", "The discovered device has no objectId or address.");
    }
    String requested = BaskStreamWire.string(item, "name");
    String label = requested != null ? requested : text(found.get("deviceName"));
    if (label == null) label = "Device_" + encoded(objectId).replace(':', '_');
    Map<String, Object> properties = new LinkedHashMap<String, Object>();
    properties.put("address", BaskStreamWire.typed(address, 0));
    properties.put("config/deviceObject/objectId", BaskStreamWire.typed(objectId, 0));
    merge(properties, item.get("properties"));
    info.put("objectId", encoded(objectId));
    Map<String, Object> change = new LinkedHashMap<String, Object>();
    change.put("name", SlotPath.escape(label));
    change.put("typeSpec", BACNET_DEVICE);
    change.put("properties", properties);
    return change;
  }

  private Map<String, Object> pointChange(BJob job, BComplex found, Map<String, Object> item, Map<String, Object> info,
      Context context) throws BaskStreamProtocolException
  {
    BValue objectId = found.get("objectId");
    if (objectId == null)
    {
      throw new BaskStreamProtocolException("discovery_unsupported", "The discovered point has no objectId.");
    }
    String id = encoded(objectId);
    String objectType = id.indexOf(':') > 0 ? id.substring(0, id.indexOf(':')) : id;
    String kind = pointKind(objectType, found.get("value"));
    // Outputs and values take commands; inputs are read-only. "writable" overrides the guess.
    boolean writable = item.get("writable") instanceof Boolean
        ? ((Boolean) item.get("writable")).booleanValue()
        : objectType.endsWith("Output") || objectType.endsWith("Value");

    BFacets facets = found.get("facets") instanceof BFacets ? (BFacets) found.get("facets") : BFacets.NULL;
    boolean learned = false;
    if (facets.isNull() || facets.isEmpty())
    {
      // Ask the device, the way the Point Manager does when a discovered point is added.
      Action discoverFacets = job.getAction("discoverFacets");
      if (discoverFacets != null && authorizer.canInvoke(job, discoverFacets, context))
      {
        try
        {
          BValue reply = job.invoke(discoverFacets, objectId, context);
          if (reply instanceof BFacets && !((BFacets) reply).isNull())
          {
            facets = (BFacets) reply;
            learned = true;
          }
        }
        catch (RuntimeException e)
        {
          info.put("facetsError", message(e));
        }
      }
    }
    else
    {
      learned = true;
    }

    Map<String, Object> proxyProperties = new LinkedHashMap<String, Object>();
    proxyProperties.put("objectId", BaskStreamWire.typed(objectId, 0));
    Map<String, Object> proxyExt = new LinkedHashMap<String, Object>();
    proxyExt.put("typeSpec", "bacnet:Bacnet" + kind + "ProxyExt");
    proxyExt.put("properties", proxyProperties);
    Map<String, Object> properties = new LinkedHashMap<String, Object>();
    if (!facets.isNull() && !facets.isEmpty()) properties.put("facets", BaskStreamWire.typed(facets, 0));
    properties.put("proxyExt", proxyExt);
    merge(properties, item.get("properties"));

    String requested = BaskStreamWire.string(item, "name");
    String label = requested != null ? requested : text(found.get("objectName"));
    if (label == null) label = id.replace(':', '_');
    String typeSpec = BaskStreamWire.string(item, "typeSpec");
    if (typeSpec == null) typeSpec = "control:" + kind + (writable ? "Writable" : "Point");
    info.put("objectId", id);
    info.put("writable", Boolean.valueOf(writable));
    info.put("facetsLearned", Boolean.valueOf(learned));
    Map<String, Object> change = new LinkedHashMap<String, Object>();
    change.put("name", SlotPath.escape(label));
    change.put("typeSpec", typeSpec);
    change.put("properties", properties);
    return change;
  }

  /** Numeric, Boolean, Enum or String: from the BACnet object type, else from the value read at discovery. */
  private static String pointKind(String objectType, BValue value)
  {
    if (objectType.startsWith("analog")) return "Numeric";
    if (objectType.startsWith("binary")) return "Boolean";
    if (objectType.startsWith("multiState")) return "Enum";
    if (value instanceof BNumber) return "Numeric";
    if (value instanceof BBoolean) return "Boolean";
    if (value instanceof BEnum) return "Enum";
    return "String";
  }

  /** Extra typed property values from the client; they win over the ones built from discovery. */
  private static void merge(Map<String, Object> properties, Object extra) throws BaskStreamProtocolException
  {
    if (extra == null) return;
    if (!(extra instanceof Map))
    {
      throw new BaskStreamProtocolException("bad_request", "An item's 'properties' must be an object of typed values.");
    }
    for (Map.Entry<?, ?> entry : ((Map<?, ?>) extra).entrySet())
    {
      properties.put(String.valueOf(entry.getKey()), entry.getValue());
    }
  }

  /** The points container of the device a point-discovery job ran against. */
  private String pointsContainer(BJob job, Context context) throws BaskStreamProtocolException
  {
    BValue deviceOrd = job.get("deviceOrd");
    try
    {
      if (deviceOrd instanceof BOrd && !((BOrd) deviceOrd).isNull())
      {
        BComponent device = ((BOrd) deviceOrd).resolve(service, context).getComponent();
        BValue points = device == null ? null : device.get("points");
        if (points instanceof BComponent && ((BComponent) points).getSlotPath() != null)
        {
          return ((BComponent) points).getSlotPathOrd().toString();
        }
      }
    }
    catch (RuntimeException e)
    {
      // Fall through: the caller is asked for a parent.
    }
    throw new BaskStreamProtocolException("bad_request", "Could not find the job's device; send 'parent' (the device's points container or a point folder).");
  }

  private static String discoveryKind(BJob job)
  {
    if (isType(job.getType(), BACNET_DEVICES_JOB)) return "devices";
    if (isType(job.getType(), BACNET_POINTS_JOB)) return "points";
    return null;
  }

  private BValue deviceDiscoveryConfig(Map<String, Object> request) throws BaskStreamProtocolException
  {
    BObject config;
    try
    {
      config = Sys.getType("bacnet:DeviceDiscoveryConfig").getInstance();
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("discovery_unsupported", "This station's bacnet module has no DeviceDiscoveryConfig type.");
    }
    if (!(config instanceof BComplex))
    {
      throw new BaskStreamProtocolException("discovery_unsupported", "Unexpected DeviceDiscoveryConfig type.");
    }
    BComplex complex = (BComplex) config;
    // Device instance range for the Who-Is; left alone, the driver asks for every device.
    if (request.get("lowLimit") != null && complex.getProperty("deviceLowLimit") != null)
    {
      complex.set("deviceLowLimit", BInteger.make(BaskStreamWire.integer(request, "lowLimit", 0, 0, 4194303)));
    }
    if (request.get("highLimit") != null && complex.getProperty("deviceHighLimit") != null)
    {
      complex.set("deviceHighLimit", BInteger.make(BaskStreamWire.integer(request, "highLimit", 4194303, 0, 4194303)));
    }
    return (BValue) complex;
  }

  /** Dynamic struct-like slots: what a job leaves behind as its results. */
  private static List<Property> results(BJob job)
  {
    List<Property> found = new ArrayList<Property>();
    for (Property property : job.getDynamicPropertiesArray())
    {
      BValue value = job.get(property);
      if (value instanceof BComplex && !(value instanceof BLink)) found.add(property);
    }
    return found;
  }

  private Map<String, Object> summary(BJob job, Context context)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("job", job.getSlotPath() == null ? null : job.getSlotPathOrd().toString());
    summary.put("name", job.getName());
    summary.put("display", job.toString(context));
    summary.put("typeSpec", job.getType().toString());
    summary.put("state", job.getJobState().getTag());
    summary.put("complete", Boolean.valueOf(job.getJobState().isComplete()));
    summary.put("progress", Long.valueOf(job.getProgress()));
    summary.put("startTime", millis(job.getStartTime()));
    summary.put("endTime", millis(job.getEndTime()));
    return summary;
  }

  private BJob job(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    BComponent component = component(BaskStreamWire.string(request, "job"), context);
    if (!(component instanceof BJob))
    {
      throw new BaskStreamProtocolException("invalid_job", "Not a job: " + component.getSlotPathOrd() + ". Use list_jobs or the job returned by discover.");
    }
    return (BJob) component;
  }

  private BComponent component(String ord, Context context) throws BaskStreamProtocolException
  {
    String slotOrd = BaskStreamAccessPolicy.localSlotOrd(ord);
    if (slotOrd == null)
    {
      throw new BaskStreamProtocolException("bad_request", "A slot ORD on this station is required, e.g. slot:/Drivers/BacnetNetwork.");
    }
    if (!BaskStreamAccessPolicy.isAllowed(service, slotOrd))
    {
      throw new BaskStreamProtocolException("forbidden_component", "ORD is outside the allowedPathPatterns policy.");
    }
    OrdTarget target;
    try
    {
      target = BOrd.make(slotOrd).resolve(service, context);
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("invalid_component", "Could not resolve " + slotOrd + ".");
    }
    BComponent component = target.getComponent();
    if (!target.canRead() || component == null || !authorizer.canRead(component, context))
    {
      throw new BaskStreamProtocolException("forbidden_component", "Target is not readable.");
    }
    return component;
  }

  /** Compares type names up the superclass chain, so a driver's types are never loaded by name. */
  private static boolean isType(Type type, String spec)
  {
    Type t = type;
    for (int depth = 0; t != null && depth < 64; depth++)
    {
      if (spec.equals(t.toString())) return true;
      Type next = t.getSuperType();
      if (next == t) break;
      t = next;
    }
    return false;
  }

  private static String encoded(BValue value) throws BaskStreamProtocolException
  {
    if (value instanceof BSimple)
    {
      try
      {
        return ((BSimple) value).encodeToString();
      }
      catch (java.io.IOException e)
      {
        // Fall through.
      }
    }
    throw new BaskStreamProtocolException("discovery_unsupported", "Unexpected discovery value type: " + value.getType());
  }

  private static String text(BValue value)
  {
    if (!(value instanceof BString)) return null;
    String text = ((BString) value).getString().trim();
    return text.length() == 0 ? null : text;
  }

  private static Object millis(BAbsTime time)
  {
    return time == null || time.isNull() ? null : Long.valueOf(time.getMillis());
  }

  private static String message(Exception e)
  {
    return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
  }
}
