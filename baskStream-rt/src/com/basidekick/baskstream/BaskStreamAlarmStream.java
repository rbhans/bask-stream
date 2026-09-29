package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.baja.alarm.BAlarmRecord;
import javax.baja.alarm.BAlarmService;
import javax.baja.sys.BComponentEvent;
import javax.baja.sys.BComponentEventMask;
import javax.baja.sys.BValue;
import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Subscriber;

/** One session's alarm subscriptions: subscribe/unsubscribe requests and alarm_cov delivery. */
final class BaskStreamAlarmStream
{
  private final BaskStreamClientSession session;
  private final BaskStreamWebSocketRuntime runtime;
  private final Context context;
  private final Map<String, BaskStreamAlarmResolver.AlarmSubscriptionSpec> alarmSubscriptions =
      new ConcurrentHashMap<String, BaskStreamAlarmResolver.AlarmSubscriptionSpec>();
  private final Subscriber alarmSubscriber;
  private final java.util.concurrent.atomic.AtomicLong alarmSequence = new java.util.concurrent.atomic.AtomicLong();

  BaskStreamAlarmStream(BaskStreamClientSession session)
  {
    this.session = session;
    this.runtime = session.runtime;
    this.context = session.context;
    this.alarmSubscriber = Subscriber.make(this::onAlarmEvent);
    this.alarmSubscriber.setMask(BComponentEventMask.make(new int[] { BComponentEvent.TOPIC_FIRED }));
  }

  int count()
  {
    return alarmSubscriptions.size();
  }

  void release()
  {
    alarmSubscriptions.clear();
    alarmSubscriber.unsubscribeAll();
  }

  /** Drops subscriptions whose filter left the path policy; returns their keys. */
  List<String> revalidate()
  {
    // Alarm events are checked per record as they fire; here only the filter's path can go stale.
    List<String> revoked = new ArrayList<String>();
    for (BaskStreamAlarmResolver.AlarmSubscriptionSpec spec :
        alarmSubscriptions.values().toArray(new BaskStreamAlarmResolver.AlarmSubscriptionSpec[0]))
    {
      try
      {
        runtime.getAlarmResolver().requireAllowed(spec);
      }
      catch (BaskStreamProtocolException e)
      {
        alarmSubscriptions.remove(spec.key());
        revoked.add(spec.key());
      }
    }
    if (!revoked.isEmpty() && alarmSubscriptions.isEmpty())
    {
      alarmSubscriber.unsubscribeAll();
    }
    return revoked;
  }

  void handleSubscribeAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    BaskStreamAlarmResolver.AlarmSubscriptionSpec spec = runtime.getAlarmResolver().normalizeSubscription(
        runtime.getCodec().optionalString(request, "source"),
        runtime.getCodec().optionalString(request, "scope"),
        request.get("limit"),
        runtime.getCodec().optionalString(request, "mode"));

    if (!alarmSubscriptions.containsKey(spec.key())
        && session.getSubscriptionCount() >= runtime.getService().getMaxSubscriptionsPerClientValue())
    {
      throw new BaskStreamProtocolException("subscription_limit", "maxSubscriptionsPerClient exceeded.");
    }
    runtime.getAlarmResolver().requireAllowed(spec);
    ensureAlarmServiceSubscribed();
    alarmSubscriptions.put(spec.key(), spec);
    runtime.onSubscriptionCountChanged();

