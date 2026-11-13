package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.baja.collection.BITable;
import javax.baja.collection.Column;
import javax.baja.collection.Row;
import javax.baja.collection.TableCursor;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.BComponent;
import javax.baja.sys.BIObject;
import javax.baja.sys.BObject;
import javax.baja.sys.Context;

/**
 * The {@code query} operation: a BQL select or a NEQL tag query, run as the session's user.
 * Read-only. Rows whose object is a component the user may not see are dropped.
 */
final class BaskStreamQueryResolver
{
  static final int DEFAULT_LIMIT = 500;
  static final int MAX_LIMIT = 5000;
  static final int MAX_QUERY_LENGTH = 4000;
  static final int DEFAULT_TIMEOUT_MILLIS = 10000;
  static final int MAX_TIMEOUT_MILLIS = 60000;

  private final BBaskStreamService service;
  private final BaskStreamAuthorizer authorizer;

  BaskStreamQueryResolver(BBaskStreamService service)
  {
    this.service = service;
    this.authorizer = new BaskStreamAuthorizer(service);
  }

  Map<String, Object> query(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String bql = BaskStreamWire.string(request, "bql");
    String neql = BaskStreamWire.string(request, "neql");
    if ((bql == null) == (neql == null))
    {
      throw new BaskStreamProtocolException("bad_request", "Send exactly one of 'bql' or 'neql'.");
    }
    String language = bql != null ? "bql" : "neql";
    String text = bql != null ? bql : neql;
    if (text.length() > MAX_QUERY_LENGTH || text.indexOf('|') >= 0)
    {
      // A "|" would start another ORD query after this one.
      throw new BaskStreamProtocolException("bad_query", "A query can be up to " + MAX_QUERY_LENGTH + " characters and cannot contain '|'.");
    }

    String requested = BaskStreamWire.string(request, "ord");
    String base = BaskStreamAccessPolicy.localSlotOrd(requested == null ? "slot:/" : requested);
    if (base == null || base.indexOf('|') >= 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'ord' must be a slot ORD on this station, e.g. slot:/Drivers.");
    }
    if (!BaskStreamAccessPolicy.isDefaultWideOpen(service))
    {
      // A BQL column can walk from a row to any other component, so it cannot be held inside a
      // narrowed path policy. NEQL only returns entities, which are checked one by one.
      if (bql != null)
      {
        throw new BaskStreamProtocolException("query_not_allowed", "BQL is unavailable while allowedPathPatterns is narrowed; use neql, search or browse.");
      }
      if (!BaskStreamAccessPolicy.isAllowed(service, base))
      {
        throw new BaskStreamProtocolException("forbidden_component", "ORD is outside the allowedPathPatterns policy.");
      }
    }
    int limit = BaskStreamWire.integer(request, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    long deadline = System.currentTimeMillis()
        + BaskStreamWire.integer(request, "timeoutMillis", DEFAULT_TIMEOUT_MILLIS, 100, MAX_TIMEOUT_MILLIS);

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("language", language);
    result.put("ord", base);
    try
    {
      OrdTarget baseTarget = BOrd.make(base).resolve(service, context);
      if (!baseTarget.canRead())
      {
        throw new BaskStreamProtocolException("forbidden_component", "ORD is not readable for the authenticated user.");
      }
      BObject resolved = BOrd.make(base + "|" + language + ":" + text).resolve(service, context).get();
      if (!(resolved instanceof BITable))
      {
        throw new BaskStreamProtocolException("bad_query", "The query did not return a table.");
      }
      BITable<?> table = (BITable<?>) resolved;
      if (bql != null) readTable(table, limit, deadline, context, result);
      else readEntities(table, limit, deadline, context, result);
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (RuntimeException e)
    {
      throw new BaskStreamProtocolException("bad_query", e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
    }
    return result;
  }

  private void readTable(BITable<?> table, int limit, long deadline, Context context, Map<String, Object> result)
  {
    Column[] columns = table.getColumns().list();
    List<Object> columnWire = new ArrayList<Object>(columns.length);
    for (Column column : columns)
    {
      Map<String, Object> entry = new LinkedHashMap<String, Object>();
      entry.put("name", column.getName());
      entry.put("display", column.getDisplayName(context));
      entry.put("typeSpec", column.getType() == null ? null : column.getType().toString());
      columnWire.add(entry);
    }

    List<Object> rows = new ArrayList<Object>();
    int hidden = 0;
    boolean truncated = false;
    String stopped = null;
    TableCursor<?> cursor = table.cursor();
    try
    {
      while (cursor.next())
      {
        if (rows.size() >= limit) { truncated = true; stopped = "limit"; break; }
        if (System.currentTimeMillis() > deadline || Thread.currentThread().isInterrupted()) { truncated = true; stopped = "timeout"; break; }
        Row<?> row = cursor.row();
        BIObject source = row.rowObject();
        if (source instanceof BComponent && !authorizer.canRead((BComponent) source, context))
        {
          hidden++;
          continue;
        }
        List<Object> cells = new ArrayList<Object>(columns.length);
        for (Column column : columns)
        {
          cells.add(cell(row.cell(column), column.getName(), context));
        }
        rows.add(cells);
      }
    }
    finally
    {
      cursor.close();
    }
    result.put("columns", columnWire);
    result.put("rows", rows);
    finish(result, rows.size(), hidden, truncated, stopped);
  }

  private void readEntities(BITable<?> table, int limit, long deadline, Context context, Map<String, Object> result)
  {
    List<Object> entities = new ArrayList<Object>();
    int hidden = 0;
    boolean truncated = false;
    String stopped = null;
    TableCursor<?> cursor = table.cursor();
    try
    {
      while (cursor.next())
      {
        if (entities.size() >= limit) { truncated = true; stopped = "limit"; break; }
        if (System.currentTimeMillis() > deadline || Thread.currentThread().isInterrupted()) { truncated = true; stopped = "timeout"; break; }
        BIObject source = cursor.row().rowObject();
        if (!(source instanceof BComponent) || ((BComponent) source).getSlotPath() == null
            || !authorizer.canRead((BComponent) source, context))
        {
          hidden++;
          continue;
        }
        BComponent component = (BComponent) source;
        Map<String, Object> entry = new LinkedHashMap<String, Object>();
        entry.put("ord", component.getSlotPathOrd().toString());
        entry.put("name", component.getName());
        entry.put("display", component.getDisplayName(context));
        entry.put("typeSpec", component.getType().toString());
        entities.add(entry);
      }
    }
    finally
    {
      cursor.close();
    }
    result.put("entities", entities);
    finish(result, entities.size(), hidden, truncated, stopped);
  }

  private static void finish(Map<String, Object> result, int count, int hidden, boolean truncated, String stopped)
  {
    result.put("count", Long.valueOf(count));
    result.put("hidden", Long.valueOf(hidden));
    result.put("truncated", Boolean.valueOf(truncated));
    if (stopped != null) result.put("stoppedBy", stopped);
  }

  /** A component in a cell becomes its ORD, and only when the user may see it. */
  private Object cell(BIObject value, String column, Context context)
  {
    if (value == null) return null;
    if (value instanceof BComponent)
    {
      BComponent component = (BComponent) value;
      return component.getSlotPath() != null && authorizer.canRead(component, context)
          ? component.getSlotPathOrd().toString() : null;
    }
    return value instanceof BObject ? BaskStreamWire.plain((BObject) value, column, context, 1) : String.valueOf(value);
  }
}
