package com.basidekick.baskstream;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class BaskStreamSubscriptionManager
{
  private final BBaskStreamService service;
  private final Set<BaskStreamClientSession> sessions =
      Collections.newSetFromMap(new ConcurrentHashMap<BaskStreamClientSession, Boolean>());

  BaskStreamSubscriptionManager(BBaskStreamService service)
  {
    this.service = service;
  }

  synchronized boolean register(BaskStreamClientSession session)
  {
    if (getActiveConnectionCount() >= service.getMaxConnectionsValue())
    {
      refreshMetrics();
      return false;
    }

    int perUserCap = service.getMaxConnectionsPerUserValue();
    if (perUserCap > 0 && getConnectionCountForUser(session.getUsername()) >= perUserCap)
    {
      refreshMetrics();
      return false;
    }

    boolean added = sessions.add(session);
    refreshMetrics();
    return added;
  }

  int getConnectionCountForUser(String username)
  {
    if (username == null)
    {
      return 0;
    }
    int count = 0;
    for (BaskStreamClientSession session : sessions)
    {
      if (username.equals(session.getUsername()))
      {
        count++;
      }
    }
    return count;
  }

  void unregister(BaskStreamClientSession session)
  {
    sessions.remove(session);
    refreshMetrics();
  }

  void refreshMetrics()
  {
    int totalSubscriptions = 0;
    for (BaskStreamClientSession session : sessions)
    {
      totalSubscriptions += session.getSubscriptionCount();
    }
    service.setRuntimeMetrics(sessions.size(), totalSubscriptions);
  }

  int getActiveConnectionCount()
  {
    return sessions.size();
  }

  void shutdown()
  {
    for (BaskStreamClientSession session : sessions.toArray(new BaskStreamClientSession[0]))
    {
      session.close("service stopped");
    }
    sessions.clear();
    refreshMetrics();
  }
}