    Map<String, Object> response = session.baseMessage("alarms_subscribed", id);
    response.put("mode", spec.mode);
    response.put("alarms", runtime.getAlarmResolver().readAlarms(spec.source, spec.scope, Integer.valueOf(spec.limit), context));
    session.send(response);
  }

  void handleUnsubscribeAlarms(String id, Map<String, Object> request) throws BaskStreamProtocolException
  {
    boolean hasFilter = request.containsKey("source") || request.containsKey("scope") || request.containsKey("limit") || request.containsKey("mode");
    if (!hasFilter)
    {
      alarmSubscriptions.clear();
      alarmSubscriber.unsubscribeAll();
      runtime.onSubscriptionCountChanged();
      sendUnsubscribedAlarms(id);
      return;
    }

    String mode = runtime.getCodec().optionalString(request, "mode");
    BaskStreamAlarmResolver.AlarmSubscriptionSpec spec = runtime.getAlarmResolver().normalizeSubscription(
        runtime.getCodec().optionalString(request, "source"),
        runtime.getCodec().optionalString(request, "scope"),
        request.get("limit"),
        mode);
    if (mode == null || mode.trim().length() == 0)
    {
      removeAlarmSubscriptions(spec);
    }
    else
    {
      alarmSubscriptions.remove(spec.key());
    }
    if (alarmSubscriptions.isEmpty())
    {
      alarmSubscriber.unsubscribeAll();
    }
    runtime.onSubscriptionCountChanged();
    sendUnsubscribedAlarms(id);
  }

  private void sendUnsubscribedAlarms(String id)
  {
    if (id == null)
    {
      return;
    }
    Map<String, Object> response = session.baseMessage("alarms_unsubscribed", id);
    response.put("remaining", Long.valueOf(alarmSubscriptions.size()));
    session.send(response);
  }

  private void removeAlarmSubscriptions(BaskStreamAlarmResolver.AlarmSubscriptionSpec spec)
  {
    for (BaskStreamAlarmResolver.AlarmSubscriptionSpec existing :
        alarmSubscriptions.values().toArray(new BaskStreamAlarmResolver.AlarmSubscriptionSpec[0]))
    {
      if (sameAlarmFilter(existing, spec))
      {
        alarmSubscriptions.remove(existing.key());
      }
    }
  }

  private boolean sameAlarmFilter(BaskStreamAlarmResolver.AlarmSubscriptionSpec left, BaskStreamAlarmResolver.AlarmSubscriptionSpec right)
  {
    if (left.limit != right.limit || !left.scope.equals(right.scope))
    {
      return false;
    }
    if (left.source == null)
    {
      return right.source == null;
    }
    return left.source.equals(right.source);
  }

  private void ensureAlarmServiceSubscribed() throws BaskStreamProtocolException
  {
    BAlarmService alarmService = BAlarmService.getService();
    if (alarmService == null)
    {
      throw new BaskStreamProtocolException("alarm_failed", "Niagara AlarmService is not available.");
    }
    if (!alarmSubscriber.isSubscribed(alarmService))
    {
      alarmSubscriber.subscribe(alarmService, 0, context);
    }
  }

  private void onAlarmEvent(BComponentEvent event)
  {
    if (session.closed.get() || event.getId() != BComponentEvent.TOPIC_FIRED || !"alarm".equals(event.getSlotName()))
    {
      return;
    }
    // Runs on the alarm service's thread: copy the record and let the lane do the work,
    // including any snapshot-mode alarm database query.
    BAlarmRecord fired = alarmRecord(event);
    final BAlarmRecord record = fired == null ? null : (BAlarmRecord) fired.newCopy();
    session.events.submit(() -> deliverAlarm(record));
  }

  private void deliverAlarm(BAlarmRecord record)
  {
    if (session.closed.get())
    {
      return;
    }
    if (record != null && !runtime.getAlarmResolver().canView(record, context))
    {
      return;
    }
    for (BaskStreamAlarmResolver.AlarmSubscriptionSpec spec : alarmSubscriptions.values())
    {
      try
      {
        runtime.getAlarmResolver().requireAllowed(spec);
        if (record != null && spec.source != null && !runtime.getAlarmResolver().matchesSource(record, spec.source))
        {
          continue;
        }

        Map<String, Object> message = session.baseMessage("alarm_cov", null);
        message.put("sequence", Long.valueOf(alarmSequence.incrementAndGet()));
        message.put("timestamp", Long.valueOf(Clock.millis()));
        message.put("source", spec.source);
        message.put("scope", spec.scope);
        message.put("limit", Long.valueOf(spec.limit));
        message.put("mode", spec.mode);

        if (record != null)
        {
          message.put("event", runtime.getAlarmResolver().toWire(record, context));
          message.put("inScope", Boolean.valueOf(runtime.getAlarmResolver().matchesScope(record, spec.scope)));
        }
        else
        {
          message.put("event", null);
          message.put("refreshRecommended", Boolean.TRUE);
        }

        if ("snapshot".equals(spec.mode) || "both".equals(spec.mode) || record == null)
        {
          message.put("alarms", runtime.getAlarmResolver().readAlarms(spec.source, spec.scope, Integer.valueOf(spec.limit), context));
        }
        session.send(message);
      }
      catch (BaskStreamProtocolException e)
      {
        session.sendError(null, e.getCode(), e.getMessage());
      }
    }
  }

  private BAlarmRecord alarmRecord(BComponentEvent event)
  {
    BValue value = event.getValue();
    return value instanceof BAlarmRecord ? (BAlarmRecord) value : null;
  }
}
