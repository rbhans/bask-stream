/*
 * Copyright 2026 Robert Hansen. Licensed under the Apache License, Version 2.0.
 */
package com.basidekick.baskstream.ux;

import javax.baja.naming.BOrd;
import javax.baja.nre.annotations.AgentOn;
import javax.baja.nre.annotations.NiagaraSingleton;
import javax.baja.nre.annotations.NiagaraType;
import javax.baja.sys.BSingleton;
import javax.baja.sys.Context;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;
import javax.baja.web.BIFormFactorMax;
import javax.baja.web.js.BIJavaScript;
import javax.baja.web.js.JsInfo;

/**
 * The settings view of {@code baskStream:BaskStreamService}: the service's own properties, grouped
 * and explained. It reads and sets the same slots as the property sheet and adds none.
 */
@NiagaraType(agent = @AgentOn(
  types = { "baskStream:BaskStreamService" },
  requiredPermissions = "r"
))
@NiagaraSingleton
public final class BBaskStreamSettings extends BSingleton
  implements BIJavaScript, BIFormFactorMax
{
//region /*+ ------------ BEGIN BAJA AUTO GENERATED CODE ------------ +*/
//@formatter:off
/*@ $com.basidekick.baskstream.ux.BBaskStreamSettings(618600797)1.0$ @*/
/* Generated Sat Nov 21 03:00:49 MST 2026 by Slot-o-Matic (c) Tridium, Inc. 2012-2026 */

  public static final BBaskStreamSettings INSTANCE = new BBaskStreamSettings();

  //region Type

  @Override
  public Type getType() { return TYPE; }
  public static final Type TYPE = Sys.loadType(BBaskStreamSettings.class);

  //endregion Type

//@formatter:on
//endregion /*+ ------------ END BAJA AUTO GENERATED CODE -------------- +*/

  private static final JsInfo JS_INFO =
    JsInfo.make(BOrd.make("module://baskStream/rc/views/BaskStreamSettings.js"));

  private BBaskStreamSettings()
  {
  }

  @Override
  public JsInfo getJsInfo(Context context)
  {
    return JS_INFO;
  }
}
