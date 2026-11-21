package com.basidekick.baskstream;

import javax.baja.nre.annotations.NiagaraEnum;
import javax.baja.nre.annotations.NiagaraType;
import javax.baja.nre.annotations.Range;
import javax.baja.sys.BFrozenEnum;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;

/**
 * What the station does with one kind of change an AI agent asks for: refuse it, hold it as a
 * proposal for a person to approve, or let it through. The ordinals are saved in stations, so add
 * to the end and never reorder.
 */
@NiagaraType
@NiagaraEnum(
  range = {
    @Range("refuse"),
    @Range("ask"),
    @Range("allow")
  },
  defaultValue = "ask"
)
public final class BAgentMode extends BFrozenEnum
{
//region /*+ ------------ BEGIN BAJA AUTO GENERATED CODE ------------ +*/
//@formatter:off
/*@ $com.basidekick.baskstream.BAgentMode(831933456)1.0$ @*/
/* Generated Sat Nov 21 03:00:48 MST 2026 by Slot-o-Matic (c) Tridium, Inc. 2012-2026 */

  /** Ordinal value for refuse. */
  public static final int REFUSE = 0;
  /** Ordinal value for ask. */
  public static final int ASK = 1;
  /** Ordinal value for allow. */
  public static final int ALLOW = 2;

  /** BAgentMode constant for refuse. */
  public static final BAgentMode refuse = new BAgentMode(REFUSE);
  /** BAgentMode constant for ask. */
  public static final BAgentMode ask = new BAgentMode(ASK);
  /** BAgentMode constant for allow. */
  public static final BAgentMode allow = new BAgentMode(ALLOW);

  /** Factory method with ordinal. */
  public static BAgentMode make(int ordinal)
  {
    return (BAgentMode)refuse.getRange().get(ordinal, false);
  }

  /** Factory method with tag. */
  public static BAgentMode make(String tag)
  {
    return (BAgentMode)refuse.getRange().get(tag);
  }

  /** Private constructor. */
  private BAgentMode(int ordinal)
  {
    super(ordinal);
  }

  public static final BAgentMode DEFAULT = ask;

  //region Type

  @Override
  public Type getType() { return TYPE; }
  public static final Type TYPE = Sys.loadType(BAgentMode.class);

  //endregion Type

//@formatter:on
//endregion /*+ ------------ END BAJA AUTO GENERATED CODE -------------- +*/
}
