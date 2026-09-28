package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.BComponent;
import javax.baja.sys.BComponentEvent;
import javax.baja.sys.BComponentEventMask;
import javax.baja.sys.BObject;
import javax.baja.sys.BValue;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Subscriber;

/** One session's model subscriptions: subscribe/unsubscribe requests and model_cov delivery. */
final class BaskStreamModelStream
{
  private static final int MAX_MODEL_BASES_PER_REQUEST = 100;

  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;
  // Keyed by component handle so entries follow a component through rename and move.
  private final Map<String, BComponent> modelSubscriptions = new ConcurrentHashMap<String, BComponent>();
  private final Subscriber modelSubscriber;
  private final java.util.concurrent.atomic.AtomicLong modelSequence = new java.util.concurrent.atomic.AtomicLong();

  BaskStreamModelStream(BaskStreamClientSession session)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
    this.modelSubscriber = Subscriber.make(this::onModelEvent);
    this.modelSubscriber.setMask(BComponentEventMask.make(new int[] {
      BComponentEvent.PROPERTY_ADDED,
      BComponentEvent.PROPERTY_REMOVED,
      BComponentEvent.PROPERTY_RENAMED,
      BComponentEvent.PROPERTIES_REORDERED,
      BComponentEvent.FLAGS_CHANGED,
      BComponentEvent.FACETS_CHANGED,
      BComponentEvent.KNOB_ADDED,
      BComponentEvent.KNOB_REMOVED,
      BComponentEvent.RECATEGORIZED,
      BComponentEvent.COMPONENT_PARENTED,
      BComponentEvent.COMPONENT_UNPARENTED,
      BComponentEvent.COMPONENT_RENAMED,
      BComponentEvent.COMPONENT_REORDERED,
      BComponentEvent.COMPONENT_FLAGS_CHANGED,
      BComponentEvent.COMPONENT_FACETS_CHANGED,
      BComponentEvent.RELATION_KNOB_ADDED,
      BComponentEvent.RELATION_KNOB_REMOVED
    }));
  }

  int count()
  {
    return modelSubscriptions.size();
  }

  void release()
  {
    modelSubscriptions.clear();
    modelSubscriber.unsubscribeAll();
  }

  /** Drops components that were deleted, moved out of scope or hidden; returns their last paths. */
  List<String> revalidate()
  {
    List<String> revoked = new ArrayList<String>();
    for (Map.Entry<String, BComponent> entry : new ArrayList<Map.Entry<String, BComponent>>(modelSubscriptions.entrySet()))
    {
      if (!canReadModelComponent(entry.getValue()))
      {
        modelSubscriptions.remove(entry.getKey());
        modelSubscriber.unsubscribe(entry.getValue(), context);
        // Report the last known path, which means more to a client than a handle.
        String path = componentKey(entry.getValue());
        revoked.add(path != null ? path : "handle:" + entry.getKey());
      }
    }
    return revoked;
  }

  void handleSubscribeModel(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> bases = modelBaseOrds(request);
    int depth = runtime.getBrowseResolver().normalizeDepth(request.get("depth"));
    List<Object> roots = new ArrayList<Object>();
    int before = modelSubscriptions.size();
    for (String base : bases)
    {
      BComponent component = resolveModelComponent(base);
      roots.add(componentSummary(component));
      subscribeModelComponent(component, depth);
    }
    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = session.baseMessage("model_subscribed", id);
    response.put("bases", roots);
    response.put("depth", Long.valueOf(depth));
    response.put("added", Long.valueOf(modelSubscriptions.size() - before));
    response.put("count", Long.valueOf(modelSubscriptions.size()));
    response.put("mode", "component_events");
    response.put("note", "Model events are change hints; refresh affected branches with browse/describe.");
    session.send(response);
  }

  void handleUnsubscribeModel(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    if (!request.containsKey("base") && !request.containsKey("bases"))
    {
      modelSubscriptions.clear();
      modelSubscriber.unsubscribeAll();
    }
    else
    {
      for (String base : modelBaseOrds(request))
      {
        BComponent component = resolveModelComponent(base);
        unsubscribeModelComponent(component);
      }
    }
    runtime.onSubscriptionCountChanged();
    if (id != null)
    {
      Map<String, Object> response = session.baseMessage("model_unsubscribed", id);
      response.put("count", Long.valueOf(modelSubscriptions.size()));
      session.send(response);
    }
  }

  private List<String> modelBaseOrds(Map<String, Object> request) throws BaskStreamProtocolException
  {
    List<String> bases = session.optionalStringList(request, "bases");
    if (bases != null && !bases.isEmpty())
    {
      session.requireMaxSize(bases, "bases", MAX_MODEL_BASES_PER_REQUEST);
      return bases;
    }
    String base = runtime.getCodec().optionalString(request, "base");
    if (base == null || base.trim().length() == 0)
    {
      base = "slot:/";
    }
    List<String> single = new ArrayList<String>(1);
    single.add(base);
    return single;
  }

  private BComponent resolveModelComponent(String ord) throws BaskStreamProtocolException
  {
    if (ord == null || !ord.startsWith("slot:/"))
    {
      throw new BaskStreamProtocolException("invalid_point", "Model subscriptions support slot:/ ORDs only.");
    }
    if (!runtime.getBrowseResolver().isAllowedOrd(ord))
    {
      throw new BaskStreamProtocolException("forbidden_point", "Model subscription base is outside allowedPathPatterns.");
    }
    try
    {
      OrdTarget target = BOrd.make(ord).resolve(runtime.getService(), context);
      if (!target.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_point", "Model subscription base is not readable for the authenticated user.");
      }
      BObject object = target.get();
      BComponent component = object instanceof BComponent ? (BComponent) object : target.getComponent();
      if (component == null)
      {
        throw new BaskStreamProtocolException("invalid_point", "Model subscription base did not resolve to a component.");
      }
      return component;
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("invalid_point",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private void subscribeModelComponent(BComponent component, int depth) throws BaskStreamProtocolException
  {
    String key = modelKey(component);
    if (key == null)
    {
      return;
    }
    if (!canReadModelComponent(component))
    {
      return;
    }
    if (!modelSubscriptions.containsKey(key))
    {
      if (session.getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
      {
        throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
      }
      modelSubscriptions.put(key, component);
      if (!modelSubscriber.isSubscribed(component))
      {
        modelSubscriber.subscribe(component, 0, context);
      }
    }
    if (depth <= 0)
    {
      return;
    }
    BComponent[] children = component.getChildComponents();
    for (int i = 0; i < children.length; i++)
    {
      subscribeModelComponent(children[i], depth - 1);
    }
  }

  private void unsubscribeModelComponent(BComponent component)
  {
    String key = modelKey(component);
    if (key != null)
    {
      modelSubscriptions.remove(key);
      modelSubscriber.unsubscribe(component, context);
    }
    BComponent[] children = component.getChildComponents();
    for (int i = 0; i < children.length; i++)
    {
      unsubscribeModelComponent(children[i]);
    }
  }

  /** Current slot path, for policy checks and for what clients see. */
  private String componentKey(BComponent component)
  {
    return component == null || component.getSlotPath() == null ? null : component.getSlotPath().toString();
  }

  /** Subscription key: the component's handle, which survives rename and move. */
  private String modelKey(BComponent component)
  {
    return component == null || component.getHandle() == null ? null : String.valueOf(component.getHandle());
  }

  private boolean canReadModelComponent(BComponent component)
  {
    // Deleted components have no slot path and fail here, which also prunes them on revalidation.
    return component != null && component.getSlotPath() != null && session.authorizer.canRead(component, context);
  }

  private Map<String, Object> componentSummary(BComponent component)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    if (component == null)
    {
      return summary;
    }
    summary.put("slotPath", component.getSlotPath() == null ? null : component.getSlotPath().toString());
    summary.put("name", component.getName());
    summary.put("display", component.getDisplayName(context));
    summary.put("typeSpec", component.getType().toString());
    return summary;
  }

  private void onModelEvent(BComponentEvent event)
  {
    if (session.closed.get())
    {
      return;
    }
    final BComponent source = event.getSourceComponent();
    final int eventId = event.getId();
    final String slot = event.getSlotName();
    final BValue value = event.getValue();
    session.events.submit(() -> deliverModelEvent(source, eventId, slot, value));
  }

  private void deliverModelEvent(BComponent source, int eventId, String slot, BValue value)
  {
    if (session.closed.get() || !canReadModelComponent(source))
    {
      return;
    }
    Map<String, Object> message = session.baseMessage("model_cov", null);
    message.put("sequence", Long.valueOf(modelSequence.incrementAndGet()));
    message.put("timestamp", Long.valueOf(Clock.millis()));
    message.put("eventId", Long.valueOf(eventId));
    message.put("event", modelEventName(eventId));
    message.put("slot", slot);
    message.put("source", componentSummary(source));
    if (value != null && !BaskStreamModelResolver.sensitive(slot, value.getType().toString()))
    {
      message.put("valueType", value.getType().toString());
      message.put("value", value.toString(context));
    }
    message.put("refreshRecommended", Boolean.TRUE);
    session.send(message);
  }

  /** Called on the applying session's worker; the matching and sending happen on this session's lane. */
  void modelChanged(Set<String> affected)
  {
    if (session.closed.get()) return;
    session.events.submit(() -> deliverModelChanged(affected));
  }

  private void deliverModelChanged(Set<String> affected)
  {
    if (session.closed.get()) return;
    Set<String> bases = new LinkedHashSet<String>();
    for (Map.Entry<String, BComponent> watch : modelSubscriptions.entrySet())
    {
      if (!canReadModelComponent(watch.getValue())) continue;
      String base = componentKey(watch.getValue());
      if (base == null) continue;
      String prefix = base.endsWith("/") ? base : base + "/";
      for (String changed : affected)
        if (changed.equals(base) || changed.startsWith(prefix) || base.startsWith(changed.endsWith("/") ? changed : changed + "/"))
        { bases.add(base); break; }
    }
    if (bases.isEmpty()) return;
    Map<String, Object> message = session.baseMessage("model_cov", null);
    message.put("sequence", Long.valueOf(modelSequence.incrementAndGet()));
    message.put("timestamp", Long.valueOf(Clock.millis()));
    message.put("event", "model_plan_applied");
    message.put("bases", new ArrayList<String>(bases));
    message.put("refreshRecommended", Boolean.TRUE);
    session.send(message);
  }

  private String modelEventName(int id)
  {
    switch (id)
    {
      case BComponentEvent.PROPERTY_ADDED:
        return "property_added";
      case BComponentEvent.PROPERTY_REMOVED:
        return "property_removed";
      case BComponentEvent.PROPERTY_RENAMED:
        return "property_renamed";
      case BComponentEvent.PROPERTIES_REORDERED:
        return "properties_reordered";
      case BComponentEvent.FLAGS_CHANGED:
        return "flags_changed";
      case BComponentEvent.FACETS_CHANGED:
        return "facets_changed";
      case BComponentEvent.KNOB_ADDED:
        return "knob_added";
      case BComponentEvent.KNOB_REMOVED:
        return "knob_removed";
      case BComponentEvent.RECATEGORIZED:
        return "recategorized";
      case BComponentEvent.COMPONENT_PARENTED:
        return "component_parented";
      case BComponentEvent.COMPONENT_UNPARENTED:
        return "component_unparented";
      case BComponentEvent.COMPONENT_RENAMED:
        return "component_renamed";
      case BComponentEvent.COMPONENT_REORDERED:
        return "component_reordered";
      case BComponentEvent.COMPONENT_FLAGS_CHANGED:
        return "component_flags_changed";
      case BComponentEvent.COMPONENT_FACETS_CHANGED:
        return "component_facets_changed";
      case BComponentEvent.RELATION_KNOB_ADDED:
        return "relation_added";
      case BComponentEvent.RELATION_KNOB_REMOVED:
        return "relation_removed";
      default:
        return "component_event";
    }
  }
}
