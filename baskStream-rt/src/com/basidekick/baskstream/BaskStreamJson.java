package com.basidekick.baskstream;

import java.util.List;
import java.util.Map;

/** Writes the values replies are made of as JSON text, for the service's actions that answer the settings view. */
final class BaskStreamJson
{
  private BaskStreamJson()
  {
  }

  static String write(Object value)
  {
    StringBuilder out = new StringBuilder();
    write(out, value);
    return out.toString();
  }

  private static void write(StringBuilder out, Object value)
  {
    if (value == null || value instanceof Boolean) out.append(String.valueOf(value));
    else if (value instanceof Number)
    {
      double number = ((Number)value).doubleValue();
      if (Double.isNaN(number) || Double.isInfinite(number)) out.append("null");
      else if (value instanceof Double || value instanceof Float) out.append(number);
      else out.append(((Number)value).longValue());
    }
    else if (value instanceof Map)
    {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : ((Map<?, ?>)value).entrySet())
      {
        if (!first) out.append(',');
        first = false;
        text(out, String.valueOf(entry.getKey()));
        out.append(':');
        write(out, entry.getValue());
      }
      out.append('}');
    }
    else if (value instanceof List)
    {
      out.append('[');
      boolean first = true;
      for (Object item : (List<?>)value)
      {
        if (!first) out.append(',');
        first = false;
        write(out, item);
      }
      out.append(']');
    }
    else if (value instanceof byte[]) out.append("null");
    else text(out, value.toString());
  }

  private static void text(StringBuilder out, String text)
  {
    out.append('"');
    for (int i = 0; i < text.length(); i++)
    {
      char ch = text.charAt(i);
      if (ch == '"' || ch == '\\') out.append('\\').append(ch);
      else if (ch == '\n') out.append("\\n");
      else if (ch == '\r') out.append("\\r");
      else if (ch == '\t') out.append("\\t");
      else if (ch < 0x20 || ch == 0x2028 || ch == 0x2029) out.append(String.format("\\u%04x", (int)ch));
      else out.append(ch);
    }
    out.append('"');
  }
}
