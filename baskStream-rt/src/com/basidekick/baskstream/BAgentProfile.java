package com.basidekick.baskstream;

import java.util.Locale;

import javax.baja.nre.annotations.Facet;
import javax.baja.nre.annotations.NiagaraProperty;
import javax.baja.nre.annotations.NiagaraType;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BComponent;
import javax.baja.sys.BFacets;
import javax.baja.sys.Flags;
import javax.baja.sys.Property;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;

/**
 * The rules for one AI agent, or for a few that do the same job: which Niagara users it covers
 * and what they may change. It lives under BASkStreamService, and its name is the profile's name.
 *
 * A user listed here is an agent, and follows these rules in place of the service's own agent
 * settings, which then cover only agents that have no profile. A profile can be narrower or wider
 * than those; what it can never do is pass the service's master switches (writesEnabled,
 * modelEditsEnabled), its allowedPathPatterns, or the user's Niagara roles.
 *
 * A profile that is turned off, or past its end time, leaves its users able to read and change
 * nothing. They stay agents: turning a profile off never turns an agent into a person.
 *
 * The agent settings have the same names as on the service, so one piece of code reads either.
 */
@NiagaraType
/** Off: this profile's users may read, and change nothing. */
@NiagaraProperty(
  name = "enabled",
  type = "boolean",
  defaultValue = "true",
  flags = Flags.SUMMARY
)
/** The Niagara users this profile covers, comma separated. A user belongs to the first profile that lists it. */
@NiagaraProperty(
  name = "users",
  type = "baja:String",
  defaultValue = "",
  flags = Flags.SUMMARY
)
/** When this profile stops allowing changes, for work with an end date. Null = no end. */
@NiagaraProperty(
  name = "expires",
  type = "baja:AbsTime",
  defaultValue = "BAbsTime.NULL",
  flags = Flags.SUMMARY
)
/** The parts of the station these users may reach, one slot path per line, * matching anything. Narrower than the service's allowedPathPatterns, never wider. Blank = whatever the service allows. */
@NiagaraProperty(
  name = "pathPatterns",
  type = "baja:String",
  defaultValue = "",
  facets = @Facet(name = "BFacets.MULTI_LINE", value = "true")
)
/** What a point command does: refuse it, ask a person (it becomes a proposal), or allow it within the limits below. */
@NiagaraProperty(
  name = "agentPointWrites",
  type = "baskStream:AgentMode",
  defaultValue = "BAgentMode.ask",
  flags = Flags.SUMMARY
)
/** Station file paths these users may write and delete, comma separated, where * matches anything (blank = none). */
@NiagaraProperty(
  name = "agentDirectFiles",
  type = "baja:String",
  defaultValue = ""
)
/** May start BACnet discovery, cancel a job, and add the devices and points discovery found. */
@NiagaraProperty(
  name = "agentDirectDiscovery",
  type = "boolean",
  defaultValue = "false"
)
/** May apply any model plan (create, change, link, rename, move and delete components, invoke actions). */
@NiagaraProperty(
  name = "agentDirectModelEdits",
  type = "boolean",
  defaultValue = "false"
)
/** May write tags and relations. */
@NiagaraProperty(
  name = "agentDirectTags",
  type = "boolean",
  defaultValue = "false"
)
/** May change schedules. */
@NiagaraProperty(
  name = "agentDirectSchedules",
  type = "boolean",
  defaultValue = "false"
)
/** May acknowledge and clear alarms. */
@NiagaraProperty(
  name = "agentDirectAlarms",
  type = "boolean",
  defaultValue = "false"
)
/** A reason is required with every change or proposal. */
@NiagaraProperty(
  name = "agentRequireReason",
  type = "boolean",
  defaultValue = "true"
)
/** Changes and proposals each of these users may make per minute. 0 = no limit. */
@NiagaraProperty(
  name = "agentMaxChangesPerMinute",
  type = "int",
  defaultValue = "10"
)
/** May use emergency (priority level 1) commands. */
@NiagaraProperty(
  name = "agentAllowEmergency",
  type = "boolean",
  defaultValue = "false"
)
/** Kinds of change that wait for a person instead of being refused when they are not allowed directly: any of files, discovery, modelEdits, tags, schedules, alarms. */
@NiagaraProperty(
  name = "agentAskKinds",
  type = "baja:String",
  defaultValue = ""
)
/** Value limits, one rule per line: an ORD pattern and a range, e.g. slot:/Floor1/VAV_01/ZoneSP 68..76. The first rule that matches a point applies. */
@NiagaraProperty(
  name = "agentBounds",
  type = "baja:String",
  defaultValue = "",
  facets = @Facet(name = "BFacets.MULTI_LINE", value = "true")
)
/** What a command does on a point no rule in agentBounds names: allow it (as agentPointWrites says), ask a person, or refuse it. */
@NiagaraProperty(
  name = "agentUnlistedPoints",
  type = "baskStream:AgentMode",
  defaultValue = "BAgentMode.allow"
)
public final class BAgentProfile extends BComponent
{
//region /*+ ------------ BEGIN BAJA AUTO GENERATED CODE ------------ +*/
//@formatter:off
/*@ $com.basidekick.baskstream.BAgentProfile(3023887536)1.0$ @*/
/* Generated Sat Nov 21 13:27:00 MST 2026 by Slot-o-Matic (c) Tridium, Inc. 2012-2026 */

