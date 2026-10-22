package com.basidekick.baskstream;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

import javax.baja.sys.Clock;
import javax.baja.sys.Context;
import javax.baja.sys.Property;

/**
 * Optional controls for AI agents, layered on Niagara instead of replacing it.
 *
 * A session is an agent when its Niagara user is listed in {@code agentUsers} or it declares
 * itself one with {@code declare_actor}. Niagara roles still decide what any user may read, write
 * or invoke; this class only adds what roles cannot express: the actor behind a session, a reason
 * for each change, rate and value limits, and proposals a person approves before they run. Each
 * agent action also leaves one "Agent" record in the station's audit history, next to Niagara's own
 * record of the change. With no agent users and no declarations nothing here has any effect.
 */
final class BaskStreamAgents
{
  /** Operation name of the records added to the station's audit history. */
  static final String AUDIT_OPERATION = "Agent";
  static final int MAX_REASON_LENGTH = 300;
  static final int MAX_ACTOR_FIELD_LENGTH = 100;
  static final int BOUND_RULES = 4;
  /** Pending proposals one agent user may hold at a time. */
  static final int MAX_PENDING_PER_USER = 20;
  /** How long decided and expired proposals stay listed. */
  private static final long KEEP_DECIDED_MILLIS = 60L * 60L * 1000L;
  private static final int MAX_LISTED = 500;

  /** Who a session says is behind it. These are claims; the Niagara login stays the identity. */
  static final class Actor
  {
    final boolean agent;
    final String name;
    final String model;
    final String onBehalfOf;

