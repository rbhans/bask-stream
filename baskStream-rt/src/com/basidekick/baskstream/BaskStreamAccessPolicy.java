package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

final class BaskStreamAccessPolicy
{
  private BaskStreamAccessPolicy()
  {
  }

  static boolean isAllowed(BBaskStreamService service, String ord)
  {
    // Slot paths are the policy boundary. Do not let a later ORD query or
    // parent traversal escape a prefix that matched the allowlist.
    if (ord == null || ord.indexOf('|') >= 0
        || ord.matches(".*(?:^|/)[.]{1,2}(?:/|$).*"))
    {
      return false;
    }

    for (Pattern pattern : parsePatterns(service.getAllowedPathPatterns()))
    {
      if (pattern.matcher(ord).matches())
      {
        return true;
      }
    }
    return false;
  }

  /**
   * Preserve the module's established behavior: an unset/empty policy and the
   * explicit catch-all patterns are wide open, subject to Niagara user permissions.
   */
  static boolean isDefaultWideOpen(BBaskStreamService service)
  {
    String configured = service.getAllowedPathPatterns();
    return configured == null
        || configured.trim().length() == 0
        || "slot:/*".equals(configured.trim())
        || "*".equals(configured.trim());
  }

  static String extractSlotOrd(String ord)
  {
    if (ord == null)
    {
      return null;
    }

    int index = ord.indexOf("slot:/");
    return index >= 0 ? ord.substring(index) : ord;
  }

  private static List<Pattern> parsePatterns(String configured)
  {
    String raw = configured == null ? "" : configured;
    String[] pieces = raw.split("[\\r\\n,;]+");
    List<Pattern> patterns = new ArrayList<Pattern>();
    for (int i = 0; i < pieces.length; i++)
    {
      String trimmed = pieces[i].trim();
      if (trimmed.length() == 0)
      {
        continue;
      }
      patterns.add(Pattern.compile(toRegex(trimmed)));
    }
    if (patterns.isEmpty())
    {
      patterns.add(Pattern.compile(toRegex("slot:/*")));
    }
    return patterns;
  }

  private static String toRegex(String wildcard)
  {
    StringBuilder regex = new StringBuilder("^");
    for (int i = 0; i < wildcard.length(); i++)
    {
      char ch = wildcard.charAt(i);
      if (ch == '*')
      {
        regex.append(".*");
      }
      else if ("\\.[]{}()+-^$?|".indexOf(ch) >= 0)
      {
        regex.append('\\').append(ch);
      }
      else
      {
        regex.append(ch);
      }
    }
    regex.append('$');
    return regex.toString();
  }
}