  //region Property "enabled"

  /**
   * Slot for the {@code enabled} property.
   * Off: this profile's users may read, and change nothing.
   * @see #getEnabled
   * @see #setEnabled
   */
  public static final Property enabled = newProperty(Flags.SUMMARY, true, null);

  /**
   * Get the {@code enabled} property.
   * Off: this profile's users may read, and change nothing.
   * @see #enabled
   */
  public boolean getEnabled() { return getBoolean(enabled); }

  /**
   * Set the {@code enabled} property.
   * Off: this profile's users may read, and change nothing.
   * @see #enabled
   */
  public void setEnabled(boolean v) { setBoolean(enabled, v, null); }

  //endregion Property "enabled"

  //region Property "users"

  /**
   * Slot for the {@code users} property.
   * The Niagara users this profile covers, comma separated. A user belongs to the first profile that lists it.
   * @see #getUsers
   * @see #setUsers
   */
  public static final Property users = newProperty(Flags.SUMMARY, "", null);

  /**
   * Get the {@code users} property.
   * The Niagara users this profile covers, comma separated. A user belongs to the first profile that lists it.
   * @see #users
   */
  public String getUsers() { return getString(users); }

  /**
   * Set the {@code users} property.
   * The Niagara users this profile covers, comma separated. A user belongs to the first profile that lists it.
   * @see #users
   */
  public void setUsers(String v) { setString(users, v, null); }

  //endregion Property "users"

  //region Property "expires"

  /**
   * Slot for the {@code expires} property.
   * When this profile stops allowing changes, for work with an end date. Null = no end.
   * @see #getExpires
   * @see #setExpires
   */
  public static final Property expires = newProperty(Flags.SUMMARY, BAbsTime.NULL, null);

  /**
   * Get the {@code expires} property.
   * When this profile stops allowing changes, for work with an end date. Null = no end.
   * @see #expires
   */
  public BAbsTime getExpires() { return (BAbsTime)get(expires); }

  /**
   * Set the {@code expires} property.
   * When this profile stops allowing changes, for work with an end date. Null = no end.
   * @see #expires
   */
  public void setExpires(BAbsTime v) { set(expires, v, null); }

  //endregion Property "expires"

  //region Property "pathPatterns"

  /**
   * Slot for the {@code pathPatterns} property.
   * The parts of the station these users may reach, one slot path per line, * matching anything. Narrower than the service's allowedPathPatterns, never wider. Blank = whatever the service allows.
   * @see #getPathPatterns
   * @see #setPathPatterns
   */
  public static final Property pathPatterns = newProperty(0, "", BFacets.make(BFacets.MULTI_LINE, true));

  /**
   * Get the {@code pathPatterns} property.
   * The parts of the station these users may reach, one slot path per line, * matching anything. Narrower than the service's allowedPathPatterns, never wider. Blank = whatever the service allows.
   * @see #pathPatterns
   */
  public String getPathPatterns() { return getString(pathPatterns); }

  /**
   * Set the {@code pathPatterns} property.
   * The parts of the station these users may reach, one slot path per line, * matching anything. Narrower than the service's allowedPathPatterns, never wider. Blank = whatever the service allows.
   * @see #pathPatterns
   */
  public void setPathPatterns(String v) { setString(pathPatterns, v, null); }

  //endregion Property "pathPatterns"

  //region Property "agentPointWrites"

  /**
   * Slot for the {@code agentPointWrites} property.
   * What a point command does: refuse it, ask a person (it becomes a proposal), or allow it within the limits below.
   * @see #getAgentPointWrites
   * @see #setAgentPointWrites
   */
  public static final Property agentPointWrites = newProperty(Flags.SUMMARY, BAgentMode.ask, null);

