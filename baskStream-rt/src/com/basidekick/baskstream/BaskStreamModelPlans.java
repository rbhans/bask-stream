package com.basidekick.baskstream;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/** Station-instance plan ledger, deliberately independent of WebSocket sessions. */
final class BaskStreamModelPlans
{
  static final long PREVIEW_TTL = 5 * 60 * 1000L;
  static final long RESULT_TTL = 30 * 60 * 1000L;
  static final int MAX_PLANS = 32;
  interface Check { void run() throws Exception; }
  interface Work { Map<String, Object> run() throws Exception; }
  interface Audit { void record(String event, String plan, Object detail) throws Exception; }

  static final class Step
  {
    final Map<String, Object> diff;
    final Work work;
    Step(Map<String, Object> diff, Work work) { this.diff = diff; this.work = work; }
  }

  private static final class Plan
  {
    String id, user, hash, key, state = "preview";
    long expires;
    Check check;
    List<Step> steps;
    final List<Object> results = new ArrayList<Object>();
  }

  private final Map<String, Plan> plans = new LinkedHashMap<String, Plan>();
  private boolean applying;

  synchronized Map<String, Object> preview(String user, List<Step> steps, Check check,
      Audit audit, long now) throws Exception
  {
    expire(now);
    if (plans.size() >= MAX_PLANS) throw error("plan_limit", "Plan ledger is full; wait for expiry or cancel previews.");
    Plan p = new Plan();
    p.id = UUID.randomUUID().toString(); p.user = user; p.steps = steps; p.check = check;
    p.expires = now + PREVIEW_TTL;
    p.hash = digest(diffs(p));
    // Audit must accept the preview before it becomes applicable.
    audit.record("model_preview", p.id, diffs(p));
    plans.put(p.id, p);
    return wire(p);
  }

  Map<String, Object> apply(String user, String id, String hash, String key,
      Check gate, Audit audit, long now) throws Exception
  {
    final Plan p;
    synchronized (this)
    {
      p = find(user, id, now);
      if (!p.hash.equals(hash)) throw error("plan_mismatch", "The approved plan hash does not match.");
      if (key == null || key.length() < 1 || key.length() > 128)
        throw error("bad_request", "idempotencyKey must contain 1 to 128 characters.");
      if (p.key != null)
      {
        if (!p.key.equals(key)) throw error("idempotency_conflict", "This plan was already submitted with another key.");
        return wire(p); // Never execute twice, including an in-flight or uncertain step.
      }
      for (Plan other : plans.values())
        if (user.equals(other.user) && key.equals(other.key))
          throw error("idempotency_conflict", "This key belongs to another plan.");
      if (!"preview".equals(p.state)) throw error("plan_closed", "This plan cannot be applied.");
      if (applying) throw error("model_busy", "Another model plan is applying; inspect its outcome before submitting changes.");
      gate.run();
      p.check.run(); // Revalidate permissions, identities, properties and destination slots.
      audit.record("model_apply_started", p.id, p.hash);
      p.key = key; p.state = "applying"; p.expires = now + RESULT_TTL;
      applying = true;
    }
    try
    {
      for (int i = 0; i < p.steps.size(); i++)
      {
        Step step = p.steps.get(i);
        Map<String, Object> result = map("index", i, "action", step.diff.get("action"));
        try
        {
          gate.run();
          audit.record("model_step_started", p.id, map("index", i, "diff", step.diff));
          result.putAll(step.work.run());
          if (!result.containsKey("ok")) result.put("ok", Boolean.TRUE);
          // Retain outcome BEFORE audit/send can fail after a successful mutation.
          synchronized (this) { p.results.add(result); }
          audit.record("model_step_completed", p.id, result);
          if (Boolean.FALSE.equals(result.get("ok"))) { synchronized (this) { p.state = "partial"; } break; }
        }
        catch (Exception e)
        {
          synchronized (this)
          {
            if (!p.results.contains(result))
            {
              result.put("ok", Boolean.FALSE);
              result.put("code", e instanceof BaskStreamProtocolException ? ((BaskStreamProtocolException)e).getCode() : "model_change_failed");
              result.put("message", e instanceof BaskStreamProtocolException ? e.getMessage() : "Niagara rejected the operation; inspect station logs.");
              result.put("outcome", "unknown_or_partial");
              p.results.add(result);
            }
            else result.put("auditFailed", Boolean.TRUE);
            p.state = "partial";
          }
          break;
        }
      }
      synchronized (this) { if ("applying".equals(p.state)) p.state = "applied"; }
    }
    finally
    {
      synchronized (this)
      {
        if ("applying".equals(p.state)) p.state = "partial";
        p.expires = System.currentTimeMillis() + RESULT_TTL;
        // Release live component/credential references as soon as execution finishes.
        List<Step> metadata = new ArrayList<Step>();
        for (Step step : p.steps) metadata.add(new Step(step.diff, null));
        p.steps = metadata; p.check = null;
        applying = false;
      }
    }
    try { audit.record("model_apply_finished", p.id, map("state", p.state, "results", p.results)); }
    catch (Exception e) { /* Per-step outcomes remain retrievable even if final audit fails. */ }
    synchronized (this) { return wire(p); }
  }

