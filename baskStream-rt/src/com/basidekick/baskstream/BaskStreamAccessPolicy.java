package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

final class BaskStreamAccessPolicy
{
  /**
   * A narrower reach for the request this thread is handling: the path patterns of the session's
   * agent profile. Set by the session around each request and each event it delivers, so every
   * check below applies it without being handed the session.
   */
  private static final ThreadLocal<List<Pattern>> SCOPE = new ThreadLocal<List<Pattern>>();

  private BaskStreamAccessPolicy()
  {
  }

  /** Narrows this thread to the given patterns until {@link #exitScope()}; blank leaves it as it is. */
  static void enterScope(String patterns)
  {
    if (patterns == null || patterns.trim().length() == 0)
    {
      SCOPE.remove();
      return;
    }
    // In a profile, "slot:/A/B/*" means B and everything under it: an agent given a branch has to be
    // able to open the branch itself. The service's own allowedPathPatterns keeps its exact matching.
    StringBuilder widened = new StringBuilder(patterns);
    for (String piece : patterns.split("[\\r\\n,;]+"))
    {
      String trimmed = piece.trim();
      if (trimmed.endsWith("/*") && trimmed.length() > 2)
      {
        widened.append('\n').append(trimmed.substring(0, trimmed.length() - 2));
      }
    }
    SCOPE.set(parsePatterns(widened.toString()));
  }

  static void exitScope()
  {
    SCOPE.remove();
  }

  private static boolean inScope(String ord)
  {
    List<Pattern> scope = SCOPE.get();
    if (scope == null)
    {
      return true;
    }
    for (Pattern pattern : scope)
    {
      if (pattern.matcher(ord).matches())
      {
        return true;
      }
    }
    return false;
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
        return inScope(ord);
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
    if (SCOPE.get() != null)
    {
      return false;
    }
    String configured = service.getAllowedPathPatterns();
    return configured == null
        || configured.trim().length() == 0
        || "slot:/*".equals(configured.trim())
        || "*".equals(configured.trim());
  }

  /**
   * The slot path of a local station ORD ({@code slot:/a}, {@code station:|slot:/a} or
   * {@code local:|station:|slot:/a}), or null for anything else, such as an ORD that reaches
   * another station. Remote and imported sources must not be judged as local paths.
   */
  static String localSlotOrd(String ord)
  {
    if (ord == null)
    {
      return null;
    }
    int index = ord.indexOf("slot:/");
    if (index < 0)
    {
      return null;
    }
    String prefix = ord.substring(0, index);
    return prefix.isEmpty() || "station:|".equals(prefix) || "local:|station:|".equals(prefix)
        ? ord.substring(index) : null;
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

  static String toRegex(String wildcard)
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