  /**
   * Get the {@code agentPointWrites} property.
   * What a point command does: refuse it, ask a person (it becomes a proposal), or allow it within the limits below.
   * @see #agentPointWrites
   */
  public BAgentMode getAgentPointWrites() { return (BAgentMode)get(agentPointWrites); }

  /**
   * Set the {@code agentPointWrites} property.
   * What a point command does: refuse it, ask a person (it becomes a proposal), or allow it within the limits below.
   * @see #agentPointWrites
   */
  public void setAgentPointWrites(BAgentMode v) { set(agentPointWrites, v, null); }

  //endregion Property "agentPointWrites"

  //region Property "agentDirectFiles"

  /**
   * Slot for the {@code agentDirectFiles} property.
   * Station file paths these users may write and delete, comma separated, where * matches anything (blank = none).
   * @see #getAgentDirectFiles
   * @see #setAgentDirectFiles
   */
  public static final Property agentDirectFiles = newProperty(0, "", null);

  /**
   * Get the {@code agentDirectFiles} property.
   * Station file paths these users may write and delete, comma separated, where * matches anything (blank = none).
   * @see #agentDirectFiles
   */
  public String getAgentDirectFiles() { return getString(agentDirectFiles); }

  /**
   * Set the {@code agentDirectFiles} property.
   * Station file paths these users may write and delete, comma separated, where * matches anything (blank = none).
   * @see #agentDirectFiles
   */
  public void setAgentDirectFiles(String v) { setString(agentDirectFiles, v, null); }

  //endregion Property "agentDirectFiles"

  //region Property "agentDirectDiscovery"

  /**
   * Slot for the {@code agentDirectDiscovery} property.
   * May start BACnet discovery, cancel a job, and add the devices and points discovery found.
   * @see #getAgentDirectDiscovery
   * @see #setAgentDirectDiscovery
   */
  public static final Property agentDirectDiscovery = newProperty(0, false, null);

  /**
   * Get the {@code agentDirectDiscovery} property.
   * May start BACnet discovery, cancel a job, and add the devices and points discovery found.
   * @see #agentDirectDiscovery
   */
  public boolean getAgentDirectDiscovery() { return getBoolean(agentDirectDiscovery); }

  /**
   * Set the {@code agentDirectDiscovery} property.
   * May start BACnet discovery, cancel a job, and add the devices and points discovery found.
   * @see #agentDirectDiscovery
   */
  public void setAgentDirectDiscovery(boolean v) { setBoolean(agentDirectDiscovery, v, null); }

  //endregion Property "agentDirectDiscovery"

  //region Property "agentDirectModelEdits"

  /**
   * Slot for the {@code agentDirectModelEdits} property.
   * May apply any model plan (create, change, link, rename, move and delete components, invoke actions).
   * @see #getAgentDirectModelEdits
   * @see #setAgentDirectModelEdits
   */
  public static final Property agentDirectModelEdits = newProperty(0, false, null);

  /**
   * Get the {@code agentDirectModelEdits} property.
   * May apply any model plan (create, change, link, rename, move and delete components, invoke actions).
   * @see #agentDirectModelEdits
   */
  public boolean getAgentDirectModelEdits() { return getBoolean(agentDirectModelEdits); }

  /**
   * Set the {@code agentDirectModelEdits} property.
   * May apply any model plan (create, change, link, rename, move and delete components, invoke actions).
   * @see #agentDirectModelEdits
   */
  public void setAgentDirectModelEdits(boolean v) { setBoolean(agentDirectModelEdits, v, null); }

  //endregion Property "agentDirectModelEdits"

  //region Property "agentDirectTags"

  /**
   * Slot for the {@code agentDirectTags} property.
   * May write tags and relations.
   * @see #getAgentDirectTags
   * @see #setAgentDirectTags
   */
  public static final Property agentDirectTags = newProperty(0, false, null);

  /**
   * Get the {@code agentDirectTags} property.
   * May write tags and relations.
   * @see #agentDirectTags
   */
  public boolean getAgentDirectTags() { return getBoolean(agentDirectTags); }

  /**
   * Set the {@code agentDirectTags} property.
   * May write tags and relations.
   * @see #agentDirectTags
   */
  public void setAgentDirectTags(boolean v) { setBoolean(agentDirectTags, v, null); }

  //endregion Property "agentDirectTags"

  //region Property "agentDirectSchedules"

