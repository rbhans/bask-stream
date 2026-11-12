package com.basidekick.baskstream;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.baja.status.BStatus;
import javax.baja.sys.BAbsTime;
import javax.baja.sys.BBoolean;
import javax.baja.sys.BComplex;
import javax.baja.sys.BComponent;
import javax.baja.sys.BEnum;
import javax.baja.sys.BInteger;
import javax.baja.sys.BLink;
import javax.baja.sys.BLong;
import javax.baja.sys.BNumber;
import javax.baja.sys.BObject;
import javax.baja.sys.BSimple;
import javax.baja.sys.BString;
import javax.baja.sys.BValue;
import javax.baja.sys.Context;
import javax.baja.sys.Flags;
import javax.baja.sys.Property;

/** Baja values as plain wire data (query cells, job results) and as typed model-plan values. */
final class BaskStreamWire
{
  static final int MAX_DEPTH = 4;
  static final int MAX_PROPERTIES = 200;
  static final String REDACTED = "(redacted)";

  /**
   * A value a client can read without knowing Niagara encodings: strings, booleans and numbers as
   * themselves, times as epoch milliseconds, enums as their tag, other simples in their string
   * encoding, and structs as a map of their properties. Passwords and the like are redacted.
   */
  static Object plain(BObject value, String name, Context context, int depth)
  {
    if (value == null) return null;
    if (BaskStreamModelResolver.sensitive(name == null ? "" : name, value.getType().toString())) return REDACTED;
    if (value instanceof BString) return ((BString) value).getString();
    if (value instanceof BBoolean) return Boolean.valueOf(((BBoolean) value).getBoolean());
    if (value instanceof BInteger || value instanceof BLong) return Long.valueOf(((BNumber) value).getLong());
    if (value instanceof BNumber) return Double.valueOf(((BNumber) value).getDouble());
    if (value instanceof BAbsTime) return ((BAbsTime) value).isNull() ? null : Long.valueOf(((BAbsTime) value).getMillis());
    if (value instanceof BStatus) return value.toString(context);
    if (value instanceof BEnum) return ((BEnum) value).getTag();
    if (value instanceof BSimple)
    {
      try
      {
        return ((BSimple) value).encodeToString();
      }
      catch (IOException | RuntimeException e)
      {
        return value.toString(context);
      }
    }
    if (value instanceof BComplex)
    {
      if (depth >= MAX_DEPTH) return value.getType().toString();
      BComplex complex = (BComplex) value;
      Map<String, Object> out = new LinkedHashMap<String, Object>();
      for (Property property : complex.getPropertiesArray())
      {
        if (out.size() >= MAX_PROPERTIES) break;
        BValue child = complex.get(property);
        if (child instanceof BLink) continue;
        out.put(property.getName(), plain(child, property.getName(), context, depth + 1));
      }
      return out;
    }
    return value.toString(context);
  }

  /**
   * A value in the model-plan form ({typeSpec, encoded} or {typeSpec, properties}), so a value
   * read from the station can be handed to a plan without the client re-encoding it. Read-only and
   * transient properties are left out because a plan may not set them.
   */
  static Map<String, Object> typed(BValue value, int depth) throws BaskStreamProtocolException
  {
    Map<String, Object> wire = new LinkedHashMap<String, Object>();
    wire.put("typeSpec", value.getType().toString());
    if (value instanceof BSimple)
    {
      try
      {
        wire.put("encoded", ((BSimple) value).encodeToString());
      }
      catch (IOException e)
      {
        throw new BaskStreamProtocolException("invalid_value", "Could not encode a " + value.getType() + " value.");
      }
      return wire;
    }
    if (!(value instanceof BComplex) || depth >= 8)
    {
      throw new BaskStreamProtocolException("model_limit", "Value is nested too deeply to copy into a plan.");
    }
    BComplex complex = (BComplex) value;
    Map<String, Object> properties = new LinkedHashMap<String, Object>();
    for (Property property : complex.getPropertiesArray())
    {
      if (Flags.isReadonly(complex, property) || Flags.isTransient(complex, property)) continue;
      BValue child = complex.get(property);
      if (child instanceof BComponent || child instanceof BLink) continue;
      properties.put(property.getName(), typed(child, depth + 1));
    }
    wire.put("properties", properties);
    return wire;
  }

  static int integer(Map<String, Object> request, String key, int fallback, int min, int max) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null) return fallback;
    if (!(value instanceof Number) || ((Number) value).doubleValue() != ((Number) value).longValue()
        || ((Number) value).longValue() < min || ((Number) value).longValue() > max)
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be a whole number from " + min + " to " + max + ".");
    }
    return ((Number) value).intValue();
  }

  static String string(Map<String, Object> request, String key) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null) return null;
    if (!(value instanceof String))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be a string.");
    }
    String text = ((String) value).trim();
    return text.length() == 0 ? null : text;
  }

  private BaskStreamWire()
  {
  }
}