  synchronized Map<String, Object> status(String user, String id, long now) throws Exception
  { return wire(find(user, id, now)); }

  synchronized Map<String, Object> cancel(String user, String id, long now) throws Exception
  {
    Plan p = find(user, id, now);
    if (!"preview".equals(p.state)) throw error("plan_closed", "Only an unapplied preview can be cancelled.");
    Map<String, Object> result = map("planId", id, "state", "cancelled");
    plans.remove(id);
    return result;
  }

  private Plan find(String user, String id, long now) throws Exception
  {
    expire(now);
    Plan p = plans.get(id);
    if (p == null || !p.user.equals(user)) throw error("plan_not_found", "Plan is unknown, expired, or belongs to another user. Do not replay uncertain edits.");
    return p;
  }
  private void expire(long now)
  { plans.values().removeIf(p -> p.expires <= now && !"applying".equals(p.state)); }
  private static List<Object> diffs(Plan p)
  {
    List<Object> out = new ArrayList<Object>();
    for (Step s : p.steps) out.add(s.diff);
    return out;
  }
  private static Map<String, Object> wire(Plan p)
  {
    List<Object> results = new ArrayList<Object>();
    for (Object result : p.results) results.add(new LinkedHashMap<Object, Object>((Map<?, ?>)result));
    return map("planId", p.id, "planHash", p.hash, "state", p.state, "expiresAt", p.expires,
        "changes", diffs(p), "results", results, "atomic", false,
        "unattempted", p.steps.size() - p.results.size(), "retryAutomatically", false);
  }
  static Map<String, Object> map(Object... pairs)
  {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) m.put((String)pairs[i], pairs[i+1]);
    return m;
  }
  static String digest(Object value) throws Exception
  {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(canonical(value).getBytes(StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    for (byte b : hash) out.append(String.format("%02x", b & 255));
    return out.toString();
  }
  private static String canonical(Object v)
  {
    if (v == null) return "n";
    if (v instanceof Map)
    {
      StringBuilder out = new StringBuilder("{");
      Map<String, Object> sorted = new TreeMap<String, Object>();
      for (Map.Entry<?, ?> e : ((Map<?, ?>)v).entrySet()) sorted.put(String.valueOf(e.getKey()), e.getValue());
      for (Map.Entry<String, Object> e : sorted.entrySet()) out.append(canonical(e.getKey())).append(canonical(e.getValue()));
      return out.append('}').toString();
    }
    if (v instanceof List)
    {
      StringBuilder out = new StringBuilder("[");
      for (Object item : (List<?>)v) out.append(canonical(item));
      return out.append(']').toString();
    }
    String s = v.toString();
    return v.getClass().getSimpleName() + ":" + s.length() + ":" + s;
  }
  static BaskStreamProtocolException error(String code, String message)
  { return new BaskStreamProtocolException(code, message); }
}