  /**
   * Slot for the {@code agentDirectSchedules} property.
   * May change schedules.
   * @see #getAgentDirectSchedules
   * @see #setAgentDirectSchedules
   */
  public static final Property agentDirectSchedules = newProperty(0, false, null);

  /**
   * Get the {@code agentDirectSchedules} property.
   * May change schedules.
   * @see #agentDirectSchedules
   */
  public boolean getAgentDirectSchedules() { return getBoolean(agentDirectSchedules); }

  /**
   * Set the {@code agentDirectSchedules} property.
   * May change schedules.
   * @see #agentDirectSchedules
   */
  public void setAgentDirectSchedules(boolean v) { setBoolean(agentDirectSchedules, v, null); }

  //endregion Property "agentDirectSchedules"

  //region Property "agentDirectAlarms"

  /**
   * Slot for the {@code agentDirectAlarms} property.
   * May acknowledge and clear alarms.
   * @see #getAgentDirectAlarms
   * @see #setAgentDirectAlarms
   */
  public static final Property agentDirectAlarms = newProperty(0, false, null);

  /**
   * Get the {@code agentDirectAlarms} property.
   * May acknowledge and clear alarms.
   * @see #agentDirectAlarms
   */
  public boolean getAgentDirectAlarms() { return getBoolean(agentDirectAlarms); }

  /**
   * Set the {@code agentDirectAlarms} property.
   * May acknowledge and clear alarms.
   * @see #agentDirectAlarms
   */
  public void setAgentDirectAlarms(boolean v) { setBoolean(agentDirectAlarms, v, null); }

  //endregion Property "agentDirectAlarms"

  //region Property "agentRequireReason"

  /**
   * Slot for the {@code agentRequireReason} property.
   * A reason is required with every change or proposal.
   * @see #getAgentRequireReason
   * @see #setAgentRequireReason
   */
  public static final Property agentRequireReason = newProperty(0, true, null);

  /**
   * Get the {@code agentRequireReason} property.
   * A reason is required with every change or proposal.
   * @see #agentRequireReason
   */
  public boolean getAgentRequireReason() { return getBoolean(agentRequireReason); }

  /**
   * Set the {@code agentRequireReason} property.
   * A reason is required with every change or proposal.
   * @see #agentRequireReason
   */
  public void setAgentRequireReason(boolean v) { setBoolean(agentRequireReason, v, null); }

  //endregion Property "agentRequireReason"

  //region Property "agentMaxChangesPerMinute"

  /**
   * Slot for the {@code agentMaxChangesPerMinute} property.
   * Changes and proposals each of these users may make per minute. 0 = no limit.
   * @see #getAgentMaxChangesPerMinute
   * @see #setAgentMaxChangesPerMinute
   */
  public static final Property agentMaxChangesPerMinute = newProperty(0, 10, null);

  /**
   * Get the {@code agentMaxChangesPerMinute} property.
   * Changes and proposals each of these users may make per minute. 0 = no limit.
   * @see #agentMaxChangesPerMinute
   */
  public int getAgentMaxChangesPerMinute() { return getInt(agentMaxChangesPerMinute); }

  /**
   * Set the {@code agentMaxChangesPerMinute} property.
   * Changes and proposals each of these users may make per minute. 0 = no limit.
   * @see #agentMaxChangesPerMinute
   */
  public void setAgentMaxChangesPerMinute(int v) { setInt(agentMaxChangesPerMinute, v, null); }

  //endregion Property "agentMaxChangesPerMinute"

  //region Property "agentAllowEmergency"

  /**
   * Slot for the {@code agentAllowEmergency} property.
   * May use emergency (priority level 1) commands.
   * @see #getAgentAllowEmergency
   * @see #setAgentAllowEmergency
   */
  public static final Property agentAllowEmergency = newProperty(0, false, null);

  /**
   * Get the {@code agentAllowEmergency} property.
   * May use emergency (priority level 1) commands.
   * @see #agentAllowEmergency
   */
  public boolean getAgentAllowEmergency() { return getBoolean(agentAllowEmergency); }

  /**
   * Set the {@code agentAllowEmergency} property.
   * May use emergency (priority level 1) commands.
   * @see #agentAllowEmergency
   */
  public void setAgentAllowEmergency(boolean v) { setBoolean(agentAllowEmergency, v, null); }

  //endregion Property "agentAllowEmergency"

  //region Property "agentAskKinds"