    Actor(boolean agent, String name, String model, String onBehalfOf)
    {
      this.agent = agent;
      this.name = name;
      this.model = model;
      this.onBehalfOf = onBehalfOf;
    }

    Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("kind", agent ? "agent" : "person");
      wire.put("name", name);
      wire.put("model", model);
      wire.put("onBehalfOf", onBehalfOf);
      return wire;
    }
  }

  /** The limits that apply to agent writes, read from the service when needed. */
  static final class Limits
  {
    final boolean allowEmergency;
    final List<Bound> bounds;

    Limits(boolean allowEmergency, List<Bound> bounds)
    {
      this.allowEmergency = allowEmergency;
      this.bounds = bounds;
    }

    /** The first bound rule whose pattern matches the point, or null. */
    Bound boundFor(String pointOrd)
    {
      for (Bound bound : bounds)
        if (bound.pattern.matcher(pointOrd).matches()) return bound;
      return null;
    }
  }

  /** One {@code agentBoundN} rule: an ORD pattern and the values agents may write there. */
  static final class Bound
  {
    final String text;
    final Pattern pattern;
    final double min;
    final double max;

    Bound(String text, Pattern pattern, double min, double max)
    {
      this.text = text;
      this.pattern = pattern;
      this.min = min;
      this.max = max;
    }
  }

  /** A point write an agent asked for, waiting for a person. */
  static final class Proposal
  {
    final String id;
    final long createdAt;
    final long expiresAt;
    final String agentUser;
    final String sessionId;
    final Actor actor;
    final String point;
    final Map<String, Object> spec;
    final Map<String, Object> summary;
    final String reason;
    String status = "pending";
    String decidedBy;
    long decidedAt;
    String note;
    Map<String, Object> result;

    Proposal(String id, long createdAt, long expiresAt, String agentUser, String sessionId, Actor actor, String point,
        Map<String, Object> spec, Map<String, Object> summary, String reason)
    {
      this.id = id;
      this.createdAt = createdAt;
      this.expiresAt = expiresAt;
      this.agentUser = agentUser;
      this.sessionId = sessionId;
      this.actor = actor;
      this.point = point;
      this.spec = spec;
      this.summary = summary;
      this.reason = reason;
    }

    synchronized Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("id", id);
      wire.put("status", status);
      wire.put("point", point);
      wire.put("display", summary.get("display"));
      wire.put("action", summary.get("action"));
      wire.put("value", summary.get("value"));
      wire.put("description", summary.get("description"));
      wire.put("reason", reason);
      wire.put("agentUser", agentUser);
      wire.put("actor", actor == null ? null : actor.toWire());
      wire.put("createdAt", Long.valueOf(createdAt));
      wire.put("expiresAt", Long.valueOf(expiresAt));
      wire.put("decidedBy", decidedBy);
      wire.put("decidedAt", decidedAt == 0L ? null : Long.valueOf(decidedAt));
      wire.put("note", note);
      wire.put("result", result);
      return wire;
    }
  }

  private final BaskStreamWebSocketRuntime runtime;
  private final BBaskStreamService service;
  private final Map<String, Proposal> proposals = new LinkedHashMap<String, Proposal>();
  private final AtomicLong nextProposal = new AtomicLong();
  private final Map<String, ArrayDeque<Long>> recentChanges = new HashMap<String, ArrayDeque<Long>>();

  BaskStreamAgents(BaskStreamWebSocketRuntime runtime)
  {
    this.runtime = runtime;
    this.service = runtime.getService();
  }

  // ---- Settings (read by name, so this compiles before Slot-o-matic adds the getters) ----------

  private String stringSetting(String name, String fallback)
  {
    Property p = service.getProperty(name);
    return p == null ? fallback : service.getString(p);
  }

  private boolean booleanSetting(String name, boolean fallback)
  {
    Property p = service.getProperty(name);
    return p == null ? fallback : service.getBoolean(p);
  }

  private int intSetting(String name, int fallback)
  {
    Property p = service.getProperty(name);
    return p == null ? fallback : service.getInt(p);
  }

  Set<String> agentUsers()
  {
    Set<String> users = new LinkedHashSet<String>();
    for (String piece : stringSetting("agentUsers", "").split("[\\s,;]+"))
      if (piece.trim().length() > 0) users.add(piece.trim().toLowerCase(Locale.ROOT));
    return users;
  }

  boolean approvalRequired()
  {
    return booleanSetting("agentApprovalRequired", true);
  }

  boolean reasonRequired()
  {
    return booleanSetting("agentRequireReason", true);
  }

  int maxChangesPerMinute()
  {
    return Math.max(0, intSetting("agentMaxChangesPerMinute", 10));
  }

  long proposalMillis()
  {
    return Math.max(1, Math.min(1440, intSetting("agentProposalMinutes", 15))) * 60000L;
  }

  Limits limits()
  {
    List<Bound> bounds = new ArrayList<Bound>();
    for (int i = 1; i <= BOUND_RULES; i++)
    {
      Bound bound = parseBound(stringSetting("agentBound" + i, ""));
      if (bound != null) bounds.add(bound);
    }
    return new Limits(booleanSetting("agentAllowEmergency", false), bounds);
  }

  /**
   * Parses {@code "<ord pattern> <min>..<max>"}, e.g. {@code "slot:/Floor1/VAV_01/ZoneSP 68..76"};
   * {@code *} in the pattern matches anything, as in {@code allowedPathPatterns}. Either end may be
   * left empty. Blank or unreadable text is ignored, so a typo turns a rule off rather than blocking
   * every write; the capabilities reply lists the rules that were understood.
   */
  static Bound parseBound(String text)
  {
    if (text == null) return null;
    String trimmed = text.trim();
    int split = trimmed.lastIndexOf(' ');
    if (split <= 0) return null;
    String pattern = trimmed.substring(0, split).trim();
    String range = trimmed.substring(split + 1).trim();
    int dots = range.indexOf("..");
    if (dots < 0) return null;
    try
    {
      double min = range.substring(0, dots).trim().length() == 0 ? Double.NEGATIVE_INFINITY : Double.parseDouble(range.substring(0, dots).trim());
      double max = range.substring(dots + 2).trim().length() == 0 ? Double.POSITIVE_INFINITY : Double.parseDouble(range.substring(dots + 2).trim());
      if (Double.isNaN(min) || Double.isNaN(max) || min > max) return null;
      return new Bound(trimmed, Pattern.compile(BaskStreamAccessPolicy.toRegex(pattern)), min, max);
    }
    catch (NumberFormatException e)
    {
      return null;
    }
  }

  /** The agent settings as clients see them in {@code capabilities}. */
  Map<String, Object> describe(BaskStreamClientSession session)
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("isAgent", Boolean.valueOf(isAgent(session)));
    wire.put("actor", session.actor == null ? null : session.actor.toWire());
    wire.put("agentUsersConfigured", Boolean.valueOf(!agentUsers().isEmpty()));
    wire.put("approvalRequired", Boolean.valueOf(approvalRequired()));
    wire.put("reasonRequired", Boolean.valueOf(reasonRequired()));
    wire.put("maxChangesPerMinute", Long.valueOf(maxChangesPerMinute()));
    Limits limits = limits();
    wire.put("allowEmergency", Boolean.valueOf(limits.allowEmergency));
    List<String> bounds = new ArrayList<String>();
    for (Bound bound : limits.bounds) bounds.add(bound.text);
    wire.put("bounds", bounds);
    wire.put("pointLimitsFromFacets", Boolean.TRUE);
    wire.put("proposalMinutes", Long.valueOf(proposalMillis() / 60000L));
    wire.put("pendingProposals", Long.valueOf(pendingCount()));
    return wire;
  }

  // ---- Who is an agent --------------------------------------------------------------------------

  boolean isAgent(BaskStreamClientSession session)
  {
    Actor actor = session.actor;
    return (actor != null && actor.agent) || isAgentUser(session.getUsername());
  }

  boolean isAgentUser(String username)
  {
    return username != null && agentUsers().contains(username.toLowerCase(Locale.ROOT));
  }

  /** Builds an actor from a {@code declare_actor} request. */
  static Actor parseActor(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object kind = request.get("kind");
    if (kind != null && !"agent".equals(kind) && !"person".equals(kind))
      throw new BaskStreamProtocolException("bad_request", "Field 'kind' must be \"agent\" or \"person\".");
    return new Actor(!"person".equals(kind), actorField(request, "name"), actorField(request, "model"), actorField(request, "onBehalfOf"));
  }

  private static String actorField(Map<String, Object> request, String key) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null) return null;
    if (!(value instanceof String)) throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be a string.");
    String text = ((String)value).trim();
    if (text.length() > MAX_ACTOR_FIELD_LENGTH)
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' is longer than " + MAX_ACTOR_FIELD_LENGTH + " characters.");
    return text.length() == 0 ? null : text;
  }

  // ---- Checks before a change -------------------------------------------------------------------

  /** True for requests that change the station (not previews, reads or dry runs). */
  static boolean changesStation(String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
  {
    if (Boolean.TRUE.equals(request.get("dryRun"))) return false;
    return gate == BaskStreamOperations.Gate.WRITES || "apply_model_changes".equals(op);
  }

  /**
   * Runs before an agent's change. Point writes go on to {@link BaskStreamRequests#handleWrite},
   * which checks each point and turns it into a proposal when approval is required.
   */
  void beforeChange(BaskStreamClientSession session, String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
      throws BaskStreamProtocolException
  {
    if (!isAgent(session) || !changesStation(op, gate, request)) return;
    if ("approve_proposal".equals(op) || "reject_proposal".equals(op))
      throw new BaskStreamProtocolException("agent_cannot_approve", "Agents cannot approve or reject proposals; a person decides.");
    String reason = reason(request);
    if ("write".equals(op)) return;
    if (approvalRequired())
    {
      record(session, opTarget(request), op, null, reason, "refused", "approval_required");
      throw new BaskStreamProtocolException("approval_required",
          "With agentApprovalRequired on, agents can propose point writes but cannot " + op + " directly. Ask a person, or turn approval off.");
    }
    takeChangeSlot(session, op, opTarget(request), reason);
  }

  /** Records a completed direct change by an agent (point writes record each point themselves). */
  void afterChange(BaskStreamClientSession session, String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
  {
    if ("write".equals(op) || !isAgent(session) || !changesStation(op, gate, request)) return;
    record(session, opTarget(request), op, null, optionalReason(request), "completed", null);
  }

  /** The reason on a request, required for agents when {@code agentRequireReason} is on. */
  String reason(Map<String, Object> request) throws BaskStreamProtocolException
  {
    String reason = optionalReason(request);
    if (reason == null && reasonRequired())
      throw new BaskStreamProtocolException("reason_required", "Agents must say why: add a 'reason' to the request.");
    return reason;
  }

  static String optionalReason(Map<String, Object> request)
  {
    Object value = request.get("reason");
    if (!(value instanceof String)) return null;
    String text = ((String)value).trim();
    if (text.length() == 0) return null;
    return text.length() > MAX_REASON_LENGTH ? text.substring(0, MAX_REASON_LENGTH) : text;
  }

  /** Counts one change against {@code agentMaxChangesPerMinute} for the session's Niagara user. */
  void takeChangeSlot(BaskStreamClientSession session, String what, String target, String reason) throws BaskStreamProtocolException
  {
    int max = maxChangesPerMinute();
    if (max == 0) return;
    long now = Clock.millis();
    String key = session.getUsername().toLowerCase(Locale.ROOT);
    boolean allowed;
    synchronized (recentChanges)
    {
      ArrayDeque<Long> times = recentChanges.get(key);
      if (times == null) recentChanges.put(key, times = new ArrayDeque<Long>());
      while (!times.isEmpty() && now - times.peekFirst().longValue() >= 60000L) times.pollFirst();
      allowed = times.size() < max;
      if (allowed) times.addLast(Long.valueOf(now));
    }
    if (!allowed)
    {
      record(session, target, what, null, reason, "refused", "agent_rate_limited");
      throw new BaskStreamProtocolException("agent_rate_limited",
          "Agents may make " + max + " changes or proposals per minute (agentMaxChangesPerMinute). Try again shortly.");
    }
  }

  // ---- Proposals ---------------------------------------------------------------------------------

  Proposal propose(BaskStreamClientSession session, String point, Map<String, Object> spec, Map<String, Object> summary, String reason)
      throws BaskStreamProtocolException
  {
    String user = session.getUsername();
    synchronized (this)
    {
      int pending = 0;
      for (Proposal p : proposals.values())
        if ("pending".equals(p.status) && p.agentUser.equalsIgnoreCase(user)) pending++;
      if (pending >= MAX_PENDING_PER_USER)
        throw new BaskStreamProtocolException("agent_rate_limited",
            "This agent already has " + pending + " proposals waiting. Wait for a person to decide some.");
    }
    takeChangeSlot(session, String.valueOf(summary.get("action")), point, reason);
    long now = Clock.millis();
    Proposal proposal = new Proposal("P" + nextProposal.incrementAndGet(), now, now + proposalMillis(), user,
        session.getSessionId(), session.actor, point, new LinkedHashMap<String, Object>(spec), summary, reason);
    synchronized (this)
    {
      proposals.put(proposal.id, proposal);
    }
    record(session, point, String.valueOf(summary.get("action")), describeWrite(summary), reason, "proposed " + proposal.id, null);
    proposalsChanged(proposal);
    return proposal;
  }

  /**
   * Approves a proposal: the write runs now with the approver's Niagara permissions, so Niagara's
   * audit history shows the approver making the change. {@code session} is null when approved from
   * Workbench.
   */
  Map<String, Object> approve(String id, Context approver, BaskStreamClientSession session) throws BaskStreamProtocolException
  {
    Proposal proposal = decidable(id, approver, session);
    Map<String, Object> result = null;
    String failure = null;
    try
    {
      result = runtime.getWriteResolver().writeSingle(proposal.point, proposal.spec, approver);
    }
    catch (BaskStreamProtocolException e)
    {
      failure = e.getCode() + ": " + e.getMessage();
    }
    catch (RuntimeException e)
    {
      failure = "write_failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    String approverName = userName(approver);
    synchronized (proposal)
    {
      proposal.status = failure == null ? "approved" : "failed";
      proposal.decidedBy = approverName;
      proposal.decidedAt = Clock.millis();
      proposal.result = result;
      proposal.note = failure;
    }
    record(approverName, proposal.point, String.valueOf(proposal.summary.get("action")), proposal.actor, proposal.agentUser,
        describeWrite(proposal.summary), proposal.reason,
        (failure == null ? "approved " : "approval failed ") + proposal.id + " by " + approverName, failure);
    proposalsChanged(proposal);
    return proposal.toWire();
  }

  Map<String, Object> reject(String id, String note, Context decider, BaskStreamClientSession session) throws BaskStreamProtocolException
  {
    Proposal proposal = decidable(id, decider, session);
    String deciderName = userName(decider);
    synchronized (proposal)
    {
      proposal.status = "rejected";
      proposal.decidedBy = deciderName;
      proposal.decidedAt = Clock.millis();
      proposal.note = note == null || note.trim().length() == 0 ? null : note.trim();
    }
    record(deciderName, proposal.point, String.valueOf(proposal.summary.get("action")), proposal.actor, proposal.agentUser,
        describeWrite(proposal.summary), proposal.reason, "rejected " + proposal.id + " by " + deciderName, proposal.note);
    proposalsChanged(proposal);
    return proposal.toWire();
  }

  /** Finds a pending proposal and checks that this person may decide it. */
  private Proposal decidable(String id, Context decider, BaskStreamClientSession session) throws BaskStreamProtocolException
  {
    String name = userName(decider);
    if (name == null)
      throw new BaskStreamProtocolException("auth_required", "Deciding a proposal needs a signed-in Niagara user.");
    if (isAgentUser(name) || (session != null && isAgent(session)))
      throw new BaskStreamProtocolException("agent_cannot_approve", "Agents cannot approve or reject proposals; a person decides.");
    Proposal proposal;
    synchronized (this)
    {
      proposal = proposals.get(normalizeId(id));
    }
    if (proposal == null)
      throw new BaskStreamProtocolException("proposal_not_found", "No proposal " + id + ". Proposals do not survive a station restart.");
    // Deciding needs the same read access as seeing the point.
    runtime.getResolver().resolve(proposal.point, decider);
    synchronized (proposal)
    {
      if (!"pending".equals(proposal.status))
        throw new BaskStreamProtocolException("proposal_closed", "Proposal " + proposal.id + " is already " + proposal.status + ".");
      if (Clock.millis() >= proposal.expiresAt)
        throw new BaskStreamProtocolException("proposal_closed", "Proposal " + proposal.id + " has expired.");
      proposal.status = "deciding";
    }
    return proposal;
  }

  /** Accepts "P7", "p7" or "7". */
  static String normalizeId(String id)
  {
    String text = id == null ? "" : id.trim();
    if (text.length() > 0 && Character.isDigit(text.charAt(0))) text = "P" + text;
    return text.toUpperCase(Locale.ROOT);
  }

  /** Proposals this session may see: an agent sees its own, a person sees those whose point they can read. */
  List<Object> list(BaskStreamClientSession session, String status)
  {
    List<Proposal> snapshot;
    synchronized (this)
    {
      snapshot = new ArrayList<Proposal>(proposals.values());
    }
    List<Object> visible = new ArrayList<Object>();
    for (int i = snapshot.size() - 1; i >= 0; i--)
    {
      Proposal proposal = snapshot.get(i);
      Map<String, Object> wire = proposal.toWire();
      if (status != null && !status.equals(wire.get("status"))) continue;
      if (canSee(session, proposal)) visible.add(wire);
    }
    return visible;
  }

  boolean canSee(BaskStreamClientSession session, Proposal proposal)
  {
    if (isAgent(session)) return proposal.agentUser.equalsIgnoreCase(session.getUsername());
    try
    {
      runtime.getResolver().resolve(proposal.point, session.context);
      return true;
    }
    catch (BaskStreamProtocolException e)
    {
      return false;
    }
  }

  int pendingCount()
  {
    int count = 0;
    synchronized (this)
    {
      for (Proposal p : proposals.values())
        if ("pending".equals(p.status)) count++;
    }
    return count;
  }

  /** Expires old proposals and forgets long-decided ones. Runs from the runtime's sweep. */
  void sweep(long now)
  {
    List<Proposal> expired = new ArrayList<Proposal>();
    synchronized (this)
    {
      java.util.Iterator<Proposal> it = proposals.values().iterator();
      while (it.hasNext())
      {
        Proposal p = it.next();
        synchronized (p)
        {
          if ("pending".equals(p.status) && now >= p.expiresAt)
          {
            p.status = "expired";
            p.decidedAt = now;
            expired.add(p);
          }
          else if (!"pending".equals(p.status) && !"deciding".equals(p.status) && now - Math.max(p.decidedAt, p.createdAt) > KEEP_DECIDED_MILLIS)
          {
            it.remove();
          }
        }
      }
      while (proposals.size() > MAX_LISTED)
      {
        String oldest = proposals.keySet().iterator().next();
        if ("pending".equals(proposals.get(oldest).status)) break;
        proposals.remove(oldest);
      }
    }
    for (Proposal p : expired)
    {
      record(p.agentUser, p.point, String.valueOf(p.summary.get("action")), p.actor, p.agentUser, describeWrite(p.summary),
          p.reason, "expired " + p.id, null);
      proposalsChanged(p);
    }
  }

  private void proposalsChanged(Proposal proposal)
  {
    service.showPendingProposals(pendingSummary());
    runtime.forEachSession(session -> session.proposalChanged(proposal));
  }

  /** One line per pending proposal, for the service's read-only {@code pendingProposals} property. */
  String pendingSummary()
  {
    StringBuilder text = new StringBuilder();
    List<Proposal> snapshot;
    synchronized (this)
    {
      snapshot = new ArrayList<Proposal>(proposals.values());
    }
    for (Proposal p : snapshot)
    {
      if (!"pending".equals(p.status)) continue;
      if (text.length() > 0) text.append('\n');
      text.append(p.id).append(": ").append(describeWrite(p.summary)).append(" on ").append(p.point)
          .append(" (").append(actorText(p.actor, p.agentUser)).append(")");
      if (p.reason != null) text.append(" because \"").append(p.reason).append('"');
    }
    return text.length() == 0 ? "none" : text.toString();
  }

  static String describeWrite(Map<String, Object> summary)
  {
    Object description = summary.get("description");
    return description == null ? String.valueOf(summary.get("action")) : description.toString();
  }

  // ---- Audit records -----------------------------------------------------------------------------

  /** Records an action taken by this session's agent. */
  void record(BaskStreamClientSession session, String target, String what, String detail, String reason, String outcome, String code)
  {
    record(session.getUsername(), target, what, session.actor, session.getUsername(), detail, reason, outcome, code);
  }

  /**
   * Adds one "Agent" record to the station's audit history. It carries what Niagara's own record
   * of the change cannot: the actor, the reason and the outcome. It sits next to that record (same
   * user, target and time) instead of repeating it.
   */
  void record(String user, String target, String what, Actor actor, String agentUser, String detail, String reason, String outcome, String code)
  {
    StringBuilder value = new StringBuilder();
    append(value, "outcome", outcome);
    append(value, "code", code);
    append(value, "agentUser", agentUser);
    if (actor != null)
    {
      append(value, "agent", actor.name);
      append(value, "model", actor.model);
      append(value, "for", actor.onBehalfOf);
    }
    append(value, "change", detail);
    append(value, "reason", reason);
    service.auditAgent(target == null ? "station" : target, what, value.toString(), user);
  }

  private static void append(StringBuilder value, String key, String text)
  {
    if (text == null || text.length() == 0) return;
    if (value.length() > 0) value.append("; ");
    value.append(key).append('=').append(text.replace(';', ','));
  }

  /** Parses a record value written by {@link #record} back into fields. */
  static Map<String, Object> parseRecordValue(String value)
  {
    Map<String, Object> fields = new LinkedHashMap<String, Object>();
    if (value == null) return fields;
    for (String part : value.split("; "))
    {
      int eq = part.indexOf('=');
      if (eq > 0) fields.put(part.substring(0, eq), part.substring(eq + 1));
    }
    return fields;
  }

  static String actorText(Actor actor, String agentUser)
  {
    if (actor == null || actor.name == null) return agentUser;
    return actor.name + (actor.onBehalfOf == null ? "" : " for " + actor.onBehalfOf) + " as " + agentUser;
  }

  private static String userName(Context context)
  {
    return context == null || context.getUser() == null ? null : context.getUser().getUsername();
  }

  /** The best target to name in a record for a non-write change. */
  private static String opTarget(Map<String, Object> request)
  {
    for (String key : new String[] { "ord", "point", "planId", "source" })
    {
      Object value = request.get(key);
      if (value instanceof String && ((String)value).length() > 0) return (String)value;
    }
    return "station";
  }
}
