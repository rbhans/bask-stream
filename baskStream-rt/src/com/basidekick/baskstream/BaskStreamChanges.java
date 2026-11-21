package com.basidekick.baskstream;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.baja.sys.Context;

/**
 * Runs a kept change later, with the permissions of the person who approved it, and works out how
 * a change can be put back. {@link BaskStreamAgents} decides who may ask for what; this class only
 * calls the same resolvers the request handlers call, so a kept change passes every check a direct
 * one does.
 *
 * What can be put back: a point command (the old value at the same level), a station file that
 * was created or whose old content was kept, a weekly schedule, tags, added relations, and the
 * create, update, rename, move, link and slot steps of a model plan. Alarm acknowledgements,
 * discovery, deleted files, removed relations and a plan's delete and invoke steps cannot.
 */
final class BaskStreamChanges
{
  /** The largest request a waiting change may hold, encoded. Larger ones are refused, not kept. */
  static final int MAX_KEPT_REQUEST_BYTES = 256 * 1024;
  /** The largest undo a decided change may hold, encoded. */
  static final int MAX_KEPT_UNDO_BYTES = 64 * 1024;

  private final BaskStreamWebSocketRuntime runtime;
  private final BBaskStreamService service;

  BaskStreamChanges(BaskStreamWebSocketRuntime runtime)
  {
    this.runtime = runtime;
    this.service = runtime.getService();
  }

  /** The kind of work an operation is, as rules and the view name it. */
  static String kindOf(String op)
  {
    if ("write".equals(op)) return "points";
    String setting = BaskStreamAgents.DIRECT_SETTINGS.get(op);
    if ("agentDirectFiles".equals(setting)) return "files";
    if ("agentDirectDiscovery".equals(setting)) return "discovery";
    if ("agentDirectModelEdits".equals(setting)) return "modelEdits";
    if ("agentDirectTags".equals(setting)) return "tags";
    if ("agentDirectSchedules".equals(setting)) return "schedules";
    if ("agentDirectAlarms".equals(setting)) return "alarms";
    return null;
  }

  // ---- Running a change ------------------------------------------------------------------------

  /**
   * Makes the change a request asks for, as this user. The result is what the operation's own
   * reply carries. {@code restore_file} and {@code plan} are not protocol operations: they are
   * the two shapes an undo can take that no single request expresses.
   */
  Map<String, Object> run(String op, Map<String, Object> request, Context cx) throws Exception
  {
    String user = cx.getUser().getUsername();
    BaskStreamCodec codec = runtime.getCodec();
    if ("write".equals(op))
      return runtime.getWriteResolver().writeSingle(BaskStreamWriteResolver.specPoint(request), request, cx);
    if ("write_file".equals(op)) return map("file", runtime.getFileResolver().write(request, cx));
    if ("delete_file".equals(op)) return map("file", runtime.getFileResolver().delete(request, cx));
    if ("restore_file".equals(op))
    {
      byte[] old = runtime.getFileResolver().readBytes(request.get("backup"), cx);
      Map<String, Object> write = map("path", request.get("path"), "base64", Base64.getEncoder().encodeToString(old),
          "overwrite", Boolean.TRUE, "backup", Boolean.TRUE);
      return map("file", runtime.getFileResolver().write(write, cx));
    }
    if ("write_px".equals(op)) return runtime.getGraphicsResolver().writePx(request, cx);
    if ("attach_px_view".equals(op)) return map("views", runtime.getGraphicsResolver().attachViews(request, cx));
    if ("write_tags".equals(op)) return map("targets", runtime.getTagResolver().writeTags(request, cx));
    if ("write_relations".equals(op)) return map("targets", runtime.getTagResolver().writeRelations(request, cx));
    if ("write_schedule".equals(op))
      return map("schedule", runtime.getScheduleResolver().writeSchedule(codec.optionalString(request, "ord"),
          request.get("days"), request.get("dryRun"), cx));
    if (op.startsWith("ack_alarm") || op.startsWith("clear_alarm"))
      return map("alarms", runtime.getAlarmResolver().alarmActionRequest(op.startsWith("ack") ? "ack_alarm" : "clear_alarm",
          request.containsKey("uuids") ? request.get("uuids") : request.get("uuid"), request.get("filter"),
          codec.optionalString(request, "scope"), request.get("limit"), codec.optionalString(request, "source"),
          request.get("dryRun"), cx, user));
    if ("discover".equals(op)) return map("discovery", runtime.getJobResolver().discover(request, cx));
    if ("cancel_job".equals(op)) return map("job", runtime.getJobResolver().cancel(request, cx));
    if ("apply_model_changes".equals(op)) return runPlan(request, cx, true);
    if ("plan".equals(op)) return runPlan(request, cx, false);
    throw new BaskStreamProtocolException("bad_request", "A change of kind '" + op + "' cannot be kept and run later.");
  }