  /**
   * Slot for the {@code agentAskKinds} property.
   * Kinds of change that wait for a person instead of being refused when they are not allowed directly: any of files, discovery, modelEdits, tags, schedules, alarms.
   * @see #getAgentAskKinds
   * @see #setAgentAskKinds
   */
  public static final Property agentAskKinds = newProperty(0, "", null);

  /**
   * Get the {@code agentAskKinds} property.
   * Kinds of change that wait for a person instead of being refused when they are not allowed directly: any of files, discovery, modelEdits, tags, schedules, alarms.
   * @see #agentAskKinds
   */
  public String getAgentAskKinds() { return getString(agentAskKinds); }

  /**
   * Set the {@code agentAskKinds} property.
   * Kinds of change that wait for a person instead of being refused when they are not allowed directly: any of files, discovery, modelEdits, tags, schedules, alarms.
   * @see #agentAskKinds
   */
  public void setAgentAskKinds(String v) { setString(agentAskKinds, v, null); }

  //endregion Property "agentAskKinds"

  //region Property "agentBounds"

  /**
   * Slot for the {@code agentBounds} property.
   * Value limits, one rule per line: an ORD pattern and a range, e.g. slot:/Floor1/VAV_01/ZoneSP 68..76. The first rule that matches a point applies.
   * @see #getAgentBounds
   * @see #setAgentBounds
   */
  public static final Property agentBounds = newProperty(0, "", BFacets.make(BFacets.MULTI_LINE, true));

  /**
   * Get the {@code agentBounds} property.
   * Value limits, one rule per line: an ORD pattern and a range, e.g. slot:/Floor1/VAV_01/ZoneSP 68..76. The first rule that matches a point applies.
   * @see #agentBounds
   */
  public String getAgentBounds() { return getString(agentBounds); }

  /**
   * Set the {@code agentBounds} property.
   * Value limits, one rule per line: an ORD pattern and a range, e.g. slot:/Floor1/VAV_01/ZoneSP 68..76. The first rule that matches a point applies.
   * @see #agentBounds
   */
  public void setAgentBounds(String v) { setString(agentBounds, v, null); }

  //endregion Property "agentBounds"

  //region Property "agentUnlistedPoints"

  /**
   * Slot for the {@code agentUnlistedPoints} property.
   * What a command does on a point no rule in agentBounds names: allow it (as agentPointWrites says), ask a person, or refuse it.
   * @see #getAgentUnlistedPoints
   * @see #setAgentUnlistedPoints
   */
  public static final Property agentUnlistedPoints = newProperty(0, BAgentMode.allow, null);

  /**
   * Get the {@code agentUnlistedPoints} property.
   * What a command does on a point no rule in agentBounds names: allow it (as agentPointWrites says), ask a person, or refuse it.
   * @see #agentUnlistedPoints
   */
  public BAgentMode getAgentUnlistedPoints() { return (BAgentMode)get(agentUnlistedPoints); }

  /**
   * Set the {@code agentUnlistedPoints} property.
   * What a command does on a point no rule in agentBounds names: allow it (as agentPointWrites says), ask a person, or refuse it.
   * @see #agentUnlistedPoints
   */
  public void setAgentUnlistedPoints(BAgentMode v) { set(agentUnlistedPoints, v, null); }

  //endregion Property "agentUnlistedPoints"

  //region Type

  @Override
  public Type getType() { return TYPE; }
  public static final Type TYPE = Sys.loadType(BAgentProfile.class);

  //endregion Type

//@formatter:on
//endregion /*+ ------------ END BAJA AUTO GENERATED CODE -------------- +*/
  @Override
  public boolean isParentLegal(BComponent parent)
  {
    return parent instanceof BBaskStreamService;
  }

  // Read by name, like the service's agent settings, so these do not depend on generated getters.

  boolean isOn()
  {
    Property p = getProperty("enabled");
    return p == null || getBoolean(p);
  }

  /** When the profile ends, in milliseconds, or 0 for no end. */
  long endsAt()
  {
    Property p = getProperty("expires");
    if (p == null) return 0L;
    BAbsTime time = (BAbsTime)get(p);
    return time == null || time.isNull() ? 0L : time.getMillis();
  }

  boolean lists(String username)
  {
    Property p = getProperty("users");
    if (p == null || username == null) return false;
    String wanted = username.toLowerCase(Locale.ROOT);
    for (String piece : getString(p).split("[\\s,;]+"))
      if (piece.trim().toLowerCase(Locale.ROOT).equals(wanted)) return true;
    return false;
  }
}
