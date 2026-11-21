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

import javax.baja.sys.BComponent;
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
 *
 * Each kind of change has its own setting, and none of them overrides another. Commanding a point
 * follows {@code agentPointWrites}: refused, a proposal a person approves (the default), or written
 * directly. Every other kind is refused unless its {@code agentDirect} setting allows it: station
 * files under named paths, discovery, model plans, tags, schedules, alarms. Every changing
 * operation belongs to exactly one kind ({@link #DIRECT_SETTINGS}), so none is left without a
 * setting.
 */
final class BaskStreamAgents
{
  /** Operation name of the records added to the station's audit history. */
  static final String AUDIT_OPERATION = "Agent";
  static final int MAX_REASON_LENGTH = 300;
  static final int MAX_ACTOR_FIELD_LENGTH = 100;
  /** The agentBound1..4 slots older stations used; {@code agentBounds} holds the rules now. */
  static final int BOUND_RULES = 4;
  /** The tags of {@code BAgentMode}. */
  static final String REFUSE = "refuse";
  static final String ASK = "ask";
  static final String ALLOW = "allow";
  /** Pending proposals one agent user may hold at a time. */
  static final int MAX_PENDING_PER_USER = 20;
  /** How long decided, applied and expired changes stay listed, and can be put back. */
  private static final long KEEP_DECIDED_MILLIS = 7L * 24L * 60L * 60L * 1000L;
  /** The longest a change may wait for a person: a week. */
  static final int MAX_PROPOSAL_MINUTES = 7 * 24 * 60;
  /** How long after a point command the station looks at the point again, unless the request says. */
  private static final long DEFAULT_CHECK_MILLIS = 60000L;
  /** The kinds of change {@code agentAskKinds} may name. Point commands have agentPointWrites instead. */
  static final List<String> ASK_KINDS = java.util.Arrays.asList("files", "discovery", "modelEdits", "tags", "schedules", "alarms");

  /**
   * The setting that lets an agent make each kind of change. Every operation that changes the
   * station is here, except {@code write} ({@code agentPointWrites} instead) and deciding
   * proposals (never an agent's). tests/protocol_contract.py checks that.
   */
  static final Map<String, String> DIRECT_SETTINGS = new LinkedHashMap<String, String>();
  static
  {
    DIRECT_SETTINGS.put("write_file", "agentDirectFiles");
    DIRECT_SETTINGS.put("delete_file", "agentDirectFiles");
    // Dispatched as write_file once its pieces are joined; listed so that it is never without a setting.
    DIRECT_SETTINGS.put("commit_upload", "agentDirectFiles");
    DIRECT_SETTINGS.put("write_px", "agentDirectFiles");
    // A Px view is a slot on the component, so attaching one is a model edit.
    DIRECT_SETTINGS.put("attach_px_view", "agentDirectModelEdits");
    DIRECT_SETTINGS.put("discover", "agentDirectDiscovery");
    DIRECT_SETTINGS.put("cancel_job", "agentDirectDiscovery");
    DIRECT_SETTINGS.put("apply_model_changes", "agentDirectModelEdits");
    DIRECT_SETTINGS.put("write_tags", "agentDirectTags");
    DIRECT_SETTINGS.put("write_relations", "agentDirectTags");
    DIRECT_SETTINGS.put("write_schedule", "agentDirectSchedules");
    DIRECT_SETTINGS.put("ack_alarm", "agentDirectAlarms");
    DIRECT_SETTINGS.put("ack_alarms", "agentDirectAlarms");
    DIRECT_SETTINGS.put("clear_alarm", "agentDirectAlarms");
    DIRECT_SETTINGS.put("clear_alarms", "agentDirectAlarms");
  }

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

    /**
     * The first bound rule whose pattern matches the point, or null. Pass every spelling of the
     * point (the ORD as sent and the resolved component's slot path), so a rule cannot be missed
     * by writing to the same point through a property ORD such as {@code .../ZoneSP/out}.
     */
    Bound boundFor(String... pointOrds)
    {
      for (Bound bound : bounds)
        for (String ord : pointOrds)
          if (ord != null && bound.pattern.matcher(ord).matches()) return bound;
      return null;
    }
  }

  /** One value limit rule: an ORD pattern and the values agents may write there. */
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

  /**
   * One change an agent asked for or made. It waits for a person ("pending"), was made by a person's
   * approval ("approved"), was made by the agent directly ("applied"), or ended some other way
   * ("rejected", "expired", "failed", "reverted"). A point command keeps its write object in
   * {@code spec}; any other kind keeps the request it would run in {@code request}.
   */
  static final class Proposal
  {
    final String id;
    final long createdAt;
    final long expiresAt;
    final String agentUser;
    final String sessionId;
    final Actor actor;
    /** "points", "files", "discovery", "modelEdits", "tags", "schedules" or "alarms". */
    final String kind;
    /** The operation: "write" for a point command. */
    final String op;
    /** What it is aimed at: a point, a component, a file path, a plan. */
    final String point;
    final Map<String, Object> spec;
    final Map<String, Object> summary;
    final String reason;
    /** The agent's narrower reach when it asked; the change is held to it when it runs. */
    final String scope;
    /** True for a change the agent made directly, with nobody asked. */
    final boolean direct;
    String status = "pending";
    String decidedBy;
    long decidedAt;
    String note;
    Map<String, Object> result;
    /** How to put the change back: {op, request, wrote?, notReverted?}, or {op: null, why}. */
    Map<String, Object> undo;
    String revertedBy;
    long revertedAt;
    /** What to look at afterwards and what was found: {point, min?, max?, dueAt, state, found?}. */
    Map<String, Object> check;
    /** Who made the change, for the check afterwards. Not kept over a restart. */
    Context madeBy;

    Proposal(String id, long createdAt, long expiresAt, String agentUser, String sessionId, Actor actor, String kind, String op,
        String point, Map<String, Object> spec, Map<String, Object> summary, String reason, String scope, boolean direct)
    {
      this.id = id;
      this.createdAt = createdAt;
      this.expiresAt = expiresAt;
      this.agentUser = agentUser;
      this.sessionId = sessionId;
      this.actor = actor;
      this.kind = kind;
      this.op = op;
      this.point = point;
      this.spec = spec;
      this.summary = summary;
      this.reason = reason;
      this.scope = scope;
      this.direct = direct;
    }

    boolean made()
    {
      return "approved".equals(status) || "applied".equals(status);
    }

    synchronized Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("id", id);
      wire.put("status", status);
      wire.put("kind", kind);
      wire.put("operation", op);
      wire.put("direct", Boolean.valueOf(direct));
      wire.put("point", point);
      wire.put("display", summary.get("display"));
      wire.put("action", summary.get("action"));
      wire.put("value", summary.get("value"));
      wire.put("description", summary.get("description"));
      if (summary.get("changes") != null) wire.put("changes", summary.get("changes"));
      wire.put("reason", reason);
      wire.put("agentUser", agentUser);
      wire.put("actor", actor == null ? null : actor.toWire());
      wire.put("createdAt", Long.valueOf(createdAt));
      wire.put("expiresAt", Long.valueOf(expiresAt));
      wire.put("decidedBy", decidedBy);
      wire.put("decidedAt", decidedAt == 0L ? null : Long.valueOf(decidedAt));
      wire.put("note", note);
      wire.put("result", result);
      boolean canRevert = made() && undo != null && undo.get("op") != null;
      wire.put("canRevert", Boolean.valueOf(canRevert));
      if (undo != null && undo.get("why") != null) wire.put("notRevertible", undo.get("why"));
      if (undo != null && undo.get("notReverted") != null) wire.put("notReverted", undo.get("notReverted"));
      if (summary.get("irreversible") != null) wire.put("irreversible", summary.get("irreversible"));
      wire.put("revertedBy", revertedBy);
      wire.put("revertedAt", revertedAt == 0L ? null : Long.valueOf(revertedAt));
      if (check != null) wire.put("check", new LinkedHashMap<String, Object>(check));
      return wire;
    }
  }

  private final BaskStreamWebSocketRuntime runtime;
  private final BBaskStreamService service;
  private final Map<String, Proposal> proposals = new LinkedHashMap<String, Proposal>();
  private final AtomicLong nextProposal = new AtomicLong();
  private final Map<String, ArrayDeque<Long>> recentChanges = new HashMap<String, ArrayDeque<Long>>();

  private final BaskStreamChanges changes;
  /** What to remember about a direct change between the check before it and the record after it. */
  private final ThreadLocal<Map<String, Object>> undoDraft = new ThreadLocal<Map<String, Object>>();

  BaskStreamAgents(BaskStreamWebSocketRuntime runtime)
  {
    this.runtime = runtime;
    this.service = runtime.getService();
    this.changes = new BaskStreamChanges(runtime);
  }

  BaskStreamChanges changes()
  {
    return changes;
  }

  // ---- Rules: the service's own agent settings, or an agent profile's ---------------------------

  /**
   * The rules one agent follows, read from the service or from the {@link BAgentProfile} that lists
   * its Niagara user. Both name the settings alike. Settings are read by name when they are needed,
   * so a change on the station applies to the next request.
   */
  final class Rules
  {
    /** The service, or the profile. */
    final BComponent source;
    /** The profile's name, or null for the service's own settings. */
    final String profile;
    /** Why this agent may change nothing ("is turned off", "ended on ..."), or null. */
    final String off;

    Rules(BComponent source, String profile, String off)
    {
      this.source = source;
      this.profile = profile;
      this.off = off;
    }

    private String string(String name, String fallback)
    {
      Property p = source.getProperty(name);
      return p == null ? fallback : source.getString(p);
    }

    private boolean bool(String name, boolean fallback)
    {
      Property p = source.getProperty(name);
      return p == null ? fallback : source.getBoolean(p);
    }

    private int integer(String name, int fallback)
    {
      Property p = source.getProperty(name);
      return p == null ? fallback : source.getInt(p);
    }

    /** A {@code BAgentMode} setting as its tag: "refuse", "ask" or "allow". */
    private String mode(String name, String fallback)
    {
      Property p = source.getProperty(name);
      if (p == null) return fallback;
      Object value = source.get(p);
      return value instanceof javax.baja.sys.BEnum ? ((javax.baja.sys.BEnum)value).getTag() : fallback;
    }

    /** Where a person changes these rules, for messages. */
    String where()
    {
      return profile == null ? "BASkStreamService" : "the agent profile " + profile + " on BASkStreamService";
    }

    /** "The agent profile graphics is turned off, so its users can change nothing." */
    String offMessage()
    {
      return "The agent profile " + profile + " " + off + ", so its users can change nothing. A person can change that on BASkStreamService.";
    }

    /** What a point command does: "refuse", "ask" (a proposal) or "allow". */
    String pointWrites()
    {
      return off != null ? REFUSE : mode("agentPointWrites", ASK);
    }

    /** The same, for a point that no value limit rule names. Only ever makes a write stricter. */
    String unlistedPoints()
    {
      return mode("agentUnlistedPoints", ALLOW);
    }

    boolean reasonRequired()
    {
      return bool("agentRequireReason", true);
    }

    int maxChangesPerMinute()
    {
      return Math.max(0, integer("agentMaxChangesPerMinute", 10));
    }

    /** The kinds of change that wait for a person instead of being refused: {@code agentAskKinds}. */
    Set<String> askKinds()
    {
      Set<String> kinds = new LinkedHashSet<String>();
      if (off != null) return kinds;
      for (String piece : string("agentAskKinds", "").split("[\\s,;]+"))
        for (String known : ASK_KINDS)
          if (known.equalsIgnoreCase(piece.trim())) kinds.add(known);
      return kinds;
    }

    /** True when a change of this operation's kind, refused as a direct change, waits for a person. */
    boolean asks(String op)
    {
      String kind = BaskStreamChanges.kindOf(op);
      return kind != null && askKinds().contains(kind);
    }

    /** "refuse", "ask" or "allow" for each kind of work, as the view's grid shows it. */
    Map<String, Object> kindsWire()
    {
      Set<String> ask = askKinds();
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("points", pointWrites());
      // Files: allow means under the paths in direct.files; filesElsewhere says what happens to any other path.
      wire.put("files", !directFilePatterns().isEmpty() ? ALLOW : ask.contains("files") ? ASK : REFUSE);
      wire.put("discovery", direct("agentDirectDiscovery") ? ALLOW : ask.contains("discovery") ? ASK : REFUSE);
      wire.put("modelEdits", direct("agentDirectModelEdits") ? ALLOW : ask.contains("modelEdits") ? ASK : REFUSE);
      wire.put("tags", direct("agentDirectTags") ? ALLOW : ask.contains("tags") ? ASK : REFUSE);
      wire.put("schedules", direct("agentDirectSchedules") ? ALLOW : ask.contains("schedules") ? ASK : REFUSE);
      wire.put("alarms", direct("agentDirectAlarms") ? ALLOW : ask.contains("alarms") ? ASK : REFUSE);
      return wire;
    }

    /** Whether the {@code agentDirect} switch for a kind of change is on. */
    boolean direct(String setting)
    {
      return off == null && bool(setting, false);
    }

    /**
     * The station file paths in {@code agentDirectFiles}, e.g. {@code ^bask/*}. A piece that does
     * not start with {@code ^} is ignored, so a typo turns a path off rather than opening more.
     */
    List<String> directFilePatterns()
    {
      List<String> patterns = new ArrayList<String>();
      if (off != null) return patterns;
      for (String piece : string("agentDirectFiles", "").split("[\\s,;]+"))
      {
        String text = piece.trim();
        if (text.startsWith("file:")) text = text.substring(5);
        if (text.startsWith("^") && !text.startsWith("^^")) patterns.add(text);
      }
      return patterns;
    }

    boolean directFile(String path)
    {
      for (String pattern : directFilePatterns())
        if (Pattern.compile(BaskStreamAccessPolicy.toRegex(pattern)).matcher(path).matches()) return true;
      return false;
    }

    /**
     * The value limit rules: one per line of {@code agentBounds}, then any left in the service's
     * older agentBound1..4 slots (the service moves those into {@code agentBounds} when it starts).
     */
    Limits limits()
    {
      List<Bound> bounds = new ArrayList<Bound>();
      for (String line : boundLines(string("agentBounds", "")))
      {
        Bound bound = parseBound(line);
        if (bound != null) bounds.add(bound);
      }
      for (int i = 1; i <= BOUND_RULES; i++)
      {
        Bound bound = parseBound(string("agentBound" + i, ""));
        if (bound != null) bounds.add(bound);
      }
      return new Limits(bool("agentAllowEmergency", false), bounds);
    }

    /** The profile's narrower reach, or null for whatever the service allows. */
    String pathPatterns()
    {
      String text = profile == null ? "" : string("pathPatterns", "").trim();
      return text.length() == 0 ? null : text;
    }

    /**
     * Why an agent may not make this change, or null when the setting for its kind allows it. A plan
     * that add_discovered built counts as discovery; any other plan needs model edits, which also
     * cover discovery's plans.
     */
    String directRefusal(String op, Map<String, Object> request) throws BaskStreamProtocolException
    {
      if (off != null) return offMessage();
      String setting = DIRECT_SETTINGS.get(op);
      String ask = " A person can change that on " + where() + ", or make this change themselves.";
      if (setting == null) return "Agents cannot " + op + "." + ask;
      if ("agentDirectFiles".equals(setting))
      {
        String path = BaskStreamFileResolver.canonical(request.get("path"));
        if (directFile(path)) return null;
        List<String> patterns = directFilePatterns();
        return "Agents write and delete station files only under the paths in agentDirectFiles ("
            + (patterns.isEmpty() ? "blank now" : "now " + patterns) + "), and " + path + " is not under one." + ask;
      }
      if (direct(setting)) return null;
      if ("apply_model_changes".equals(op) && "discovery".equals(runtime.getModelResolver().planKind(request.get("planId"))))
      {
        if (direct("agentDirectDiscovery")) return null;
        return "Agents add what discovery found only when agentDirectDiscovery (or agentDirectModelEdits) is on; both are off." + ask;
      }
      return "Agents cannot " + op + " unless " + setting + " is on; it is off." + ask;
    }

    /** What the agent may change without a person, as clients see it. */
    Map<String, Object> directWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("pointWrites", Boolean.valueOf(ALLOW.equals(pointWrites())));
      wire.put("files", new ArrayList<String>(directFilePatterns()));
      wire.put("discovery", Boolean.valueOf(direct("agentDirectDiscovery")));
      wire.put("modelEdits", Boolean.valueOf(direct("agentDirectModelEdits")));
      wire.put("tags", Boolean.valueOf(direct("agentDirectTags")));
      wire.put("schedules", Boolean.valueOf(direct("agentDirectSchedules")));
      wire.put("alarms", Boolean.valueOf(direct("agentDirectAlarms")));
      return wire;
    }
  }

  /** The profile that lists this Niagara user: the first one, in the order they sit under the service. */
  BAgentProfile profileFor(String username)
  {
    if (username == null) return null;
    for (BAgentProfile profile : service.getChildren(BAgentProfile.class))
      if (profile.lists(username)) return profile;
    return null;
  }

  /** The rules for a Niagara user: its profile's, or the service's own when no profile lists it. */
  Rules rulesFor(String username)
  {
    BAgentProfile profile = profileFor(username);
    if (profile == null) return new Rules(service, null, null);
    String name = profile.getName();
    if (!profile.isOn()) return new Rules(profile, name, "is turned off");
    long ends = profile.endsAt();
    if (ends != 0L && Clock.millis() >= ends)
      return new Rules(profile, name, "ended on " + javax.baja.sys.BAbsTime.make(ends).toString(null));
    return new Rules(profile, name, null);
  }

  Rules rulesFor(BaskStreamClientSession session)
  {
    return rulesFor(session.getUsername());
  }

  /** The narrower reach of an agent session's profile, or null. Never applies to a person. */
  String pathScope(BaskStreamClientSession session)
  {
    return isAgent(session) ? rulesFor(session).pathPatterns() : null;
  }

  Set<String> agentUsers()
  {
    Set<String> users = new LinkedHashSet<String>();
    Property p = service.getProperty("agentUsers");
    for (String piece : (p == null ? "" : service.getString(p)).split("[\\s,;]+"))
      if (piece.trim().length() > 0) users.add(piece.trim().toLowerCase(Locale.ROOT));
    return users;
  }

  long proposalMillis()
  {
    Property p = service.getProperty("agentProposalMinutes");
    return Math.max(1, Math.min(MAX_PROPOSAL_MINUTES, p == null ? 15 : service.getInt(p))) * 60000L;
  }

  /** The rules in {@code agentBounds}: one per line, or separated by semicolons. */
  static List<String> boundLines(String text)
  {
    List<String> lines = new ArrayList<String>();
    if (text == null) return lines;
    for (String piece : text.split("[\\r\\n;]+"))
      if (piece.trim().length() > 0) lines.add(piece.trim());
    return lines;
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
    wire.put("agentUsersConfigured", Boolean.valueOf(!agentUsers().isEmpty() || service.getChildren(BAgentProfile.class).length > 0));
    Rules rules = rulesFor(session);
    // The profile whose rules these are, or null for the service's own agent settings.
    wire.put("profile", rules.profile);
    if (rules.off != null) wire.put("profileOff", rules.off);
    wire.put("pathPatterns", rules.pathPatterns());
    // True exactly when a point command becomes a proposal; pointWrites says which of the three.
    wire.put("approvalRequired", Boolean.valueOf(ASK.equals(rules.pointWrites())));
    wire.put("pointWrites", rules.pointWrites());
    wire.put("unlistedPoints", rules.unlistedPoints());
    wire.put("direct", rules.directWire());
    // Each kind of work as refuse, ask or allow. "ask" means the change waits for a person.
    wire.put("kinds", rules.kindsWire());
    wire.put("filesElsewhere", rules.askKinds().contains("files") ? ASK : REFUSE);
    wire.put("reasonRequired", Boolean.valueOf(rules.reasonRequired()));
    wire.put("maxChangesPerMinute", Long.valueOf(rules.maxChangesPerMinute()));
    Limits limits = rules.limits();
    wire.put("allowEmergency", Boolean.valueOf(limits.allowEmergency));
    List<String> bounds = new ArrayList<String>();
    for (Bound bound : limits.bounds) bounds.add(bound.text);
    wire.put("bounds", bounds);
    wire.put("pointLimitsFromFacets", Boolean.TRUE);
    wire.put("proposalMinutes", Long.valueOf(proposalMillis() / 60000L));
    wire.put("pendingProposals", Long.valueOf(pendingCount()));
    return wire;
  }

  // ---- What would happen to a change -----------------------------------------------------------

  /**
   * Says what the station would do with a change, and which setting decides, without making it,
   * recording it or counting it against the rate limit. It reads the same rules the real check
   * does. Niagara roles are not judged here: they are checked when the change is made.
   *
   * A person may ask about any user; an agent only about itself.
   */
  Map<String, Object> explain(BaskStreamClientSession session, Map<String, Object> request) throws BaskStreamProtocolException
  {
    return explain(session.getUsername(), isAgent(session), request);
  }

  /** The same, for whoever asks: {@code asker} is their Niagara user, {@code askerIsAgent} whether they are held to the agent rules. */
  Map<String, Object> explain(String asker, boolean askerIsAgent, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String op = runtime.getCodec().requireString(request, "change");
    BaskStreamOperations.Operation operation = BaskStreamOperations.get(op);
    if (operation == null)
      throw new BaskStreamProtocolException("bad_request", "Field 'change' must name an operation, such as write or write_file; '" + op + "' is not one.");
    String asked = runtime.getCodec().optionalString(request, "user");
    boolean self = asked == null || asked.trim().length() == 0 || asked.trim().equalsIgnoreCase(asker);
    if (!self && askerIsAgent)
      throw new BaskStreamProtocolException("bad_request", "An agent can ask only about its own rules; leave out 'user'.");
    String who = self ? asker : asked.trim();
    boolean agent = self ? askerIsAgent : isAgentUser(who);
    Rules rules = rulesFor(who);

    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("change", op);
    wire.put("user", who);
    wire.put("isAgent", Boolean.valueOf(agent));
    wire.put("profile", agent ? rules.profile : null);
    boolean changing = operation.gate == BaskStreamOperations.Gate.WRITES || "apply_model_changes".equals(op);
    boolean modelWork = operation.gate == BaskStreamOperations.Gate.MODEL_EDITS;

    if ((changing || modelWork) && (!service.getEnabled() || !service.writesAllowed()))
      return outcome(wire, REFUSE, "writesEnabled", "Changes are off for everyone: writesEnabled is off on BASkStreamService.");
    if (modelWork && !service.modelEditsAllowed())
      return outcome(wire, REFUSE, "modelEditsEnabled", "Building and changing the station is off for everyone: modelEditsEnabled is off on BASkStreamService.");
    if (!changing)
      return outcome(wire, ALLOW, null, op + " does not change the station, so the agent rules do not limit it.");
    if (!agent)
      return outcome(wire, ALLOW, null, who + " is not an agent, so the agent rules do not apply. Niagara roles decide.");
    if ("approve_proposal".equals(op) || "reject_proposal".equals(op) || "revert_change".equals(op))
      return outcome(wire, REFUSE, null, "Agents cannot approve or reject proposals, or put changes back; a person decides.");

    if ("write".equals(op))
    {
      if (rules.off != null) return outcome(wire, REFUSE, "enabled", rules.offMessage());
      String mode = rules.pointWrites();
      if (REFUSE.equals(mode))
        return outcome(wire, REFUSE, "agentPointWrites", "Point commands are refused: agentPointWrites is refuse on " + rules.where() + ".");
      String point = runtime.getCodec().optionalString(request, "point");
      if (point != null && point.trim().length() > 0)
      {
        Bound bound = rules.limits().boundFor(point.trim());
        wire.put("limit", bound == null ? null : bound.text);
        String unlisted = rules.unlistedPoints();
        if (bound == null && REFUSE.equals(unlisted))
          return outcome(wire, REFUSE, "agentUnlistedPoints", "No value limit names this point, and agentUnlistedPoints is refuse on " + rules.where() + ".");
        if (bound == null && ASK.equals(unlisted) && !ASK.equals(mode))
          return outcome(wire, ASK, "agentUnlistedPoints", "No value limit names this point, so the command becomes a proposal: agentUnlistedPoints is ask on " + rules.where() + ".");
      }
      return outcome(wire, mode, "agentPointWrites", ASK.equals(mode)
          ? "The command becomes a proposal a person approves: agentPointWrites is ask on " + rules.where() + "."
          : "The command is written, within the value limits and the point's own range: agentPointWrites is allow on " + rules.where() + ".");
    }

    String setting = DIRECT_SETTINGS.get(op);
    if ("agentDirectFiles".equals(setting) && request.get("path") == null)
    {
      List<String> patterns = rules.directFilePatterns();
      if (patterns.isEmpty() && rules.asks(op))
        return outcome(wire, ASK, "agentAskKinds", "Every file change waits for a person: agentDirectFiles is blank and agentAskKinds names files on " + rules.where() + ".");
      return outcome(wire, patterns.isEmpty() ? REFUSE : ALLOW, rules.off != null ? "enabled" : setting, rules.off != null ? rules.offMessage()
          : patterns.isEmpty() ? "No station file path is allowed: agentDirectFiles is blank on " + rules.where() + "."
          : "Allowed under " + patterns + " (agentDirectFiles on " + rules.where() + "). Give a 'path' to check one file.");
    }
    String refusal = rules.directRefusal(op, request);
    if (refusal != null && rules.asks(op))
      return outcome(wire, ASK, "agentAskKinds", "The change waits for a person to approve it: agentAskKinds names "
          + BaskStreamChanges.kindOf(op) + " on " + rules.where() + ".");
    if (refusal != null) return outcome(wire, REFUSE, rules.off != null ? "enabled" : setting, refusal);
    return outcome(wire, ALLOW, setting, setting + " allows it on " + rules.where() + ".");
  }

  private static Map<String, Object> outcome(Map<String, Object> wire, String outcome, String rule, String message)
  {
    wire.put("outcome", outcome);
    wire.put("rule", rule);
    wire.put("message", message);
    return wire;
  }

  // ---- Who is an agent --------------------------------------------------------------------------

  boolean isAgent(BaskStreamClientSession session)
  {
    Actor actor = session.actor;
    return (actor != null && actor.agent) || isAgentUser(session.getUsername());
  }

  /** A user listed in {@code agentUsers} or in any agent profile, whether or not that profile is on. */
  boolean isAgentUser(String username)
  {
    return username != null && (agentUsers().contains(username.toLowerCase(Locale.ROOT)) || profileFor(username) != null);
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

  /** The changing operations whose handlers honour {@code dryRun} and change nothing with it. */
  static final Set<String> DRY_RUN_OPS = new LinkedHashSet<String>(java.util.Arrays.asList(
      "ack_alarm", "ack_alarms", "clear_alarm", "clear_alarms", "write_schedule", "write_file", "commit_upload", "delete_file",
      "write_px", "attach_px_view"));

  /** True for requests that change the station (not previews, reads or dry runs). */
  static boolean changesStation(String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
  {
    boolean changing = gate == BaskStreamOperations.Gate.WRITES || "apply_model_changes".equals(op);
    if (changing && DRY_RUN_OPS.contains(op) && Boolean.TRUE.equals(request.get("dryRun"))) return false;
    return changing;
  }

  /**
   * Refuses {@code dryRun} on a changing operation that does not honour it, for everyone: its
   * handler would make the real change, and for an agent the change would skip these checks.
   */
  static void checkDryRun(String op, BaskStreamOperations.Gate gate, Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object dryRun = request.get("dryRun");
    if (dryRun == null || Boolean.FALSE.equals(dryRun)) return;
    boolean changing = gate == BaskStreamOperations.Gate.WRITES || "apply_model_changes".equals(op);
    if (changing && !DRY_RUN_OPS.contains(op))
      throw new BaskStreamProtocolException("bad_request", "Operation '" + op + "' has no dry run; leave out 'dryRun'"
          + ("apply_model_changes".equals(op) ? " and use preview_model_changes." : "."));
  }

  /**
   * Runs before an agent's change. Point writes are refused here when {@code agentPointWrites} is
   * "refuse"; otherwise they go on to {@link BaskStreamRequests#handleWrite}, which checks each
   * point and proposes or writes it. Any other change is made when the setting for its kind
   * allows it, and is refused otherwise.
   */
  void beforeChange(BaskStreamClientSession session, String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
      throws BaskStreamProtocolException
  {
    checkDryRun(op, gate, request);
    if (!isAgent(session) || !changesStation(op, gate, request)) return;
    if ("approve_proposal".equals(op) || "reject_proposal".equals(op))
      throw new BaskStreamProtocolException("agent_cannot_approve", "Agents cannot approve or reject proposals; a person decides.");
    if ("revert_change".equals(op))
      throw new BaskStreamProtocolException("agent_cannot_approve", "Agents cannot put changes back; a person decides.");
    Rules rules = rulesFor(session);
    String reason = reason(rules, request);
    if ("write".equals(op))
    {
      if (REFUSE.equals(rules.pointWrites()))
      {
        record(session, opTarget(request), op, null, reason, "refused", "agent_writes_refused");
        throw new BaskStreamProtocolException("agent_writes_refused", rules.off != null ? rules.offMessage()
            : "Agents may not command points here: agentPointWrites is refuse. A person can change that on " + rules.where() + ", or make this change themselves.");
      }
      return;
    }
    String refusal = rules.directRefusal(op, request);
    if (refusal != null && rules.asks(op))
    {
      Proposal proposal = proposeChange(session, rules, op, request, reason);
      Map<String, Object> details = new LinkedHashMap<String, Object>();
      details.put("outcome", "proposed");
      details.put("proposal", proposal.toWire());
      throw new BaskStreamProtocolException("change_proposed", "This change was not made. It is waiting for a person to approve it as "
          + proposal.id + ". Do not send it again.", details);
    }
    if (refusal != null)
    {
      record(session, opTarget(request), op, null, reason, "refused", "approval_required");
      throw new BaskStreamProtocolException("approval_required", refusal);
    }
    takeChangeSlot(session, op, opTarget(request), reason);
    // An agent's own file writes keep the old content, so that they can be put back.
    if (("write_file".equals(op) || "write_px".equals(op)) && !request.containsKey("backup")) request.put("backup", Boolean.TRUE);
    // Worked out now, while a plan is still a preview: what the change is, and how to put it back.
    Map<String, Object> kept = keptRequest(session, op, request);
    Map<String, Object> remembered = new LinkedHashMap<String, Object>();
    remembered.put("undo", changes.undoBefore(op, kept, session.context));
    remembered.put("summary", describeChange(op, request, kept));
    undoDraft.set(remembered);
  }

  /** Records a completed direct change by an agent (point writes record each point themselves). */
  void afterChange(BaskStreamClientSession session, String op, BaskStreamOperations.Gate gate, Map<String, Object> request)
  {
    Map<String, Object> remembered = undoDraft.get();
    undoDraft.remove();
    if ("write".equals(op) || !isAgent(session) || !changesStation(op, gate, request)) return;
    String reason = optionalReason(request);
    Map<String, Object> draft = remembered == null ? null : castMap(remembered.get("undo"));
    Map<String, Object> summary = remembered == null ? describeChange(op, request, null) : castMap(remembered.get("summary"));
    Proposal made = made(session, op, String.valueOf(summary.get("display")), request, summary, reason, draft, session.lastReply(), session.context);
    record(session, opTarget(request), op, String.valueOf(made.summary.get("description")), reason, "completed", null);
  }

  /** Forgets what was remembered for a direct change that did not complete. */
  void changeFailed()
  {
    undoDraft.remove();
  }

  /**
   * The request as a change keeps it. A plan is kept as the change specs it was previewed from and
   * the differences that preview showed, because the plan itself belongs to the agent and expires.
   */
  private Map<String, Object> keptRequest(BaskStreamClientSession session, String op, Map<String, Object> request)
  {
    if (!"apply_model_changes".equals(op)) return request;
    Map<String, Object> plan = runtime.getModelResolver().waitingPlan(request.get("planId"), session.context);
    Map<String, Object> kept = new LinkedHashMap<String, Object>();
    kept.put("planId", request.get("planId"));
    kept.put("changes", plan == null ? null : plan.get("changes"));
    kept.put("diffs", plan == null ? null : plan.get("diffs"));
    return kept;
  }

  /** The reason on a request, required for agents when {@code agentRequireReason} is on. */
  String reason(Rules rules, Map<String, Object> request) throws BaskStreamProtocolException
  {
    String reason = optionalReason(request);
    if (reason == null && rules.reasonRequired())
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
    int max = rulesFor(session).maxChangesPerMinute();
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
    return keep(session, "points", "write", point, new LinkedHashMap<String, Object>(spec), summary, reason);
  }

  /**
   * Keeps a change that is not a point command for a person to decide. It is tried first without
   * being made, as the agent, so that nobody is asked about a change that could never run.
   */
  private Proposal proposeChange(BaskStreamClientSession session, Rules rules, String op, Map<String, Object> request, String reason)
      throws BaskStreamProtocolException
  {
    Map<String, Object> kept = new LinkedHashMap<String, Object>(keptRequest(session, op, request));
    kept.remove("id"); kept.remove("op"); kept.remove("dryRun");
    if ("apply_model_changes".equals(op) && kept.get("changes") == null)
      throw new BaskStreamProtocolException("plan_not_found", "Plan is unknown, expired, already applied, or belongs to another user. Preview it again.");
    if (changes.encodedSize(kept) > BaskStreamChanges.MAX_KEPT_REQUEST_BYTES)
      throw new BaskStreamProtocolException("approval_required", "This change is too large to wait for a person (over "
          + (BaskStreamChanges.MAX_KEPT_REQUEST_BYTES / 1024) + " KB). A person can make it themselves, or allow it on " + rules.where() + ".");
    try
    {
      changes.rehearse(op, kept, session.context);
    }
    catch (BaskStreamProtocolException e)
    {
      throw e;
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("bad_request", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    Map<String, Object> summary = describeChange(op, request, kept);
    return keep(session, BaskStreamChanges.kindOf(op), op, String.valueOf(summary.get("display")), kept, summary, reason);
  }

  private Proposal keep(BaskStreamClientSession session, String kind, String op, String target, Map<String, Object> spec,
      Map<String, Object> summary, String reason) throws BaskStreamProtocolException
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
    takeChangeSlot(session, String.valueOf(summary.get("action")), target, reason);
    long now = Clock.millis();
    Proposal proposal = new Proposal("P" + nextProposal.incrementAndGet(), now, now + proposalMillis(), user,
        session.getSessionId(), session.actor, kind, op, target, spec, summary, reason, pathScope(session), false);
    synchronized (this)
    {
      proposals.put(proposal.id, proposal);
    }
    record(session, target, String.valueOf(summary.get("action")), describeWrite(summary), reason, "proposed " + proposal.id, null);
    proposalsChanged(proposal);
    return proposal;
  }

  /**
   * Adds a change an agent made directly to the list, so that it shows beside the approved ones and
   * can be put back the same way.
   */
  Proposal made(BaskStreamClientSession session, String op, String target, Map<String, Object> request, Map<String, Object> summary,
      String reason, Map<String, Object> draft, Map<String, Object> result, Context context)
  {
    long now = Clock.millis();
    Proposal entry = new Proposal("P" + nextProposal.incrementAndGet(), now, now, session.getUsername(), session.getSessionId(),
        session.actor, BaskStreamChanges.kindOf(op), op, target, null, summary, reason, pathScope(session), true);
    entry.status = "applied";
    entry.decidedAt = now;
    entry.undo = trimUndo(changes.undoAfter(op, request, draft, result, context));
    if ("write".equals(op)) entry.check = checkFor(request, target, now);
    entry.madeBy = context;
    synchronized (this)
    {
      proposals.put(entry.id, entry);
    }
    proposalsChanged(entry);
    return entry;
  }

  private Map<String, Object> trimUndo(Map<String, Object> undo)
  {
    if (undo == null || changes.encodedSize(undo) <= BaskStreamChanges.MAX_KEPT_UNDO_BYTES) return undo;
    Map<String, Object> none = new LinkedHashMap<String, Object>();
    none.put("op", null);
    none.put("why", "What it replaced is too large to keep (over " + (BaskStreamChanges.MAX_KEPT_UNDO_BYTES / 1024) + " KB).");
    return none;
  }

  /**
   * What the station looks at after a point command: the point named in the request's
   * {@code expect} (or the commanded point), within its {@code min} and {@code max}, after
   * {@code withinMinutes} (a minute when not given). With no {@code expect}, the commanded point
   * has to be readable and not in fault.
   */
  private static Map<String, Object> checkFor(Map<String, Object> spec, String point, long now)
  {
    Map<String, Object> check = new LinkedHashMap<String, Object>();
    Object expect = spec == null ? null : spec.get("expect");
    long wait = DEFAULT_CHECK_MILLIS;
    check.put("point", point);
    if (expect instanceof Map)
    {
      Map<?, ?> wanted = (Map<?, ?>)expect;
      if (wanted.get("point") instanceof String) check.put("point", wanted.get("point"));
      if (wanted.get("min") instanceof Number) check.put("min", Double.valueOf(((Number)wanted.get("min")).doubleValue()));
      if (wanted.get("max") instanceof Number) check.put("max", Double.valueOf(((Number)wanted.get("max")).doubleValue()));
      if (wanted.get("withinMinutes") instanceof Number)
        wait = Math.max(1L, Math.min(24L * 60L, ((Number)wanted.get("withinMinutes")).longValue())) * 60000L;
    }
    check.put("dueAt", Long.valueOf(now + wait));
    check.put("state", "waiting");
    return check;
  }

  /**
   * Approves a proposal: the change is made now with the approver's Niagara permissions, so
   * Niagara's audit history shows the approver making it. It is still held to the agent's narrower
   * reach, if its profile has one. {@code session} is null when approved from Workbench.
   */
  Map<String, Object> approve(String id, Context approver, BaskStreamClientSession session) throws BaskStreamProtocolException
  {
    Proposal proposal = decidable(id, approver, session);
    Map<String, Object> result = null;
    Map<String, Object> undo = null;
    String failure = null;
    try
    {
      BaskStreamAccessPolicy.enterScope(proposal.scope);
      Map<String, Object> draft = changes.undoBefore(proposal.op, proposal.spec, approver);
      result = changes.run(proposal.op, proposal.spec, approver);
      undo = trimUndo(changes.undoAfter(proposal.op, proposal.spec, draft, result, approver));
    }
    catch (BaskStreamProtocolException e)
    {
      failure = e.getCode() + ": " + e.getMessage();
      if (e.getDetails() != null && e.getDetails().get("result") instanceof Map) result = castMap(e.getDetails().get("result"));
    }
    catch (Exception e)
    {
      failure = "change_failed: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    finally
    {
      BaskStreamAccessPolicy.exitScope();
    }
    String approverName = userName(approver);
    long now = Clock.millis();
    synchronized (proposal)
    {
      proposal.status = failure == null ? "approved" : "failed";
      proposal.decidedBy = approverName;
      proposal.decidedAt = now;
      proposal.result = "points".equals(proposal.kind) ? result : resultSummary(result);
      proposal.note = failure;
      proposal.undo = failure == null ? undo : null;
      if (failure == null && "points".equals(proposal.kind))
      {
        proposal.check = checkFor(proposal.spec, proposal.point, now);
        proposal.madeBy = approver;
      }
    }
    record(approverName, proposal.point, String.valueOf(proposal.summary.get("action")), proposal.actor, proposal.agentUser,
        describeWrite(proposal.summary), proposal.reason,
        (failure == null ? "approved " : "approval failed ") + proposal.id + " by " + approverName, failure);
    proposalsChanged(proposal);
    return proposal.toWire();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> castMap(Object value)
  {
    return (Map<String, Object>)value;
  }

  /** A result small enough to keep and list: file content and component snapshots are left out. */
  private Map<String, Object> resultSummary(Map<String, Object> result)
  {
    if (result == null) return null;
    Map<String, Object> slim = BaskStreamChanges.slim(result);
    if (changes.encodedSize(slim) <= 16 * 1024) return slim;
    Map<String, Object> note = new LinkedHashMap<String, Object>();
    note.put("note", "The result is too large to keep here; read the station to see it.");
    return note;
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

  /**
   * Puts a change back: the old value at the same priority level, the old file, the old schedule,
   * the old tags, or the reverse of a plan's steps. It runs with the permissions of the person who
   * asks for it, and it is refused when the target has been changed again since, unless
   * {@code force} is set. A change with steps that cannot be put back needs {@code partial}.
   */
  Map<String, Object> revert(String id, String reason, boolean force, boolean partial, Context person, BaskStreamClientSession session)
      throws BaskStreamProtocolException
  {
    String name = userName(person);
    if (name == null)
      throw new BaskStreamProtocolException("auth_required", "Putting a change back needs a signed-in Niagara user.");
    if (isAgentUser(name) || (session != null && isAgent(session)))
      throw new BaskStreamProtocolException("agent_cannot_approve", "Agents cannot put changes back; a person decides.");
    Proposal entry;
    synchronized (this)
    {
      entry = proposals.get(normalizeId(id));
    }
    if (entry == null)
      throw new BaskStreamProtocolException("proposal_not_found", "No change " + id + ". It may be older than the station keeps.");
    Map<String, Object> undo;
    synchronized (entry)
    {
      if ("reverted".equals(entry.status))
        throw new BaskStreamProtocolException("proposal_closed", "Change " + entry.id + " was already put back by " + entry.revertedBy + ".");
      if (!entry.made())
        throw new BaskStreamProtocolException("proposal_closed", "Change " + entry.id + " is " + entry.status + ", so there is nothing to put back.");
      undo = entry.undo;
      if (undo == null || undo.get("op") == null)
        throw new BaskStreamProtocolException("not_revertible", "Change " + entry.id + " cannot be put back"
            + (undo == null || undo.get("why") == null ? "." : ": " + undo.get("why")));
      if (undo.get("notReverted") != null && !partial)
        throw new BaskStreamProtocolException("not_revertible", "Part of change " + entry.id + " cannot be put back: "
            + undo.get("notReverted") + ". Send partial: true to put back the rest.");
    }
    if (!force)
    {
      String changed = changes.changedSince(undo, person);
      if (changed != null)
        throw new BaskStreamProtocolException("change_conflict", changed + " Send force: true to put it back anyway.");
    }
    Map<String, Object> result;
    try
    {
      result = changes.run(String.valueOf(undo.get("op")), castMap(undo.get("request")), person);
    }
    catch (BaskStreamProtocolException e)
    {
      record(name, entry.point, "revert", entry.actor, entry.agentUser, describeWrite(entry.summary), reason,
          "revert failed " + entry.id + " by " + name, e.getCode());
      throw e;
    }
    catch (Exception e)
    {
      record(name, entry.point, "revert", entry.actor, entry.agentUser, describeWrite(entry.summary), reason,
          "revert failed " + entry.id + " by " + name, "change_failed");
      throw new BaskStreamProtocolException("change_failed", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    synchronized (entry)
    {
      entry.status = "reverted";
      entry.revertedBy = name;
      entry.revertedAt = Clock.millis();
      if (entry.check != null && "waiting".equals(entry.check.get("state"))) entry.check.put("state", "skipped");
    }
    record(name, entry.point, "revert", entry.actor, entry.agentUser, describeWrite(entry.summary), reason,
        "reverted " + entry.id + " by " + name, null);
    proposalsChanged(entry);
    Map<String, Object> wire = entry.toWire();
    wire.put("revertResult", "points".equals(entry.kind) ? result : resultSummary(result));
    return wire;
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
      throw new BaskStreamProtocolException("proposal_not_found", "No proposal " + id + ". It may have been decided long ago, or been made after the station last saved before a restart.");
    // Deciding a point command needs the same read access as seeing the point.
    if ("points".equals(proposal.kind)) runtime.getResolver().resolve(proposal.point, decider);
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

  /**
   * Changes this session may see: an agent sees its own, a person sees point commands for points
   * they can read and every other kind. {@code everything} adds the changes agents made directly;
   * without it only those that waited for a person are listed.
   */
  List<Object> list(BaskStreamClientSession session, String status, String kind, boolean everything)
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
      if (proposal.direct && !everything) continue;
      if (kind != null && !kind.equals(proposal.kind)) continue;
      Map<String, Object> wire = proposal.toWire();
      if (status != null && !status.equals(wire.get("status"))) continue;
      if (canSee(session, proposal)) visible.add(wire);
    }
    return visible;
  }

  List<Object> list(BaskStreamClientSession session, String status)
  {
    return list(session, status, null, false);
  }

  /** Every change this Niagara user may see, newest first, for the service's own view. */
  List<Object> listFor(Context person)
  {
    String name = userName(person);
    boolean agent = isAgentUser(name);
    List<Proposal> snapshot;
    synchronized (this)
    {
      snapshot = new ArrayList<Proposal>(proposals.values());
    }
    List<Object> visible = new ArrayList<Object>();
    for (int i = snapshot.size() - 1; i >= 0; i--)
    {
      Proposal proposal = snapshot.get(i);
      if (agent && !proposal.agentUser.equalsIgnoreCase(name)) continue;
      if (!agent && "points".equals(proposal.kind))
      {
        try { runtime.getResolver().resolve(proposal.point, person); }
        catch (BaskStreamProtocolException e) { continue; }
      }
      visible.add(proposal.toWire());
    }
    return visible;
  }

  boolean canSee(BaskStreamClientSession session, Proposal proposal)
  {
    if (isAgent(session)) return proposal.agentUser.equalsIgnoreCase(session.getUsername());
    if (!"points".equals(proposal.kind)) return true;
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

  /** The most changes kept, waiting ones aside: {@code agentChangeHistory}. */
  int historySize()
  {
    Property p = service.getProperty("agentChangeHistory");
    return Math.max(10, Math.min(1000, p == null ? 200 : service.getInt(p)));
  }

  /** Expires old proposals, looks again at commanded points, and forgets old changes. Runs from the runtime's sweep. */
  void sweep(long now)
  {
    List<Proposal> expired = new ArrayList<Proposal>();
    List<Proposal> due = new ArrayList<Proposal>();
    boolean dropped = false;
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
            dropped = true;
          }
          else if (p.check != null && "waiting".equals(p.check.get("state")) && now >= ((Number)p.check.get("dueAt")).longValue())
          {
            due.add(p);
          }
        }
      }
      int keep = historySize();
      it = proposals.values().iterator();
      while (proposals.size() > keep && it.hasNext())
      {
        Proposal p = it.next();
        if ("pending".equals(p.status) || "deciding".equals(p.status)) continue;
        it.remove();
        dropped = true;
      }
    }
    for (Proposal p : expired)
    {
      record(p.agentUser, p.point, String.valueOf(p.summary.get("action")), p.actor, p.agentUser, describeWrite(p.summary),
          p.reason, "expired " + p.id, null);
      proposalsChanged(p);
    }
    for (Proposal p : due) lookAgain(p);
    if (dropped && expired.isEmpty() && due.isEmpty()) storeProposals();
  }

  /** The check after a point command: is the point readable, not in fault, and within what was expected. */
  private void lookAgain(Proposal p)
  {
    String state;
    Object found = null;
    String why = null;
    Context cx = p.madeBy;
    Map<String, Object> check = p.check;
    if (cx == null)
    {
      state = "unknown";
      why = "The station restarted before the check.";
    }
    else
    {
      try
      {
        Map<String, Object> now = runtime.getWriteResolver().peek(String.valueOf(check.get("point")), cx);
        found = now.get("displayValue") == null ? now.get("value") : now.get("displayValue");
        boolean ok = Boolean.TRUE.equals(now.get("ok"));
        if (!ok) why = "The point reads " + now.get("status") + ".";
        Object value = now.get("value");
        if (ok && value instanceof Number)
        {
          double number = ((Number)value).doubleValue();
          if (check.get("min") instanceof Number && number < ((Number)check.get("min")).doubleValue())
          {
            ok = false;
            why = "It reads " + found + ", below " + check.get("min") + ".";
          }
          if (check.get("max") instanceof Number && number > ((Number)check.get("max")).doubleValue())
          {
            ok = false;
            why = "It reads " + found + ", above " + check.get("max") + ".";
          }
        }
        state = ok ? "passed" : "failed";
      }
      catch (Exception e)
      {
        state = "failed";
        why = "The point could not be read: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
      }
    }
    synchronized (p)
    {
      check.put("state", state);
      check.put("checkedAt", Long.valueOf(Clock.millis()));
      if (found != null) check.put("found", found);
      if (why != null) check.put("message", why);
      p.madeBy = null;
    }
    if ("failed".equals(state))
      record(p.agentUser, String.valueOf(check.get("point")), "check", p.actor, p.agentUser, describeWrite(p.summary), p.reason,
          "check failed " + p.id, why);
    proposalsChanged(p);
  }

  // ---- Keeping proposals over a restart ---------------------------------------------------------

  /**
   * Writes the changes to the service's hidden {@code proposalStore} slot, so they are saved with
   * the station and are still there after a restart: the waiting ones with what they would run, the
   * decided ones with how to put them back.
   */
  private void storeProposals()
  {
    try
    {
      List<Object> kept = new ArrayList<Object>();
      synchronized (this)
      {
        for (Proposal p : proposals.values())
        {
          synchronized (p)
          {
            if ("deciding".equals(p.status)) continue;
            Map<String, Object> entry = new LinkedHashMap<String, Object>();
            entry.put("id", p.id);
            entry.put("status", p.status);
            entry.put("createdAt", Long.valueOf(p.createdAt));
            entry.put("expiresAt", Long.valueOf(p.expiresAt));
            entry.put("agentUser", p.agentUser);
            entry.put("actor", p.actor == null ? null : p.actor.toWire());
            entry.put("kind", p.kind);
            entry.put("op", p.op);
            entry.put("point", p.point);
            // Only a waiting change needs what it would run.
            entry.put("spec", "pending".equals(p.status) ? p.spec : null);
            entry.put("summary", p.summary);
            entry.put("reason", p.reason);
            entry.put("scope", p.scope);
            entry.put("direct", Boolean.valueOf(p.direct));
            entry.put("decidedBy", p.decidedBy);
            entry.put("decidedAt", Long.valueOf(p.decidedAt));
            entry.put("note", p.note);
            entry.put("undo", p.made() ? p.undo : null);
            entry.put("revertedBy", p.revertedBy);
            entry.put("revertedAt", Long.valueOf(p.revertedAt));
            entry.put("check", p.check);
            kept.add(entry);
          }
        }
      }
      Map<String, Object> message = new LinkedHashMap<String, Object>();
      message.put("proposals", kept);
      message.put("next", Long.valueOf(nextProposal.get()));
      service.storeProposals(kept.isEmpty() ? "" : java.util.Base64.getEncoder().encodeToString(runtime.getCodec().encodeMessage(message)));
    }
    catch (Exception e)
    {
      service.LOG.log(java.util.logging.Level.WARNING, "baskStream could not store the agent changes", e);
    }
  }

  /** Brings back the changes that were kept when the station last saved. Called once, at start. */
  @SuppressWarnings("unchecked")
  void restoreProposals()
  {
    String stored = service.storedProposals();
    if (stored == null || stored.length() == 0) return;
    try
    {
      Map<String, Object> message = runtime.getCodec().decodeMessage(java.util.Base64.getDecoder().decode(stored), Integer.MAX_VALUE);
      long now = Clock.millis();
      long highest = message.get("next") instanceof Number ? ((Number)message.get("next")).longValue() : 0L;
      int waiting = 0;
      synchronized (this)
      {
        for (Object item : (List<Object>)message.get("proposals"))
        {
          Map<String, Object> entry = (Map<String, Object>)item;
          String id = String.valueOf(entry.get("id"));
          if (id.length() > 1 && Character.isDigit(id.charAt(1))) highest = Math.max(highest, Long.parseLong(id.substring(1)));
          String status = entry.get("status") == null ? "pending" : String.valueOf(entry.get("status"));
          long expiresAt = ((Number)entry.get("expiresAt")).longValue();
          if (proposals.containsKey(id) || ("pending".equals(status) && expiresAt <= now)) continue;
          Map<String, Object> actorWire = (Map<String, Object>)entry.get("actor");
          Actor actor = actorWire == null ? null : new Actor(!"person".equals(actorWire.get("kind")), (String)actorWire.get("name"),
              (String)actorWire.get("model"), (String)actorWire.get("onBehalfOf"));
          Proposal p = new Proposal(id, ((Number)entry.get("createdAt")).longValue(), expiresAt, (String)entry.get("agentUser"),
              null, actor, entry.get("kind") == null ? "points" : (String)entry.get("kind"),
              entry.get("op") == null ? "write" : (String)entry.get("op"), (String)entry.get("point"),
              (Map<String, Object>)entry.get("spec"), (Map<String, Object>)entry.get("summary"), (String)entry.get("reason"),
              (String)entry.get("scope"), Boolean.TRUE.equals(entry.get("direct")));
          p.status = status;
          p.decidedBy = (String)entry.get("decidedBy");
          p.decidedAt = entry.get("decidedAt") instanceof Number ? ((Number)entry.get("decidedAt")).longValue() : 0L;
          p.note = (String)entry.get("note");
          p.undo = (Map<String, Object>)entry.get("undo");
          p.revertedBy = (String)entry.get("revertedBy");
          p.revertedAt = entry.get("revertedAt") instanceof Number ? ((Number)entry.get("revertedAt")).longValue() : 0L;
          p.check = (Map<String, Object>)entry.get("check");
          proposals.put(id, p);
          if ("pending".equals(status)) waiting++;
        }
        if (highest > nextProposal.get()) nextProposal.set(highest);
      }
      service.showPendingProposals(pendingSummary());
      service.agentNotice(noticeText());
      if (waiting > 0) service.LOG.info("baskStream: " + waiting + " proposal(s) that were waiting before the restart are waiting again.");
    }
    catch (Exception e)
    {
      service.LOG.log(java.util.logging.Level.WARNING, "baskStream could not bring back the stored agent changes", e);
    }
  }

  /**
   * What a person should look at now: changes waiting for a decision and checks that failed in the
   * last day. Blank when there is nothing. The service raises an alarm while it is not blank.
   */
  String noticeText()
  {
    int waiting = 0;
    int failed = 0;
    String first = null;
    long now = Clock.millis();
    synchronized (this)
    {
      for (Proposal p : proposals.values())
      {
        if ("pending".equals(p.status))
        {
          waiting++;
          if (first == null) first = p.id + " " + describeWrite(p.summary) + " on " + p.point;
        }
        else if (p.made() && p.check != null && "failed".equals(p.check.get("state"))
            && p.check.get("checkedAt") instanceof Number && now - ((Number)p.check.get("checkedAt")).longValue() < 24L * 60L * 60L * 1000L)
        {
          failed++;
          if (first == null) first = p.id + " check failed on " + p.check.get("point");
        }
      }
    }
    if (waiting == 0 && failed == 0) return "";
    StringBuilder text = new StringBuilder();
    if (waiting > 0) text.append(waiting).append(waiting == 1 ? " agent change is" : " agent changes are").append(" waiting for a person");
    if (failed > 0) text.append(text.length() > 0 ? "; " : "").append(failed).append(failed == 1 ? " check" : " checks").append(" after an agent change failed");
    return text.append(" (").append(first).append(").").toString();
  }

  /**
   * How a change that is not a point command reads in a list: what it does, on what, and how much.
   * Never the content itself.
   */
  @SuppressWarnings("unchecked")
  Map<String, Object> describeChange(String op, Map<String, Object> request, Map<String, Object> kept)
  {
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    String target = opTarget(request);
    summary.put("action", op);
    summary.put("display", target);
    StringBuilder text = new StringBuilder(op).append(' ').append(target);
    List<Object> lines = new ArrayList<Object>();
    if ("write_file".equals(op))
    {
      Object content = request.get("text") instanceof String ? request.get("text") : request.get("base64");
      text.append(" (").append(content instanceof String ? ((String)content).length() : 0).append(request.get("text") instanceof String ? " characters)" : " base64 characters)");
    }
    else if ("write_schedule".equals(op) && request.get("days") instanceof Map)
    {
      text.append(" (").append(((Map<String, Object>)request.get("days")).keySet()).append(")");
    }
    else if ("apply_model_changes".equals(op) && kept != null && kept.get("diffs") instanceof List)
    {
      List<Object> lost = new ArrayList<Object>();
      for (Object item : (List<Object>)kept.get("diffs"))
      {
        Map<String, Object> diff = (Map<String, Object>)item;
        String action = String.valueOf(diff.get("action"));
        String line = action + " " + (diff.get("ord") != null ? diff.get("ord") : diff.get("source") + " -> " + diff.get("target"));
        if (lines.size() < 100) lines.add(line);
        if ("delete".equals(action) || "invoke".equals(action) || "delete_link".equals(action) || "remove_slot".equals(action)) lost.add(line);
      }
      text.setLength(0);
      int steps = ((List<Object>)kept.get("diffs")).size();
      text.append("plan of ").append(steps).append(steps == 1 ? " step" : " steps");
      // A plan's id means nothing to a person: name what its first step is aimed at.
      Map<String, Object> firstStep = steps == 0 ? null : (Map<String, Object>)((List<Object>)kept.get("diffs")).get(0);
      Object where = firstStep == null ? null : firstStep.get("ord") != null ? firstStep.get("ord") : firstStep.get("target");
      if (where != null) summary.put("display", where + (steps > 1 ? " and " + (steps - 1) + " more" : ""));
      if (!lost.isEmpty()) summary.put("irreversible", lost);
    }
    else if ("write_tags".equals(op) || "write_relations".equals(op))
    {
      Object targets = request.get("targets");
      if (targets instanceof List && ((List<Object>)targets).size() > 1) text.append(" and ").append(((List<Object>)targets).size() - 1).append(" more");
    }
    if ("delete_file".equals(op) || op.startsWith("ack_alarm") || op.startsWith("clear_alarm") || "discover".equals(op) || "cancel_job".equals(op))
      summary.put("irreversible", java.util.Collections.<Object>singletonList(op + " cannot be put back"));
    summary.put("description", text.toString());
    if (!lines.isEmpty()) summary.put("changes", lines);
    return summary;
  }

  private void proposalsChanged(Proposal proposal)
  {
    storeProposals();
    service.showPendingProposals(pendingSummary());
    service.agentNotice(noticeText());
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
    for (String key : new String[] { "ord", "point", "planId", "source", "path", "job" })
    {
      Object value = request.get(key);
      if (value instanceof String && ((String)value).length() > 0) return (String)value;
    }
    Object targets = request.get("targets");
    if (targets instanceof List && !((List<?>)targets).isEmpty() && ((List<?>)targets).get(0) instanceof Map)
    {
      Object ord = ((Map<?, ?>)((List<?>)targets).get(0)).get("ord");
      if (ord instanceof String && ((String)ord).length() > 0) return (String)ord;
    }
    return "station";
  }
}
