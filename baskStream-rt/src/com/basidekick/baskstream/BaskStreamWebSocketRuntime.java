package com.basidekick.baskstream;

import java.security.Principal;
import java.util.Locale;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;

import javax.baja.sys.BasicContext;
import javax.baja.user.BUser;

final class BaskStreamWebSocketRuntime
{
  private final BBaskStreamService service;
  private final BaskStreamCodec codec;
  private final BaskStreamPointResolver resolver;
  private final BaskStreamBrowseResolver browseResolver;
  private final BaskStreamHistoryResolver historyResolver;
  private final BaskStreamAlarmResolver alarmResolver;
  private final BaskStreamScheduleResolver scheduleResolver;
  private final BaskStreamWriteResolver writeResolver;
  private final BaskStreamTagResolver tagResolver;
  private final BaskStreamModelResolver modelResolver;
  private final BaskStreamSubscriptionManager subscriptions;
  private final ScheduledExecutorService scheduler;
  // Shared by every session's event lane: snapshots, alarm queries and notices run here, not
  // on Niagara callback threads or the scheduler.
  private final java.util.concurrent.ExecutorService eventPool;
  private final BaskStreamJettyTransport transport;

  BaskStreamWebSocketRuntime(BBaskStreamService service)
  {
    this.service = service;
    this.transport = new BaskStreamJettyTransport(this);
    this.codec = new BaskStreamCodec();
    this.resolver = new BaskStreamPointResolver(service);
    this.browseResolver = new BaskStreamBrowseResolver(service);
    this.historyResolver = new BaskStreamHistoryResolver(service);
    this.alarmResolver = new BaskStreamAlarmResolver(service);
    this.scheduleResolver = new BaskStreamScheduleResolver(service);
    this.writeResolver = new BaskStreamWriteResolver(service, resolver);
    this.tagResolver = new BaskStreamTagResolver(service);
    this.modelResolver = new BaskStreamModelResolver(service);
    this.subscriptions = new BaskStreamSubscriptionManager(service);
    java.util.concurrent.ScheduledThreadPoolExecutor scheduled =
        new java.util.concurrent.ScheduledThreadPoolExecutor(1, new BaskStreamThreadFactory("baskStream-websocket-"));
    scheduled.setRemoveOnCancelPolicy(true);
    this.scheduler = scheduled;
    this.eventPool = java.util.concurrent.Executors.newFixedThreadPool(2, new BaskStreamThreadFactory("baskStream-events-"));
    // Watchdog: close sessions whose request has run longer than the limit.
    scheduled.scheduleWithFixedDelay(() -> {
      try
      {
        subscriptions.checkWatchdogs(System.currentTimeMillis());
      }
      catch (Throwable e)
      {
        service.LOG.log(Level.WARNING, "baskStream watchdog sweep failed", e);
      }
    }, 15L, 15L, TimeUnit.SECONDS);
  }

  BaskStreamCodec getCodec()
  {
    return codec;
  }

  BaskStreamPointResolver getResolver()
  {
    return resolver;
  }

  BaskStreamBrowseResolver getBrowseResolver()
  {
    return browseResolver;
  }

  BaskStreamHistoryResolver getHistoryResolver()
  {
    return historyResolver;
  }

  BaskStreamAlarmResolver getAlarmResolver()
  {
    return alarmResolver;
  }

  BaskStreamScheduleResolver getScheduleResolver()
  {
    return scheduleResolver;
  }

  BaskStreamWriteResolver getWriteResolver()
  {
    return writeResolver;
  }

  BaskStreamTagResolver getTagResolver()
  {
    return tagResolver;
  }

  BaskStreamModelResolver getModelResolver()
  {
    return modelResolver;
  }

  void modelChanged(java.util.Map<String, Object> result)
  {
    if (!("applied".equals(result.get("state")) || "partial".equals(result.get("state")))) return;
    java.util.Set<String> affected = new java.util.LinkedHashSet<String>();
    Object changes = result.get("changes");
    if (changes instanceof java.util.List)
      for (Object item : (java.util.List<?>)changes)
        if (item instanceof java.util.Map)
          for (String key : new String[]{"ord", "parent", "source", "target", "destination"})
          {
            Object value = ((java.util.Map<?, ?>)item).get(key);
            if (value instanceof String && ((String)value).startsWith("slot:/")) affected.add((String)value);
          }
    subscriptions.modelChanged(affected);
  }

  BBaskStreamService getService()
  {
    return service;
  }

  boolean onOpen(BaskStreamClientSession session)
  {
    return subscriptions.register(session);
  }

  void onClose(BaskStreamClientSession session)
  {
    subscriptions.unregister(session);
  }

  void onSubscriptionCountChanged()
  {
    subscriptions.refreshMetrics();
  }

  java.util.concurrent.Executor getEventPool()
  {
    return eventPool;
  }

  ScheduledFuture<?> schedule(Runnable task, long delayMillis)
  {
    long safeDelay = Math.max(0L, delayMillis);
    return scheduler.schedule(new Runnable()
    {
      @Override
      public void run()
      {
        try
        {
          task.run();
        }
        catch (Throwable e)
        {
          service.LOG.log(Level.WARNING, "baskStream scheduled task failed", e);
        }
      }
    }, safeDelay, TimeUnit.MILLISECONDS);
  }

  BaskStreamClientSession buildSession(BaskStreamTransport transport, Principal principal, Locale requestLocale)
      throws BaskStreamProtocolException
  {
    if (!(principal instanceof BUser))
    {
      throw new BaskStreamProtocolException("auth_required", "Authenticated Niagara user is required.");
    }

    BUser user = (BUser) principal;
    String language = user.getLanguage();
    if (language == null || language.trim().length() == 0)
    {
      language = requestLocale == null ? null : requestLocale.toLanguageTag();
    }
    BasicContext context = language == null || language.trim().length() == 0
        ? new BasicContext(user)
        : new BasicContext(user, language);

    return new BaskStreamClientSession(this, transport, user, context);
  }

  BaskStreamJettyTransport getTransport()
  {
    return transport;
  }

  int getActiveConnectionCount()
  {
    return subscriptions.getActiveConnectionCount();
  }

  int getConnectionCountForUser(String userName)
  {
    return subscriptions.getConnectionCountForUser(userName);
  }

  void stop()
  {
    subscriptions.shutdown();
    scheduler.shutdownNow();
    eventPool.shutdownNow();
    transport.stop();
  }

  private static final class BaskStreamThreadFactory implements ThreadFactory
  {
    private final String prefix;
    private int next;

    BaskStreamThreadFactory(String prefix)
    {
      this.prefix = prefix;
    }

    @Override
    public synchronized Thread newThread(Runnable task)
    {
      Thread thread = new Thread(task, prefix + (++next));
      thread.setDaemon(true);
      return thread;
    }
  }

}