  /**
   * Applies a kept plan as this user. The plan is previewed again from the change specs the agent
   * sent; when {@code mustMatch} is set it is applied only if that preview shows the same
   * differences the agent's did, so a person approves exactly what they were shown. An agent's plan
   * keeps the agent restrictions (it may not command a writable point or edit security).
   */
  private Map<String, Object> runPlan(Map<String, Object> kept, Context cx, boolean mustMatch) throws Exception
  {
    BaskStreamModelResolver model = runtime.getModelResolver();
    service.requireModelEditsEnabled();
    model.agentCall(mustMatch);
    try
    {
      Map<String, Object> plan;
      try
      {
        plan = model.preview(map("changes", kept.get("changes")), cx);
      }
      catch (BaskStreamProtocolException e)
      {
        throw e;
      }
      catch (Exception e)
      {
        // Niagara's own refusals carry little more than a path; say what it means here.
        throw new BaskStreamProtocolException("stale_plan", "The plan can no longer be previewed as it was ("
            + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()) + "). The station has changed since; preview it again.");
      }
      if (mustMatch && !sameDifferences(plan.get("changes"), kept.get("diffs")))
      {
        try { model.cancel(map("planId", plan.get("planId")), cx); } catch (Exception ignored) { /* it expires by itself */ }
        throw new BaskStreamProtocolException("stale_plan",
            "The station has changed since the agent previewed this plan, so it would no longer do the same thing. The agent has to preview it again.");
      }
      Map<String, Object> result = model.apply(map("planId", plan.get("planId"), "planHash", plan.get("planHash"),
          "idempotencyKey", UUID.randomUUID().toString()), cx);
      runtime.modelChanged(result);
      if (!"applied".equals(result.get("state")))
        throw new BaskStreamProtocolException("plan_partial", "The plan stopped part way (state " + result.get("state")
            + "). Read the station before trying anything else; nothing is retried automatically.", map("result", slim(result)));
      return slim(result);
    }
    finally
    {
      model.agentCall(false);
    }
  }

  /** A plan result without each step's before/after values and component snapshot. */
  @SuppressWarnings("unchecked")
  static Map<String, Object> slim(Map<String, Object> result)
  {
    Map<String, Object> out = new LinkedHashMap<String, Object>(result);
    for (String key : new String[] { "changes", "results" })
    {
      if (!(out.get(key) instanceof List)) continue;
      List<Object> items = new ArrayList<Object>();
      for (Object item : (List<Object>)out.get(key))
      {
        if (item instanceof Map)
        {
          Map<Object, Object> copy = new LinkedHashMap<Object, Object>((Map<Object, Object>)item);
          copy.remove("before"); copy.remove("after"); copy.remove("snapshot"); copy.remove("dependencies");
          items.add(copy);
        }
        else items.add(item);
      }
      out.put(key, items);
    }
    return out;
  }

  /** True when two lists of plan differences say the same thing. Value fingerprints are left out: they change at each start. */
  private boolean sameDifferences(Object a, Object b) throws Exception
  {
    return digest(a).equals(digest(b));
  }

  /** A digest that is the same before and after a value is stored and read back. */
  String digest(Object value) throws Exception
  {
    BaskStreamCodec codec = runtime.getCodec();
    Object plain = codec.decodeMessage(codec.encodeMessage(map("v", stripHashes(value))), Integer.MAX_VALUE).get("v");
    return BaskStreamModelPlans.digest(plain);
  }

  private static Object stripHashes(Object value)
  {
    if (value instanceof Map)
    {
      Map<String, Object> out = new LinkedHashMap<String, Object>();
      for (Map.Entry<?, ?> entry : ((Map<?, ?>)value).entrySet())
      {
        String key = String.valueOf(entry.getKey());
        if (!key.endsWith("Hash")) out.put(key, stripHashes(entry.getValue()));
      }
      return out;
    }
    if (value instanceof List)
    {
      List<Object> out = new ArrayList<Object>();
      for (Object item : (List<?>)value) out.add(stripHashes(item));
      return out;
    }
    return value;
  }

  int encodedSize(Object value)
  {
    try
    {
      return runtime.getCodec().encodeMessage(map("v", value)).length;
    }
    catch (Exception e)
    {
      return Integer.MAX_VALUE;
    }
  }

  // ---- Checking a change before it is kept ------------------------------------------------------

  /**
   * Tries a change the agent may not make directly, without making it, as the agent: the target has
   * to exist, be inside the agent's reach and be one its Niagara roles allow. A person is not asked
   * to decide a change that could never run. Operations with no dry run are checked when they run.
   */
  @SuppressWarnings("unchecked")
  void rehearse(String op, Map<String, Object> request, Context cx) throws Exception
  {
    if ("write_tags".equals(op) || "write_relations".equals(op))
    {
      // No dry run here: reading each target as the agent shows it exists and is inside its reach.
      Object raw = request.get("targets");
      List<Object> specs = raw instanceof List ? (List<Object>)raw : java.util.Collections.<Object>singletonList(request);
      for (Object item : specs)
      {
        if (!(item instanceof Map)) continue;
        Map<String, Object> spec = (Map<String, Object>)item;
        Object ord = spec.get("ord") == null ? spec.get("point") : spec.get("ord");
        for (Object target : runtime.getTagResolver().readTags(map("ord", ord, "includeRelations", Boolean.FALSE), cx))
        {
          Map<String, Object> entry = (Map<String, Object>)target;
          if (Boolean.FALSE.equals(entry.get("ok")))
            throw new BaskStreamProtocolException(String.valueOf(entry.get("code")), String.valueOf(entry.get("message")));
        }
      }
      return;
    }
    if (!BaskStreamAgents.DRY_RUN_OPS.contains(op)) return;
    Map<String, Object> trial = new LinkedHashMap<String, Object>(request);
    trial.put("dryRun", Boolean.TRUE);
    run(op, trial, cx);
  }

  // ---- Putting a change back --------------------------------------------------------------------

  /**
   * What to remember before a change is made, so it can be put back. The result is handed to
   * {@link #undoAfter} with the change's own result.
   */
  @SuppressWarnings("unchecked")
  Map<String, Object> undoBefore(String op, Map<String, Object> request, Context cx)
  {
    try
    {
      if ("write".equals(op))
      {
        Map<String, Object> spec = runtime.getWriteResolver().undoSpec(BaskStreamWriteResolver.specPoint(request), request, cx);
        return spec == null ? nothing("The point had nothing at that level to go back to.") : map("op", "write", "request", spec);
      }
      if ("write_schedule".equals(op))
      {
        Map<String, Object> trial = new LinkedHashMap<String, Object>(request);
        trial.put("dryRun", Boolean.TRUE);
        Map<String, Object> shown = (Map<String, Object>)run(op, trial, cx).get("schedule");
        Map<String, Object> days = new LinkedHashMap<String, Object>();
        Map<String, Object> wrote = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Object> day : ((Map<String, Object>)shown.get("days")).entrySet())
        {
          Map<String, Object> change = (Map<String, Object>)day.getValue();
          days.put(day.getKey(), scheduleEntries(change.get("before")));
          wrote.put(day.getKey(), scheduleEntries(change.get("after")));
        }
        return map("op", "write_schedule", "request", map("ord", request.get("ord"), "days", days), "wrote", wrote);
      }
      if ("write_tags".equals(op)) return tagUndo(request, cx);
      if ("write_relations".equals(op)) return relationUndo(request);
      if ("apply_model_changes".equals(op)) return planUndo((List<Object>)request.get("diffs"));
      if ("write_file".equals(op) || "write_px".equals(op)) return map("op", "pending");
      if ("delete_file".equals(op)) return nothing("A deleted file is not kept.");
      if (op.startsWith("ack_alarm") || op.startsWith("clear_alarm")) return nothing("An alarm cannot be un-acknowledged or brought back.");
      if ("discover".equals(op) || "cancel_job".equals(op)) return nothing("A job cannot be taken back.");
      return nothing("This kind of change is not put back by baskStream.");
    }
    catch (Exception e)
    {
      return nothing("What was there before could not be read: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
  }

  /** Finishes an undo once the change has been made and its result is known. */
  @SuppressWarnings("unchecked")
  Map<String, Object> undoAfter(String op, Map<String, Object> request, Map<String, Object> draft, Map<String, Object> result, Context cx)
  {
    if (draft == null) return null;
    try
    {
      if ("write".equals(op) && draft.get("request") != null)
      {
        // What would now put the point back to what was just written: compared again before a revert.
        Map<String, Object> wrote = runtime.getWriteResolver().undoSpec(BaskStreamWriteResolver.specPoint(request), request, cx);
        if (wrote != null) draft.put("wrote", wrote);
        return draft;
      }
      if (!"pending".equals(draft.get("op"))) return draft;
      Map<String, Object> file = result == null ? null : (Map<String, Object>)result.get("file");
      if (file == null) return nothing("The file's result was not kept.");
      Object path = file.get("path");
      Map<String, Object> wrote = map("sha256", fileDigest(path, cx));
      if (Boolean.TRUE.equals(file.get("created"))) return map("op", "delete_file", "request", map("path", path), "wrote", wrote);
      if (file.get("backup") != null)
        return map("op", "restore_file", "request", map("path", path, "backup", file.get("backup")), "wrote", wrote);
      return nothing("The file was replaced without keeping its old content.");
    }
    catch (Exception e)
    {
      return nothing("What was written could not be read back: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
  }

  /**
   * Why a change cannot be put back as recorded because its target has changed since, or null.
   * Points, schedules and files are compared; tags, relations and plans are put back as recorded,
   * and a plan's own preview refuses a step whose target is gone.
   */
  @SuppressWarnings("unchecked")
  String changedSince(Map<String, Object> undo, Context cx)
  {
    Object wrote = undo.get("wrote");
    if (wrote == null) return null;
    try
    {
      String op = String.valueOf(undo.get("op"));
      Map<String, Object> request = (Map<String, Object>)undo.get("request");
      if ("write".equals(op))
      {
        Map<String, Object> now = runtime.getWriteResolver().undoSpec(BaskStreamWriteResolver.specPoint(request), request, cx);
        return now != null && digest(now).equals(digest(wrote)) ? null : "The point has been commanded again since this change.";
      }
      if ("write_schedule".equals(op))
      {
        Map<String, Object> trial = new LinkedHashMap<String, Object>(request);
        trial.put("dryRun", Boolean.TRUE);
        Map<String, Object> shown = (Map<String, Object>)run(op, trial, cx).get("schedule");
        Map<String, Object> now = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Object> day : ((Map<String, Object>)shown.get("days")).entrySet())
          now.put(day.getKey(), scheduleEntries(((Map<String, Object>)day.getValue()).get("before")));
        return digest(now).equals(digest(wrote)) ? null : "The schedule has been edited again since this change.";
      }
      if ("delete_file".equals(op) || "restore_file".equals(op))
      {
        Object was = ((Map<String, Object>)wrote).get("sha256");
        return was != null && was.equals(fileDigest(request.get("path"), cx)) ? null : "The file has been changed again since this change.";
      }
      return null;
    }
    catch (Exception e)
    {
      return "What is there now could not be read: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private String fileDigest(Object path, Context cx) throws Exception
  {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(runtime.getFileResolver().readBytes(path, cx));
    StringBuilder out = new StringBuilder();
    for (byte b : hash) out.append(String.format("%02x", b & 255));
    return out.toString();
  }

  /** A day's entries as write_schedule takes them: start, finish and the plain value. */
  private static List<Object> scheduleEntries(Object shown)
  {
    List<Object> entries = new ArrayList<Object>();
    if (!(shown instanceof List)) return entries;
    for (Object item : (List<?>)shown)
    {
      if (!(item instanceof Map)) continue;
      Map<?, ?> entry = (Map<?, ?>)item;
      Object value = entry.get("effectiveValue");
      if (value instanceof Map) value = ((Map<?, ?>)value).get("value");
      entries.add(map("start", entry.get("startTime"), "finish", entry.get("finishTime"), "value", value));
    }
    return entries;
  }

  /** For each tag a request sets or removes: set it back to what it was, or remove it if it was not there. */
  @SuppressWarnings("unchecked")
  private Map<String, Object> tagUndo(Map<String, Object> request, Context cx) throws Exception
  {
    List<Object> targets = new ArrayList<Object>();
    Object raw = request.get("targets");
    List<Object> specs = raw instanceof List ? (List<Object>)raw : java.util.Collections.<Object>singletonList(request);
    for (Object item : specs)
    {
      Map<String, Object> spec = (Map<String, Object>)item;
      Object ord = spec.get("ord") == null ? spec.get("point") : spec.get("ord");
      Map<String, Map<String, Object>> direct = new LinkedHashMap<String, Map<String, Object>>();
      for (Object target : runtime.getTagResolver().readTags(map("ord", ord, "includeRelations", Boolean.FALSE), cx))
      {
        Object tags = ((Map<String, Object>)target).get("tags");
        if (!(tags instanceof List)) continue;
        for (Object tag : (List<Object>)tags)
        {
          Map<String, Object> wire = (Map<String, Object>)tag;
          if ("direct".equals(wire.get("source"))) direct.put(String.valueOf(wire.get("id")), wire);
        }
      }
      List<Object> set = new ArrayList<Object>();
      List<Object> remove = new ArrayList<Object>();
      List<Object> touched = new ArrayList<Object>();
      if (spec.get("set") instanceof List) touched.addAll((List<Object>)spec.get("set"));
      if (spec.get("remove") instanceof List) touched.addAll((List<Object>)spec.get("remove"));
      for (Object one : touched)
      {
        String id = one instanceof Map ? String.valueOf(((Map<String, Object>)one).get("id") == null
            ? ((Map<String, Object>)one).get("name") : ((Map<String, Object>)one).get("id")) : String.valueOf(one);
        Map<String, Object> was = direct.get(id);
        if (was == null) remove.add(id);
        else set.add(map("id", id, "value", was.get("value"), "valueType", was.get("valueType")));
      }
      Map<String, Object> back = map("ord", ord);
      if (!set.isEmpty()) back.put("set", set);
      if (!remove.isEmpty()) back.put("remove", remove);
      if (back.size() > 1) targets.add(back);
    }
    return targets.isEmpty() ? nothing("No tag was named.") : map("op", "write_tags", "request", map("targets", targets));
  }

  /** Added relations can be removed again; removed ones are not kept. */
  @SuppressWarnings("unchecked")
  private Map<String, Object> relationUndo(Map<String, Object> request)
  {
    List<Object> targets = new ArrayList<Object>();
    List<Object> lost = new ArrayList<Object>();
    Object raw = request.get("targets");
    List<Object> specs = raw instanceof List ? (List<Object>)raw : java.util.Collections.<Object>singletonList(request);
    for (Object item : specs)
    {
      Map<String, Object> spec = (Map<String, Object>)item;
      Object ord = spec.get("ord") == null ? spec.get("point") : spec.get("ord");
      List<Object> remove = new ArrayList<Object>();
      if (spec.get("add") instanceof List)
        for (Object add : (List<Object>)spec.get("add"))
          remove.add(map("id", ((Map<String, Object>)add).get("id"), "endpoint", ((Map<String, Object>)add).get("endpoint")));
      if (spec.get("remove") instanceof List && !((List<Object>)spec.get("remove")).isEmpty())
        lost.add("relations removed from " + ord);
      if (!remove.isEmpty()) targets.add(map("ord", ord, "remove", remove));
    }
    if (targets.isEmpty()) return nothing("A removed relation is not kept.");
    Map<String, Object> undo = map("op", "write_relations", "request", map("targets", targets));
    if (!lost.isEmpty()) undo.put("notReverted", lost);
    return undo;
  }

  /**
   * The plan that puts a plan back, last step first. Steps that cannot be put back are listed in
   * {@code notReverted}; when none can, there is no undo.
   */
  @SuppressWarnings("unchecked")
  static Map<String, Object> planUndo(List<Object> diffs)
  {
    List<Object> back = new ArrayList<Object>();
    List<Object> lost = new ArrayList<Object>();
    if (diffs != null)
    {
      for (int i = diffs.size() - 1; i >= 0; i--)
      {
        Map<String, Object> diff = (Map<String, Object>)diffs.get(i);
        String action = String.valueOf(diff.get("action"));
        Object ord = diff.get("ord");
        if ("create".equals(action) || "clone".equals(action) || "create_hierarchy".equals(action))
          back.add(map("action", "delete", "ord", ord, "recursive", Boolean.TRUE));
        else if ("update".equals(action) || "configure_hierarchy".equals(action))
        {
          Map<String, Object> properties = new LinkedHashMap<String, Object>();
          if (diff.get("properties") instanceof List)
            for (Object edit : (List<Object>)diff.get("properties"))
              properties.put(String.valueOf(((Map<String, Object>)edit).get("property")), ((Map<String, Object>)edit).get("before"));
          back.add(map("action", action, "ord", ord, "properties", properties));
        }
        else if ("rename".equals(action))
          back.add(map("action", "rename", "ord", diff.get("destination"), "name", lastName(String.valueOf(ord))));
        else if ("move".equals(action))
          back.add(map("action", "move", "ord", diff.get("destination"), "parent", parentOrd(String.valueOf(ord)), "name", lastName(String.valueOf(ord))));
        else if ("create_link".equals(action))
          back.add(map("action", "delete_link", "ord", diff.get("target"), "slot", diff.get("name")));
        else if ("add_slot".equals(action))
          back.add(map("action", "remove_slot", "ord", ord, "slot", diff.get("slot")));
        else if ("reorder".equals(action) && diff.get("beforeSlots") != null)
          back.add(map("action", "reorder", "ord", ord, "slots", diff.get("beforeSlots")));
        else
          lost.add(action + " " + (ord == null ? "" : ord) + (diff.get("slot") == null ? "" : "." + diff.get("slot")));
      }
    }
    if (back.isEmpty()) return nothing(lost.isEmpty() ? "The plan had no steps." : "None of the plan's steps can be put back: " + lost);
    Map<String, Object> undo = map("op", "plan", "request", map("changes", back));
    if (!lost.isEmpty()) undo.put("notReverted", lost);
    return undo;
  }

  private static String lastName(String ord)
  {
    int slash = ord.lastIndexOf('/');
    return slash < 0 ? ord : ord.substring(slash + 1);
  }

  private static String parentOrd(String ord)
  {
    int slash = ord.lastIndexOf('/');
    return slash <= "slot:".length() ? "slot:/" : ord.substring(0, slash);
  }

  private static Map<String, Object> nothing(String why)
  {
    return map("op", null, "why", why);
  }

  static Map<String, Object> map(Object... pairs)
  {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) m.put((String)pairs[i], pairs[i + 1]);
    return m;
  }
}
