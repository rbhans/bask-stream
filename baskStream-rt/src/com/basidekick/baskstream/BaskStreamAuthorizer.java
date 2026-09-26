package com.basidekick.baskstream;

import java.util.LinkedHashMap;
import java.util.Map;

import javax.baja.alarm.BAlarmClass;
import javax.baja.alarm.BAlarmRecord;
import javax.baja.alarm.BAlarmService;
import javax.baja.history.BIHistory;
import javax.baja.security.BIProtected;
import javax.baja.security.BPermissions;
import javax.baja.sys.Action;
import javax.baja.sys.BComponent;
import javax.baja.sys.BObject;
import javax.baja.sys.Context;
import javax.baja.sys.Flags;

/**
 * Answers "may this user see or do this?" for everything baskStream returns or changes.
 * It combines the service's {@code allowedPathPatterns} (via {@link BaskStreamAccessPolicy})
 * with Niagara's own permissions for the requesting user. Resolvers should ask here rather
 * than check permissions themselves, so related objects (parents, devices, extensions,
 * relation endpoints, hierarchy bindings) get the same treatment as the requested target.
 */
final class BaskStreamAuthorizer
{
  private final BBaskStreamService service;

  BaskStreamAuthorizer(BBaskStreamService service)
  {
    this.service = service;
  }

  /**
   * True when the user may see the object: components must be inside the path policy,
   * and protected objects need operator read. Plain values carry their owner's access.
   */
  boolean canRead(BObject object, Context context)
  {
    if (object == null)
    {
      return false;
    }
    if (object instanceof BComponent && !pathAllowed((BComponent) object))
    {
      return false;
    }
    return !(object instanceof BIProtected) || ((BIProtected) object).getPermissions(context).hasOperatorRead();
  }

  boolean pathAllowed(BComponent component)
  {
    if (BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      return true;
    }
    return component.getSlotPath() != null
        && BaskStreamAccessPolicy.isAllowed(service, component.getSlotPath().toString());
  }

  /** Stand-in for a related object the user may not see: says something is there, not what. */
  static Map<String, Object> redacted()
  {
    Map<String, Object> stub = new LinkedHashMap<String, Object>();
    stub.put("redacted", Boolean.TRUE);
    return stub;
  }

  /** Histories carry their own categories, so reading a point does not imply reading its history. */
  boolean canReadHistory(BIHistory history, Context context)
  {
    return history != null && history.getPermissions(context).hasOperatorRead();
  }

  /**
   * OrdTarget.canInvoke() on a component only checks operator invoke. Each action slot has
   * its own operator flag, so admin-only actions such as emergencyOverride need admin invoke.
   */
  boolean canInvoke(BComponent component, Action action, Context context)
  {
    BPermissions permissions = component.getPermissions(context);
    return Flags.isOperator(component, action) ? permissions.hasOperatorInvoke() : permissions.hasAdminInvoke();
  }

  /**
   * The user's permissions on an alarm record's alarm class, which is how Niagara scopes
   * alarm access: operator read to see, operator write to acknowledge, admin write to force-clear.
   * Pass a cache when checking many records in one request.
   */
  BPermissions alarmPermissions(BAlarmService alarmService, BAlarmRecord record, Context context,
      Map<String, BPermissions> cache)
  {
    String className = record.getAlarmClass();
    String key = className == null ? "" : className;
    BPermissions permissions = cache == null ? null : cache.get(key);
    if (permissions == null)
    {
      // lookupAlarmClass returns the default alarm class for unknown names.
      BAlarmClass alarmClass = alarmService.lookupAlarmClass(className);
      permissions = alarmClass == null ? BPermissions.none : alarmClass.getPermissions(context);
      if (cache != null)
      {
        cache.put(key, permissions);
      }
    }
    return permissions;
  }

  boolean canViewAlarm(BAlarmRecord record, Context context)
  {
    BAlarmService alarmService = BAlarmService.getService();
    return alarmService != null && alarmPermissions(alarmService, record, context, null).hasOperatorRead();
  }
}
