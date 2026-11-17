package com.basidekick.baskstream;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.baja.agent.BPxView;
import javax.baja.control.BControlPoint;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdQuery;
import javax.baja.naming.OrdTarget;
import javax.baja.naming.SlotPath;
import javax.baja.security.BPermissions;
import javax.baja.sys.BComponent;
import javax.baja.sys.BFacets;
import javax.baja.sys.BObject;
import javax.baja.sys.BValue;
import javax.baja.sys.Context;
import javax.baja.sys.Property;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;
import javax.baja.user.BUser;
import javax.baja.user.BUserService;
import javax.baja.util.BTypeSpec;
import javax.baja.xml.XElem;
import javax.baja.xml.XParser;

/**
 * Graphics work on the station (API 1.12): read, check and write Px files, check a Px's bindings
 * against many components at once, attach Px views, check nav files, and take an inventory of the
 * station's graphics with a punch list of what is broken.
 *
 * <p>Everything runs as the session's user. ORDs found in files are resolved only when every query
 * in them is local to this station (station, local, slot, h, service, file under ^, module); BQL,
 * history, remote and other ORDs are reported as not checked rather than run. Resolved components
 * must be readable and inside allowedPathPatterns, or they count as forbidden.
 */
final class BaskStreamGraphicsResolver
{
  static final int MAX_TARGETS = 500;
  static final int DEFAULT_MAX_COMPONENTS = 100000;
  static final int MAX_COMPONENTS = 200000;
  static final int MAX_FILES = 2000;
  static final int MAX_PX_FILES = 500;
  static final int MAX_PUNCH_ITEMS = 1000;
  static final int DEFAULT_TIMEOUT_MILLIS = 30000;
  static final int MAX_TIMEOUT_MILLIS = 60000;
  static final int SUGGESTIONS = 3;

  private static final Set<String> LOCAL_SCHEMES = new HashSet<String>(Arrays.asList("station", "local", "slot", "h", "service"));
  private static final Set<String> IMAGE_EXTENSIONS = new HashSet<String>(Arrays.asList("png", "jpg", "jpeg", "gif", "svg", "bmp"));

  private final BBaskStreamService service;
  private final BaskStreamFileResolver files;

  BaskStreamGraphicsResolver(BBaskStreamService service, BaskStreamFileResolver files)
  {
    this.service = service;
    this.files = files;
  }

  // ---- read_px, validate_px, write_px ------------------------------------------------------------

  Map<String, Object> readPx(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String path = BaskStreamFileResolver.canonical(request.get("path"));
    BaskStreamPx.Doc doc = BaskStreamPx.parse(files.readBytes(path, context));
    Map<String, Object> result = describe(doc, path);
    if (Boolean.TRUE.equals(request.get("tree")) && doc.root != null) result.put("tree", BaskStreamPx.tree(doc, doc.root));
    return result;
  }

  Map<String, Object> validatePx(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    Source source = source(request, context, false);
    BaskStreamPx.Doc doc = BaskStreamPx.parse(source.bytes);
    checkRefs(doc, context);
    Map<String, Object> result = describe(doc, source.path);
    result.put("valid", Boolean.valueOf(doc.valid()));
    return result;
  }

  Map<String, Object> writePx(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String path = BaskStreamFileResolver.canonical(request.get("path"));
    if (!path.toLowerCase(Locale.ROOT).endsWith(".px"))
    {
      throw new BaskStreamProtocolException("bad_request", "write_px writes .px files; use write_file for " + path + ".");
    }
    Source source = source(request, context, true);
    BaskStreamPx.Doc doc = BaskStreamPx.parse(source.bytes);
    checkRefs(doc, context);
    if (!doc.valid())
    {
      throw new BaskStreamProtocolException("px_invalid", path + " was not written: " + doc.count("error") + " error"
          + (doc.count("error") == 1 ? "" : "s") + " (" + doc.errorSummary(5) + "). validate_px lists them all.");
    }
    Map<String, Object> write = new LinkedHashMap<String, Object>();
    write.put("path", path);
    write.put("text", new String(source.bytes, StandardCharsets.UTF_8));
    for (String key : new String[] { "overwrite", "createDirs", "backup", "dryRun" })
    {
      if (request.containsKey(key)) write.put(key, request.get(key));
    }
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("file", files.write(write, context));
    Map<String, Object> validation = describe(doc, path);
    validation.put("valid", Boolean.TRUE);
    result.put("validation", validation);
    return result;
  }

  private static final class Source
  {
    final String path;
    final byte[] bytes;

    Source(String path, byte[] bytes)
    {
      this.path = path;
      this.bytes = bytes;
    }
  }

  /** The Px to work on: text or a tree in the request, or (unless writing) a file on the station. */
  private Source source(Map<String, Object> request, Context context, boolean writing) throws BaskStreamProtocolException
  {
    Object text = request.get("text");
    Object tree = request.get("tree");
    String path = request.get("path") == null ? null : BaskStreamFileResolver.canonical(request.get("path"));
    if (text != null && tree != null) throw new BaskStreamProtocolException("bad_request", "Send the Px as one of 'text' or 'tree', not both.");
    if (text != null && !(text instanceof String)) throw new BaskStreamProtocolException("bad_request", "Field 'text' must be a string.");
    if (text instanceof String) return new Source(path, ((String) text).getBytes(StandardCharsets.UTF_8));
    if (tree != null) return new Source(path, BaskStreamPx.toXml(tree).getBytes(StandardCharsets.UTF_8));
    if (writing) throw new BaskStreamProtocolException("bad_request", "Send the Px to write as 'text' or 'tree'.");
    if (path == null) throw new BaskStreamProtocolException("bad_request", "Send 'path' (a Px on the station), 'text' or 'tree'.");
    return new Source(path, files.readBytes(path, context));
  }

  private static Map<String, Object> describe(BaskStreamPx.Doc doc, String path)
  {
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    if (path != null) result.put("path", path);
    result.put("version", doc.version);
    result.put("media", doc.media);
    result.put("imports", new ArrayList<Object>(doc.imports));
    result.put("elements", Long.valueOf(doc.elements));
    Map<String, Object> types = new LinkedHashMap<String, Object>();
    for (Map.Entry<String, Integer> type : doc.types.entrySet()) types.put(type.getKey(), Long.valueOf(type.getValue().intValue()));
    result.put("types", types);
    result.put("references", doc.refsWire());
    result.put("errors", Long.valueOf(doc.count("error")));
    result.put("warnings", Long.valueOf(doc.count("warning")));
    result.put("problems", doc.problemsWire());
    result.put("truncated", Boolean.valueOf(doc.truncated));
    return result;
  }

  /**
   * Adds problems for references that are certainly broken: widget views from modules that are not
   * installed, files and includes that are missing, and absolute ORDs that do not resolve. Relative
   * bindings depend on the component a view is attached to; check_px_bindings checks those.
   */
  private void checkRefs(BaskStreamPx.Doc doc, Context context)
  {
    Map<String, Resolution> seen = new HashMap<String, Resolution>();
    for (BaskStreamPx.Ref ref : doc.refs)
    {
      if ("view".equals(ref.kind))
      {
        String module = BaskStreamPx.viewModule(ref.ord);
        if (module != null && !BaskStreamPx.moduleInstalled(module))
          doc.problem("error", "module_missing", "Widget view " + ref.ord + " needs module " + module + ", which is not installed.", ref.line);
        continue;
      }
      Resolution resolution = seen.get(ref.ord);
      if (resolution == null)
      {
        resolution = resolve(ref.ord, null, context);
        seen.put(ref.ord, resolution);
      }
      if ("ok".equals(resolution.status) || "not_checked".equals(resolution.status) || "relative".equals(resolution.status)) continue;
      boolean include = "include".equals(ref.kind);
      doc.problem(include ? "error" : "warning", include ? "include_missing" : "reference_" + resolution.status,
          describeRef(ref) + " " + ref.ord + " " + ("forbidden".equals(resolution.status) ? "is not readable here" : "does not resolve")
              + (resolution.reason == null ? "" : ": " + resolution.reason) + ".", ref.line);
    }
  }

  private static String describeRef(BaskStreamPx.Ref ref)
  {
    if ("binding".equals(ref.kind)) return "Binding";
    if ("include".equals(ref.kind)) return "Include";
    if ("link".equals(ref.kind)) return "Hyperlink";
    if ("file".equals(ref.kind)) return "File " + (ref.property == null ? "" : "(" + ref.property + ")");
    return "ORD property " + (ref.property == null ? "" : ref.property);
  }

  // ---- Resolving references ----------------------------------------------------------------------

  static final class Resolution
  {
    /** ok, missing, forbidden, invalid, relative (needs a component to resolve from) or not_checked. */
    final String status;
    final String reason;
    String typeSpec;
    /** The component the ORD reached, as a slot ORD. */
    String component;
    String units;

    Resolution(String status, String reason)
    {
      this.status = status;
      this.reason = reason;
    }

    boolean ok()
    {
      return "ok".equals(status);
    }
  }

  /**
   * Resolves an ORD from a file, from the component {@code base} (a slot ORD) when it is relative.
   * Only local queries are resolved; a view query at the end is ignored.
   */
  Resolution resolve(String text, String base, Context context)
  {
    OrdQuery[] queries;
    try
    {
      queries = BOrd.make(text.trim()).parse();
    }
    catch (Exception e)
    {
      return new Resolution("invalid", "not a valid ORD (" + BaskStreamPx.message(e) + ")");
    }
    List<OrdQuery> kept = new ArrayList<OrdQuery>();
    for (OrdQuery query : queries)
    {
      if ("view".equals(query.getScheme())) break;
      kept.add(query);
    }
    if (kept.isEmpty()) return new Resolution("not_checked", "only a view");
    String first = kept.get(0).getScheme();
    if ("file".equals(first))
    {
      if (kept.size() > 1) return new Resolution("not_checked", "a file ORD with more queries");
      String status = files.status("file:" + kept.get(0).getBody(), context);
      return new Resolution(status, "not_checked".equals(status) ? "outside the station file space (^)" : null);
    }
    if ("module".equals(first)) return moduleFile(kept, context);
    for (OrdQuery query : kept)
    {
      if (!LOCAL_SCHEMES.contains(query.getScheme())) return new Resolution("not_checked", query.getScheme() + ": ORDs are not resolved here");
    }
    boolean relative = isRelative(kept);
    if (relative && base == null) return new Resolution("relative", "resolves from the component the view is on");
    BOrd ord = BOrd.make(kept.toArray(new OrdQuery[kept.size()]));
    if (relative) ord = BOrd.make(BOrd.make(base), ord);
    try
    {
      OrdTarget target = ord.resolve(service, context);
      BObject object = target.get();
      if (object == null) return new Resolution("missing", null);
      BComponent component = target.getComponent();
      String slot = component == null || component.getSlotPath() == null ? null : component.getSlotPath().toString();
      if (slot != null && !BaskStreamAccessPolicy.isAllowed(service, slot)) return new Resolution("forbidden", "outside allowedPathPatterns");
      if (!target.canRead()) return new Resolution("forbidden", "not readable for this user");
      Resolution resolution = new Resolution("ok", null);
      resolution.typeSpec = object.getType().toString();
      resolution.component = slot;
      resolution.units = units(component);
      return resolution;
    }
    catch (javax.baja.security.PermissionException e)
    {
      return new Resolution("forbidden", "not readable for this user");
    }
    catch (javax.baja.naming.UnresolvedException e)
    {
      // Its message is only the path that was not found, which the caller already has.
      return new Resolution("missing", null);
    }
    catch (Exception e)
    {
      return new Resolution("missing", BaskStreamPx.message(e));
    }
  }

  private Resolution moduleFile(List<OrdQuery> queries, Context context)
  {
    String body = queries.get(0).getBody();
    String module = body.startsWith("//") ? body.substring(2) : body;
    int slash = module.indexOf('/');
    if (slash > 0) module = module.substring(0, slash);
    if (!BaskStreamPx.moduleInstalled(module)) return new Resolution("missing", "module " + module + " is not installed");
    try
    {
      Object file = BOrd.make(queries.toArray(new OrdQuery[queries.size()])).resolve(service, context).get();
      return new Resolution(file == null ? "missing" : "ok", null);
    }
    catch (Exception e)
    {
      return new Resolution("missing", BaskStreamPx.message(e));
    }
  }

  /** A slot path without a leading slash resolves from the component a view is attached to. */
  static boolean isRelative(List<OrdQuery> queries)
  {
    OrdQuery first = queries.get(0);
    return "slot".equals(first.getScheme()) && !first.getBody().startsWith("/");
  }

  static boolean isRelative(String text)
  {
    try
    {
      OrdQuery[] queries = BOrd.make(text.trim()).parse();
      return queries.length > 0 && isRelative(Arrays.asList(queries));
    }
    catch (Exception e)
    {
      return false;
    }
  }

  private static String units(BComponent component)
  {
    if (!(component instanceof BControlPoint)) return null;
    try
    {
      BFacets facets = ((BControlPoint) component).getFacets();
      Object units = facets == null ? null : facets.get(BFacets.UNITS);
      return units == null ? null : units.toString();
    }
    catch (RuntimeException e)
    {
      return null;
    }
  }

  /**
   * An absolute ORD under {@code base} written relative to it: station:|slot:/A/VAV_01/points/T
   * with base slot:/A/VAV_01 becomes slot:points/T. Anything else comes back unchanged.
   */
  static String relativeTo(String text, String base)
  {
    if (base == null) return text;
    String slot = BaskStreamAccessPolicy.localSlotOrd(text);
    if (slot == null) return text;
    int bar = slot.indexOf('|');
    String path = bar < 0 ? slot : slot.substring(0, bar);
    String rest = bar < 0 ? "" : slot.substring(bar);
    if (path.equals(base)) return "slot:" + rest;
    if (!path.startsWith(base + "/")) return text;
    return "slot:" + path.substring(base.length() + 1) + rest;
  }

  // ---- check_px_bindings -------------------------------------------------------------------------

  Map<String, Object> checkBindings(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String path = BaskStreamFileResolver.canonical(request.get("path"));
    BaskStreamPx.Doc doc = BaskStreamPx.parse(files.readBytes(path, context));
    if (doc.root == null) throw new BaskStreamProtocolException("px_invalid", path + " could not be read: " + doc.errorSummary(1));
    String base = optionalSlotOrd(request.get("relativeTo"), "relativeTo");
    boolean suggest = Boolean.TRUE.equals(request.get("suggest"));
    boolean cells = Boolean.TRUE.equals(request.get("cells"));
    long deadline = System.currentTimeMillis() + timeout(request);

    // The distinct data references, in the order the file has them.
    Map<String, Binding> byOrd = new LinkedHashMap<String, Binding>();
    for (BaskStreamPx.Ref ref : doc.refs)
    {
      if (!ref.isData()) continue;
      String check = relativeTo(ref.ord, base);
      Binding binding = byOrd.get(check);
      if (binding == null)
      {
        binding = new Binding(byOrd.size(), ref.ord, check, ref.kind, isRelative(check));
        byOrd.put(check, binding);
      }
      binding.widgets.add(ref.widget + (ref.property == null ? "" : " " + ref.property));
    }
    List<Binding> bindings = new ArrayList<Binding>(byOrd.values());
    for (Binding binding : bindings)
    {
      if (!binding.relative) binding.absolute = resolve(binding.check, null, context);
    }

    TargetSelection selection = selectTargets(request, path, context);
    List<TargetResult> results = new ArrayList<TargetResult>();
    boolean truncated = selection.truncated;
    for (Target target : selection.targets)
    {
      if (System.currentTimeMillis() > deadline)
      {
        truncated = true;
        break;
      }
      TargetResult result = new TargetResult(target);
      for (Binding binding : bindings)
      {
        Resolution resolution = binding.relative ? resolve(binding.check, target.ord, context) : binding.absolute;
        result.cells.add(resolution);
        if (!binding.relative) continue;
        if (resolution.ok())
        {
          binding.resolvedOn++;
          binding.countType(resolution.typeSpec);
          binding.example(target.ord, resolution.component);
        }
        else if ("forbidden".equals(resolution.status)) binding.forbiddenOn++;
        else binding.missingOn++;
      }
      results.add(result);
    }

    int relativeCount = 0;
    for (Binding binding : bindings) if (binding.relative) relativeCount++;
    List<Object> targetsWire = new ArrayList<Object>();
    List<Object> deviating = new ArrayList<Object>();
    int okTargets = 0;
    for (TargetResult result : results)
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("ord", result.target.ord);
      wire.put("name", result.target.name);
      List<Object> missing = new ArrayList<Object>();
      List<Object> mismatched = new ArrayList<Object>();
      int resolved = 0;
      Set<String> used = new HashSet<String>();
      for (Resolution cell : result.cells) if (cell.ok() && cell.component != null) used.add(cell.component);
      for (int i = 0; i < bindings.size(); i++)
      {
        Binding binding = bindings.get(i);
        if (!binding.relative) continue;
        Resolution cell = result.cells.get(i);
        if (cell.ok())
        {
          resolved++;
          String expected = binding.expectedType();
          if (expected != null && !expected.equals(cell.typeSpec) && binding.majority() > 0.5)
          {
            mismatched.add(BaskStreamModelPlans.map("binding", Long.valueOf(binding.index), "ord", binding.check,
                "typeSpec", cell.typeSpec, "expected", expected));
          }
          continue;
        }
        Map<String, Object> miss = new LinkedHashMap<String, Object>();
        miss.put("binding", Long.valueOf(binding.index));
        miss.put("ord", binding.check);
        miss.put("status", cell.status);
        if (cell.reason != null) miss.put("reason", cell.reason);
        if (suggest && System.currentTimeMillis() <= deadline)
        {
          miss.put("suggestions", suggestions(result.target, binding, used, context, deadline));
        }
        missing.add(miss);
      }
      wire.put("resolved", Long.valueOf(resolved));
      wire.put("missing", missing);
      wire.put("mismatched", mismatched);
      boolean ok = missing.isEmpty() && mismatched.isEmpty();
      wire.put("ok", Boolean.valueOf(ok));
      if (cells)
      {
        List<Object> statuses = new ArrayList<Object>();
        for (Resolution cell : result.cells) statuses.add(cell.status);
        wire.put("cells", statuses);
      }
      if (ok) okTargets++;
      else deviating.add(result.target.ord);
      targetsWire.add(wire);
    }

    List<Object> bindingsWire = new ArrayList<Object>();
    for (Binding binding : bindings) bindingsWire.add(binding.toWire(results.size()));

    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("targets", Long.valueOf(results.size()));
    summary.put("bindings", Long.valueOf(bindings.size()));
    summary.put("relativeBindings", Long.valueOf(relativeCount));
    summary.put("absoluteBindings", Long.valueOf(bindings.size() - relativeCount));
    int brokenAbsolute = 0;
    for (Binding binding : bindings) if (!binding.relative && !binding.absolute.ok() && !"not_checked".equals(binding.absolute.status)) brokenAbsolute++;
    summary.put("brokenAbsolute", Long.valueOf(brokenAbsolute));
    summary.put("okTargets", Long.valueOf(okTargets));
    summary.put("deviatingTargets", Long.valueOf(results.size() - okTargets));

    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("path", path);
    if (base != null) out.put("relativeTo", base);
    out.put("summary", summary);
    out.put("bindings", bindingsWire);
    out.put("targets", targetsWire);
    out.put("deviating", deviating);
    out.put("targetErrors", selection.errors);
    out.put("truncated", Boolean.valueOf(truncated));
    out.put("pxErrors", Long.valueOf(doc.count("error")));
    if (relativeCount == 0 && base == null)
    {
      out.put("note", "Every binding in " + path + " is absolute, so it is the same on every target. "
          + "To check it as a template, send relativeTo with the component it was drawn for.");
    }
    return out;
  }

  private static final class Binding
  {
    final int index;
    final String ord;
    final String check;
    final String kind;
    final boolean relative;
    final List<String> widgets = new ArrayList<String>();
    Resolution absolute;
    int resolvedOn;
    int missingOn;
    int forbiddenOn;
    final Map<String, Integer> types = new LinkedHashMap<String, Integer>();
    /** Where it resolved, relative to the target: the component's path, e.g. points/Space_Temp. */
    final Map<String, Integer> componentPaths = new LinkedHashMap<String, Integer>();

    Binding(int index, String ord, String check, String kind, boolean relative)
    {
      this.index = index;
      this.ord = ord;
      this.check = check;
      this.kind = kind;
      this.relative = relative;
    }

    void countType(String type)
    {
      if (type == null) return;
      Integer n = types.get(type);
      types.put(type, Integer.valueOf(n == null ? 1 : n.intValue() + 1));
    }

    void example(String target, String component)
    {
      if (component == null || !component.startsWith(target + "/")) return;
      String rel = component.substring(target.length() + 1);
      Integer n = componentPaths.get(rel);
      componentPaths.put(rel, Integer.valueOf(n == null ? 1 : n.intValue() + 1));
    }

    String expectedType()
    {
      return top(types);
    }

    String expectedPath()
    {
      return top(componentPaths);
    }

    double majority()
    {
      String top = top(types);
      return top == null || resolvedOn == 0 ? 0 : types.get(top).intValue() / (double) resolvedOn;
    }

    private static String top(Map<String, Integer> counts)
    {
      String best = null;
      int most = 0;
      for (Map.Entry<String, Integer> entry : counts.entrySet())
      {
        if (entry.getValue().intValue() > most)
        {
          most = entry.getValue().intValue();
          best = entry.getKey();
        }
      }
      return best;
    }

    Map<String, Object> toWire(int targets)
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("index", Long.valueOf(index));
      wire.put("ord", ord);
      if (!check.equals(ord)) wire.put("checked", check);
      wire.put("kind", kind);
      wire.put("relative", Boolean.valueOf(relative));
      wire.put("widgets", new ArrayList<Object>(widgets.subList(0, Math.min(5, widgets.size()))));
      wire.put("widgetCount", Long.valueOf(widgets.size()));
      if (relative)
      {
        wire.put("resolvedOn", Long.valueOf(resolvedOn));
        wire.put("missingOn", Long.valueOf(missingOn));
        wire.put("forbiddenOn", Long.valueOf(forbiddenOn));
        Map<String, Object> typeCounts = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Integer> type : types.entrySet()) typeCounts.put(type.getKey(), Long.valueOf(type.getValue().intValue()));
        wire.put("types", typeCounts);
      }
      else
      {
        wire.put("status", absolute.status);
        if (absolute.reason != null) wire.put("reason", absolute.reason);
        if (absolute.typeSpec != null) wire.put("typeSpec", absolute.typeSpec);
      }
      return wire;
    }
  }

  private static final class TargetResult
  {
    final Target target;
    final List<Resolution> cells = new ArrayList<Resolution>();

    TargetResult(Target target)
    {
      this.target = target;
    }
  }

  // ---- Mapping suggestions -----------------------------------------------------------------------

  /**
   * Points under the target that could be the one a binding wanted, best first: by name (after
   * common BAS abbreviations), type, units and place, compared with where the binding resolved on
   * the other targets. These are for a person or an agent to review; nothing is changed.
   */
  private List<Object> suggestions(Target target, Binding binding, Set<String> used, Context context, long deadline)
  {
    String wantPath = binding.expectedPath();
    String tail = "";
    if (wantPath == null)
    {
      // It resolved nowhere: guess the component from the ORD itself.
      String slot = binding.check.startsWith("slot:") ? binding.check.substring(5) : binding.check;
      int bar = slot.indexOf('|');
      if (bar >= 0) slot = slot.substring(0, bar);
      wantPath = slot;
    }
    else
    {
      String slot = binding.check.substring(5);
      int bar = slot.indexOf('|');
      String body = bar < 0 ? slot : slot.substring(0, bar);
      if (body.startsWith(wantPath)) tail = body.substring(wantPath.length());
      if (bar >= 0) tail = tail + slot.substring(bar);
    }
    String wantName = SlotPath.unescape(lastName(wantPath));
    String wantParent = parentOf(wantPath);
    String wantType = binding.expectedType();
    List<String> wantTokens = tokens(wantName);

    List<Object[]> scored = new ArrayList<Object[]>();
    List<BComponent> stack = new ArrayList<BComponent>();
    stack.add(target.component);
    int visited = 0;
    while (!stack.isEmpty() && visited < 3000 && System.currentTimeMillis() <= deadline)
    {
      BComponent current = stack.remove(stack.size() - 1);
      visited++;
      BComponent[] kids;
      try
      {
        kids = current.getChildComponents();
      }
      catch (RuntimeException e)
      {
        continue;
      }
      for (BComponent kid : kids)
      {
        if (!readable(kid, context)) continue;
        String slot = kid.getSlotPath() == null ? null : kid.getSlotPath().toString();
        if (slot == null || !slot.startsWith(target.ord + "/")) continue;
        String rel = slot.substring(target.ord.length() + 1);
        if (rel.split("/").length < 7) stack.add(kid);
        double name = nameScore(wantTokens, wantName, tokens(SlotPath.unescape(kid.getName())), SlotPath.unescape(kid.getName()));
        if (name < 0.25) continue;
        String type = kid.getType().toString();
        String units = units(kid);
        double typeScore = wantType == null ? 0.5 : type.equals(wantType) ? 1 : family(type).equals(family(wantType)) ? 0.6 : 0;
        double place = parentOf(rel).equals(wantParent) ? 1 : 0.4;
        double score = 0.6 * name + 0.25 * typeScore + 0.15 * place;
        List<String> why = new ArrayList<String>();
        why.add("name " + round(name));
        if (wantType != null) why.add(type.equals(wantType) ? "same type" : typeScore > 0 ? "similar type " + type : "different type " + type);
        if (units != null) why.add("units " + units);
        if (used.contains(slot))
        {
          score *= 0.7;
          why.add("already used by another binding here");
        }
        if (score < 0.35) continue;
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        wire.put("ord", slot);
        wire.put("relative", "slot:" + rel + tail);
        wire.put("name", kid.getDisplayName(context));
        wire.put("typeSpec", type);
        if (units != null) wire.put("units", units);
        wire.put("score", Double.valueOf(round(score)));
        wire.put("why", why);
        scored.add(new Object[] { Double.valueOf(score), wire });
      }
    }
    Collections.sort(scored, (a, b) -> Double.compare((Double) b[0], (Double) a[0]));
    List<Object> out = new ArrayList<Object>();
    for (int i = 0; i < scored.size() && i < SUGGESTIONS; i++) out.add(scored.get(i)[1]);
    return out;
  }

  private static String family(String typeSpec)
  {
    String lower = typeSpec.toLowerCase(Locale.ROOT);
    for (String kind : new String[] { "numeric", "boolean", "enum", "string" })
    {
      if (lower.contains(kind)) return kind;
    }
    return lower;
  }

  private static String lastName(String path)
  {
    int slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  private static String parentOf(String path)
  {
    int slash = path.lastIndexOf('/');
    return slash < 0 ? "" : path.substring(0, slash);
  }

  private static double round(double value)
  {
    return Math.round(value * 100) / 100.0;
  }

  /** Words BAS point names abbreviate, each with the word it is compared as. */
  private static final Map<String, String[]> SYNONYMS = new HashMap<String, String[]>();
  static
  {
    String[][] table = {
        { "temp", "temperature", "tmp", "tem", "t" }, { "setpoint", "sp", "stpt", "spt", "setpt", "set" },
        { "space", "zone", "zn", "room", "rm", "spc", "zon" }, { "occupied", "occ", "occupancy" },
        { "unoccupied", "unocc", "unocupied" }, { "command", "cmd", "cmnd" }, { "status", "sts", "stat", "stts" },
        { "position", "pos", "posn" }, { "damper", "dmpr", "dpr", "dmp" }, { "flow", "cfm", "airflow" },
        { "heat", "htg", "heating", "ht" }, { "cool", "clg", "cooling", "cl" }, { "supply", "sup", "sply", "discharge", "dis", "dsch" },
        { "return", "ret", "rtn" }, { "outside", "oa", "outdoor", "osa", "out" }, { "mixed", "mix", "mxd" }, { "exhaust", "exh", "ea" },
        { "speed", "spd" }, { "valve", "vlv", "vlve" }, { "humidity", "hum", "rh", "humid" }, { "pressure", "press", "pres", "prs" },
        { "fan", "fn" }, { "effective", "eff", "effect" }, { "alarm", "alm", "alrm" }, { "enable", "en", "enab", "ena" },
        { "minimum", "min" }, { "maximum", "max" }, { "co2", "carbondioxide" }, { "static", "stat_pressure" },
        { "filter", "filt", "flt" }, { "pump", "pmp" }, { "chilled", "chw", "chill" }, { "water", "wtr", "h2o" },
        { "reheat", "rht", "rh_valve" }, { "actual", "act" }, { "differential", "diff", "dp" } };
    for (String[] row : table)
    {
      for (String word : row) SYNONYMS.put(word, new String[] { row[0] });
    }
    // Abbreviations that stand for more than one word.
    SYNONYMS.put("sat", new String[] { "supply", "air", "temp" });
    SYNONYMS.put("dat", new String[] { "supply", "air", "temp" });
    SYNONYMS.put("rat", new String[] { "return", "air", "temp" });
    SYNONYMS.put("mat", new String[] { "mixed", "air", "temp" });
    SYNONYMS.put("oat", new String[] { "outside", "air", "temp" });
    SYNONYMS.put("sa", new String[] { "supply", "air" });
    SYNONYMS.put("da", new String[] { "supply", "air" });
    SYNONYMS.put("ra", new String[] { "return", "air" });
    SYNONYMS.put("ma", new String[] { "mixed", "air" });
    SYNONYMS.put("zt", new String[] { "space", "temp" });
    SYNONYMS.put("st", new String[] { "space", "temp" });
    SYNONYMS.put("rmt", new String[] { "space", "temp" });
    SYNONYMS.put("znt", new String[] { "space", "temp" });
  }

  private static final Pattern WORDS = Pattern.compile("[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])");

  static List<String> tokens(String name)
  {
    List<String> out = new ArrayList<String>();
    for (String word : WORDS.split(name))
    {
      if (word.length() == 0) continue;
      String lower = word.toLowerCase(Locale.ROOT);
      String[] mapped = SYNONYMS.get(lower);
      if (mapped == null) out.add(lower);
      else out.addAll(Arrays.asList(mapped));
    }
    return out;
  }

  /** 0..1: shared words (Dice) blended with how close the spelled-out names are. */
  static double nameScore(List<String> a, String rawA, List<String> b, String rawB)
  {
    if (a.isEmpty() || b.isEmpty()) return 0;
    List<String> rest = new ArrayList<String>(b);
    int shared = 0;
    for (String word : a)
    {
      if (rest.remove(word)) shared++;
    }
    double dice = 2.0 * shared / (a.size() + b.size());
    String joinedA = String.join("", a);
    String joinedB = String.join("", b);
    int longest = Math.max(joinedA.length(), joinedB.length());
    double spelled = longest == 0 ? 0 : 1 - levenshtein(joinedA, joinedB) / (double) longest;
    // Digits must agree: VAV_2 is not VAV_12, and Fan1 is not Fan2.
    if (!digits(rawA).equals(digits(rawB))) return 0.5 * (0.6 * dice + 0.4 * spelled);
    return 0.6 * dice + 0.4 * spelled;
  }

  private static String digits(String text)
  {
    return text.replaceAll("[^0-9]+", " ").trim();
  }

  private static int levenshtein(String a, String b)
  {
    int[] previous = new int[b.length() + 1];
    int[] current = new int[b.length() + 1];
    for (int j = 0; j <= b.length(); j++) previous[j] = j;
    for (int i = 1; i <= a.length(); i++)
    {
      current[0] = i;
      for (int j = 1; j <= b.length(); j++)
      {
        int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
        current[j] = Math.min(Math.min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
      }
      int[] swap = previous;
      previous = current;
      current = swap;
    }
    return previous[b.length()];
  }

  // ---- Choosing components -----------------------------------------------------------------------

  static final class Target
  {
    final String ord;
    final String name;
    final BComponent component;

    Target(String ord, String name, BComponent component)
    {
      this.ord = ord;
      this.name = name;
      this.component = component;
    }
  }

  private static final class TargetSelection
  {
    final List<Target> targets = new ArrayList<Target>();
    final List<Object> errors = new ArrayList<Object>();
    boolean truncated;
  }

  /**
   * The components a request names: a list of ORDs ("targets"), every component matching a
   * pattern ("match": under, name wildcard, type, depth), or every component that has a view of
   * this Px ("views": true, searched under match.under or the whole station).
   */
  private TargetSelection selectTargets(Map<String, Object> request, String pxPath, Context context) throws BaskStreamProtocolException
  {
    TargetSelection selection = new TargetSelection();
    Object list = request.get("targets");
    Object match = request.get("match");
    boolean views = Boolean.TRUE.equals(request.get("views"));
    if (list == null && match == null && !views)
    {
      throw new BaskStreamProtocolException("bad_request", "Say which components: 'targets' (slot ORDs), 'match' {under, name, type} or views: true.");
    }
    Set<String> seen = new HashSet<String>();
    if (list != null)
    {
      if (!(list instanceof List)) throw new BaskStreamProtocolException("bad_request", "Field 'targets' must be a list of slot ORDs.");
      for (Object item : (List<?>) list)
      {
        if (selection.targets.size() >= MAX_TARGETS)
        {
          selection.truncated = true;
          break;
        }
        String ord = item instanceof String ? BaskStreamAccessPolicy.localSlotOrd(((String) item).trim()) : null;
        if (ord == null)
        {
          selection.errors.add(BaskStreamModelPlans.map("ord", String.valueOf(item), "code", "invalid_point", "message", "Not a slot ORD on this station."));
          continue;
        }
        try
        {
          BComponent component = component(ord, context);
          String slot = component.getSlotPath().toString();
          if (seen.add(slot)) selection.targets.add(new Target(slot, component.getDisplayName(context), component));
        }
        catch (BaskStreamProtocolException e)
        {
          selection.errors.add(BaskStreamModelPlans.map("ord", ord, "code", e.getCode(), "message", e.getMessage()));
        }
      }
    }
    if (match != null || views)
    {
      if (match != null && !(match instanceof Map)) throw new BaskStreamProtocolException("bad_request", "Field 'match' must be an object: {under, name, type, depth}.");
      Map<String, Object> pattern = match == null ? new HashMap<String, Object>() : castMap(match);
      String under = optionalSlotOrd(pattern.get("under"), "match.under");
      BComponent root = component(under == null ? "slot:/" : under, context);
      Object nameValue = pattern.get("name");
      Pattern name = nameValue == null ? null : Pattern.compile(BaskStreamAccessPolicy.toRegex(String.valueOf(nameValue)), Pattern.CASE_INSENSITIVE);
      Type type = null;
      if (pattern.get("type") != null)
      {
        try
        {
          type = Sys.getType(String.valueOf(pattern.get("type")));
        }
        catch (Exception e)
        {
          throw new BaskStreamProtocolException("bad_request", "match.type " + pattern.get("type") + " is not a type on this station.");
        }
      }
      int depth = BaskStreamWire.integer(pattern, "depth", 12, 1, 32);
      String pxOrd = "file:" + pxPath;
      long deadline = System.currentTimeMillis() + timeout(request);
      java.util.ArrayDeque<Object[]> queue = new java.util.ArrayDeque<Object[]>();
      queue.add(new Object[] { root, Integer.valueOf(0) });
      int visited = 0;
      while (!queue.isEmpty())
      {
        if (selection.targets.size() >= MAX_TARGETS || visited >= MAX_COMPONENTS || System.currentTimeMillis() > deadline)
        {
          selection.truncated = true;
          break;
        }
        Object[] next = queue.poll();
        BComponent current = (BComponent) next[0];
        int level = ((Integer) next[1]).intValue();
        visited++;
        if (current != root || under != null)
        {
          boolean hit = (name == null || name.matcher(SlotPath.unescape(current.getName() == null ? "" : current.getName())).matches()
              || name.matcher(current.getDisplayName(context)).matches())
              && (type == null || current.getType().is(type))
              && (!views || hasView(current, pxOrd));
          String slot = current.getSlotPath() == null ? null : current.getSlotPath().toString();
          if (hit && slot != null && seen.add(slot)) selection.targets.add(new Target(slot, current.getDisplayName(context), current));
        }
        if (level >= depth) continue;
        for (BComponent kid : current.getChildComponents())
        {
          if (readable(kid, context)) queue.add(new Object[] { kid, Integer.valueOf(level + 1) });
        }
      }
    }
    return selection;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> castMap(Object value)
  {
    return (Map<String, Object>) value;
  }

  private static boolean hasView(BComponent component, String pxOrd)
  {
    for (Property property : component.getDynamicPropertiesArray())
    {
      BValue value = component.get(property);
      if (value instanceof BPxView && pxOrd.equals(normalizeFileOrd(((BPxView) value).getPxFile())))
        return true;
    }
    return false;
  }

  static String normalizeFileOrd(BOrd ord)
  {
    if (ord == null || ord.isNull()) return null;
    String text = ord.toString().trim();
    if (text.startsWith("local:|")) text = text.substring(7);
    if (text.startsWith("module:")) return text;
    return text.startsWith("file:") ? text : "file:" + text;
  }

  /** A component the user can read, inside allowedPathPatterns, by its slot ORD. */
  private BComponent component(String slotOrd, Context context) throws BaskStreamProtocolException
  {
    String ord = BaskStreamAccessPolicy.localSlotOrd(slotOrd);
    if (ord == null) throw new BaskStreamProtocolException("invalid_point", "Not a slot ORD on this station: " + slotOrd);
    if (!"slot:/".equals(ord) && !BaskStreamAccessPolicy.isAllowed(service, ord))
      throw new BaskStreamProtocolException("forbidden_point", ord + " is outside the allowedPathPatterns policy.");
    OrdTarget target;
    try
    {
      target = BOrd.make(ord).resolve(service, context);
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("invalid_point", "No such component: " + ord);
    }
    if (!target.canRead()) throw new BaskStreamProtocolException("forbidden_point", ord + " is not readable for the authenticated user.");
    BObject object = target.get();
    if (!(object instanceof BComponent)) throw new BaskStreamProtocolException("invalid_point", ord + " is not a component.");
    return (BComponent) object;
  }

  private boolean readable(BComponent component, Context context)
  {
    try
    {
      String slot = component.getSlotPath() == null ? null : component.getSlotPath().toString();
      return slot != null && BaskStreamAccessPolicy.isAllowed(service, slot) && component.getPermissions(context).hasOperatorRead();
    }
    catch (RuntimeException e)
    {
      return false;
    }
  }

  private static String optionalSlotOrd(Object value, String field) throws BaskStreamProtocolException
  {
    if (value == null) return null;
    if (!(value instanceof String)) throw new BaskStreamProtocolException("bad_request", "Field '" + field + "' must be a slot ORD.");
    String ord = BaskStreamAccessPolicy.localSlotOrd(((String) value).trim());
    if (ord == null) throw new BaskStreamProtocolException("bad_request", "Field '" + field + "' must be a slot ORD on this station, e.g. slot:/Drivers.");
    while (ord.length() > 6 && ord.endsWith("/")) ord = ord.substring(0, ord.length() - 1);
    return ord;
  }

  private static int timeout(Map<String, Object> request) throws BaskStreamProtocolException
  {
    return BaskStreamWire.integer(request, "timeoutMillis", DEFAULT_TIMEOUT_MILLIS, 1000, MAX_TIMEOUT_MILLIS);
  }

  // ---- attach_px_view ----------------------------------------------------------------------------

  /**
   * Adds a Px view to each component (or repoints the view of that name), optionally makes it the
   * default view (the first Px view on the component), or removes it. Each change needs admin write
   * on the component, as Workbench requires, and is recorded in the station's audit history.
   */
  Map<String, Object> attachViews(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    String path = BaskStreamFileResolver.canonical(request.get("path"));
    String pxOrd = "file:" + path;
    boolean remove = Boolean.TRUE.equals(request.get("remove"));
    boolean makeDefault = !remove && !Boolean.FALSE.equals(request.get("default"));
    boolean dryRun = Boolean.TRUE.equals(request.get("dryRun"));
    Object viewValue = request.get("view");
    if (viewValue != null && !(viewValue instanceof String)) throw new BaskStreamProtocolException("bad_request", "Field 'view' must be a string.");
    String viewName = viewValue == null ? null : SlotPath.escape(((String) viewValue).trim());
    if (viewName != null && viewName.length() == 0) viewName = null;
    String media = null;
    if (!remove)
    {
      // Only a Px that is there and reads cleanly is attached.
      BaskStreamPx.Doc doc = BaskStreamPx.parse(files.readBytes(path, context));
      if (doc.root == null) throw new BaskStreamProtocolException("px_invalid", path + " could not be read: " + doc.errorSummary(1));
      media = doc.media;
    }
    String name = viewName != null ? viewName : SlotPath.escape(baseName(path));

    TargetSelection selection = selectTargets(request, path, context);
    List<Object> results = new ArrayList<Object>(selection.errors.size() + selection.targets.size());
    for (Object error : selection.errors)
    {
      Map<String, Object> failed = new LinkedHashMap<String, Object>(castMap(error));
      failed.put("action", "failed");
      results.add(failed);
    }
    Map<String, Integer> counts = new LinkedHashMap<String, Integer>();
    for (Target target : selection.targets)
    {
      Map<String, Object> result = new LinkedHashMap<String, Object>();
      result.put("ord", target.ord);
      try
      {
        requireAdminWrite(target.ord, context);
        if (remove) removeView(target.component, pxOrd, viewName, dryRun, context, result);
        else addView(target.component, pxOrd, name, viewName != null, media, makeDefault, dryRun, context, result);
      }
      catch (BaskStreamProtocolException e)
      {
        result.put("action", "failed");
        result.put("code", e.getCode());
        result.put("message", e.getMessage());
      }
      catch (RuntimeException e)
      {
        result.put("action", "failed");
        result.put("code", "view_conflict");
        result.put("message", BaskStreamPx.message(e));
      }
      String action = String.valueOf(result.get("action"));
      Integer n = counts.get(action);
      counts.put(action, Integer.valueOf(n == null ? 1 : n.intValue() + 1));
      results.add(result);
    }
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    for (Map.Entry<String, Integer> count : counts.entrySet()) summary.put(count.getKey(), Long.valueOf(count.getValue().intValue()));
    if (!selection.errors.isEmpty()) summary.put("failed", Long.valueOf(selection.errors.size() + (counts.containsKey("failed") ? counts.get("failed").intValue() : 0)));

    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("path", path);
    out.put("view", remove && viewName == null ? null : name);
    out.put("remove", Boolean.valueOf(remove));
    out.put("default", Boolean.valueOf(makeDefault));
    if (dryRun) out.put("dryRun", Boolean.TRUE);
    out.put("summary", summary);
    out.put("results", results);
    out.put("truncated", Boolean.valueOf(selection.truncated));
    return out;
  }

  private void addView(BComponent component, String pxOrd, String name, boolean named, String media, boolean makeDefault,
      boolean dryRun, Context context, Map<String, Object> result) throws BaskStreamProtocolException
  {
    Property existing = component.getProperty(name);
    Property sameFile = null;
    for (Property property : component.getDynamicPropertiesArray())
    {
      BValue value = component.get(property);
      if (value instanceof BPxView && pxOrd.equals(normalizeFileOrd(((BPxView) value).getPxFile())))
      {
        sameFile = property;
        break;
      }
    }
    String action;
    Property target;
    if (existing != null && !(component.get(existing) instanceof BPxView))
    {
      result.put("action", "conflict");
      result.put("code", "view_conflict");
      result.put("message", component.getSlotPath() + " already has a slot named " + name + " that is not a Px view (" + component.get(existing).getType() + ").");
      return;
    }
    else if (existing != null)
    {
      target = existing;
      action = pxOrd.equals(normalizeFileOrd(((BPxView) component.get(existing)).getPxFile())) ? "unchanged" : "updated";
    }
    else if (sameFile != null && !named)
    {
      target = sameFile;
      action = "unchanged";
    }
    else
    {
      target = null;
      action = "added";
    }
    result.put("view", target == null ? name : target.getName());
    boolean isDefault = target != null && firstPxView(component) == target;
    boolean setDefault = makeDefault && !isDefault;
    result.put("action", action);
    result.put("default", Boolean.valueOf(makeDefault || isDefault));
    if (setDefault && !"added".equals(action)) result.put("defaultSet", Boolean.TRUE);
    if (dryRun || ("unchanged".equals(action) && !setDefault)) return;

    service.requireWritesEnabled();
    if ("added".equals(action))
    {
      BPxView view = new BPxView(BOrd.make(pxOrd));
      if (media != null && BaskStreamPx.typeInfo(media) != null) view.setMedia(BTypeSpec.make(media));
      target = component.add(name, view, 0, context);
    }
    else if ("updated".equals(action))
    {
      BPxView view = (BPxView) component.get(target);
      view.set(BPxView.pxFile, BOrd.make(pxOrd), context);
    }
    if (setDefault)
    {
      component.reorderToTop(target, context);
    }
    // Niagara records the slot change itself, in the user's name, as it does for Workbench.
    if (service.auditsGraphics()) service.audit("px_view_" + action, "user=" + user(context) + " component=" + component.getSlotPath() + " view=" + target.getName()
        + " px=" + pxOrd + (setDefault ? " default" : ""));
  }

  private void removeView(BComponent component, String pxOrd, String viewName, boolean dryRun, Context context,
      Map<String, Object> result) throws BaskStreamProtocolException
  {
    List<Property> doomed = new ArrayList<Property>();
    for (Property property : component.getDynamicPropertiesArray())
    {
      BValue value = component.get(property);
      if (!(value instanceof BPxView)) continue;
      boolean nameMatches = viewName == null || viewName.equals(property.getName());
      if (nameMatches && pxOrd.equals(normalizeFileOrd(((BPxView) value).getPxFile()))) doomed.add(property);
    }
    List<Object> names = new ArrayList<Object>();
    for (Property property : doomed) names.add(property.getName());
    result.put("action", doomed.isEmpty() ? "unchanged" : "removed");
    result.put("views", names);
    if (dryRun || doomed.isEmpty()) return;
    service.requireWritesEnabled();
    for (Property property : doomed)
    {
      component.remove(property, context);
    }
    if (service.auditsGraphics()) service.audit("px_view_removed", "user=" + user(context) + " component=" + component.getSlotPath() + " views=" + names + " px=" + pxOrd);
  }

  private static Property firstPxView(BComponent component)
  {
    for (Property property : component.getDynamicPropertiesArray())
    {
      if (component.get(property) instanceof BPxView) return property;
    }
    return null;
  }

  private void requireAdminWrite(String ord, Context context) throws BaskStreamProtocolException
  {
    boolean adminWrite;
    try
    {
      OrdTarget target = BOrd.make(ord).resolve(service, context);
      BPermissions permissions = target.getPermissionsForTarget();
      adminWrite = target.canWrite() && permissions != null && permissions.hasAdminWrite();
    }
    catch (Exception e)
    {
      adminWrite = false;
    }
    if (!adminWrite)
    {
      throw new BaskStreamProtocolException("forbidden_point", "Attaching views needs admin write on " + ord + ", as in Workbench.");
    }
  }

  private static String baseName(String path)
  {
    String name = path.substring(path.lastIndexOf('/') + 1);
    if (name.startsWith("^")) name = name.substring(1);
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  private static String user(Context context)
  {
    return context == null || context.getUser() == null ? null : context.getUser().getUsername();
  }

  // ---- check_nav ---------------------------------------------------------------------------------

  Map<String, Object> checkNav(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    Object text = request.get("text");
    if (text != null && !(text instanceof String)) throw new BaskStreamProtocolException("bad_request", "Field 'text' must be a string.");
    String path = request.get("path") == null ? null : BaskStreamFileResolver.canonical(request.get("path"));
    if (text == null && path == null) throw new BaskStreamProtocolException("bad_request", "Send 'path' (a nav file on the station) or 'text'.");
    byte[] bytes = text != null ? ((String) text).getBytes(StandardCharsets.UTF_8) : files.readBytes(path, context);
    Nav nav = parseNav(bytes);
    List<Object> nodes = new ArrayList<Object>();
    int dead = 0;
    for (NavNode node : nav.nodes)
    {
      Map<String, Object> wire = node.toWire();
      if (node.ord == null)
      {
        wire.put("status", "folder");
      }
      else
      {
        Resolution resolution = resolve(node.ord, null, context);
        wire.put("status", resolution.status);
        if (resolution.reason != null) wire.put("reason", resolution.reason);
        if (!resolution.ok() && !"not_checked".equals(resolution.status)) dead++;
      }
      nodes.add(wire);
    }
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    if (path != null) out.put("path", path);
    out.put("nodes", nodes);
    out.put("dead", Long.valueOf(dead));
    out.put("problems", nav.problems);
    out.put("valid", Boolean.valueOf(nav.valid));
    if (path != null)
    {
      List<Object> assigned = new ArrayList<Object>();
      for (Map<String, Object> user : users(context))
      {
        if (("file:" + path).equals(user.get("navFile"))) assigned.add(user.get("user"));
      }
      out.put("users", assigned);
    }
    return out;
  }

  private static final class NavNode
  {
    final String path;
    final String name;
    final String ord;
    final String icon;
    final int depth;
    final int line;

    NavNode(String path, String name, String ord, String icon, int depth, int line)
    {
      this.path = path;
      this.name = name;
      this.ord = ord;
      this.icon = icon;
      this.depth = depth;
      this.line = line;
    }

    Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("path", path);
      wire.put("name", name);
      wire.put("ord", ord);
      if (icon != null) wire.put("icon", icon);
      wire.put("depth", Long.valueOf(depth));
      wire.put("line", Long.valueOf(line));
      return wire;
    }
  }

  private static final class Nav
  {
    final List<NavNode> nodes = new ArrayList<NavNode>();
    final List<Object> problems = new ArrayList<Object>();
    boolean valid = true;
  }

  /** A nav file: {@code <nav version="1.0">} holding nested {@code <node name ord icon>} elements. */
  private static Nav parseNav(byte[] bytes)
  {
    Nav nav = new Nav();
    XElem root;
    try
    {
      root = XParser.make(new java.io.ByteArrayInputStream(bytes)).parse();
    }
    catch (Exception e)
    {
      nav.valid = false;
      nav.problems.add(new BaskStreamPx.Problem("error", "xml_invalid", "Not well-formed XML: " + BaskStreamPx.message(e), 0).toWire());
      return nav;
    }
    if (!"nav".equals(root.qname()))
    {
      nav.valid = false;
      nav.problems.add(new BaskStreamPx.Problem("error", "not_nav", "The root element is <" + root.qname() + ">, not <nav>.", root.line()).toWire());
      return nav;
    }
    walkNav(nav, root, "", 0);
    return nav;
  }

  private static void walkNav(Nav nav, XElem parent, String path, int depth)
  {
    for (XElem elem : parent.elems())
    {
      if (nav.nodes.size() >= MAX_FILES || depth > 32) return;
      if (!"node".equals(elem.qname()))
      {
        nav.problems.add(new BaskStreamPx.Problem("warning", "unknown_element", "<" + elem.qname() + "> is not a nav <node>; Niagara ignores it.", elem.line()).toWire());
        continue;
      }
      String name = elem.get("name", null);
      if (name == null || name.trim().length() == 0)
      {
        nav.valid = false;
        nav.problems.add(new BaskStreamPx.Problem("error", "node_name_missing", "A <node> has no name.", elem.line()).toWire());
        name = "?";
      }
      String ord = elem.get("ord", null);
      if (ord != null && (ord.trim().length() == 0 || "null".equals(ord.trim()))) ord = null;
      String nodePath = path.length() == 0 ? name : path + "/" + name;
      nav.nodes.add(new NavNode(nodePath, name, ord == null ? null : ord.trim(), elem.get("icon", null), depth, elem.line()));
      walkNav(nav, elem, nodePath, depth + 1);
    }
  }

  /** Users this session may see, with the nav file each one gets. */
  private List<Map<String, Object>> users(Context context)
  {
    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
    try
    {
      BUserService users = (BUserService) Sys.getService(BUserService.TYPE);
      for (BUser user : users.getChildren(BUser.class))
      {
        BPermissions permissions = user.getPermissions(context);
        if (permissions == null || !(permissions.hasOperatorRead() || permissions.hasAdminRead())) continue;
        BOrd nav = user.getNavFile();
        out.add(BaskStreamModelPlans.map("user", user.getUsername(), "navFile", normalizeFileOrd(nav)));
      }
    }
    catch (Exception e)
    {
      // No user service, or none this user may see: no assignments to report.
    }
    return out;
  }

  // ---- graphics_inventory ------------------------------------------------------------------------

  /**
   * Every Px and nav file in the station file space, every Px view on a component under 'under', and
   * what links them, with a punch list: views and links to files that are not there, nav nodes that
   * do not resolve, Px files nothing uses, Px files with errors, components missing a view their
   * siblings have, and (with checkBindings) bindings that do not resolve on the component a view is on.
   */
  Map<String, Object> inventory(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    long deadline = System.currentTimeMillis() + timeout(request);
    boolean checkBindings = Boolean.TRUE.equals(request.get("checkBindings"));
    int maxComponents = BaskStreamWire.integer(request, "maxComponents", DEFAULT_MAX_COMPONENTS, 1, MAX_COMPONENTS);
    String under = optionalSlotOrd(request.get("under"), "under");
    boolean truncated = false;
    Punch punch = new Punch();

    // Files.
    Set<String> skip = new HashSet<String>(Collections.singletonList(BaskStreamFileResolver.BACKUP_ROOT));
    boolean[] fileCap = new boolean[1];
    Set<String> wanted = new HashSet<String>(IMAGE_EXTENSIONS);
    wanted.add("px");
    wanted.add("nav");
    List<Map<String, Object>> found = files.scan("^", wanted, MAX_FILES, skip, context, fileCap);
    truncated |= fileCap[0];
    Map<String, PxFile> pxFiles = new LinkedHashMap<String, PxFile>();
    List<String> navPaths = new ArrayList<String>();
    List<String> images = new ArrayList<String>();
    for (Map<String, Object> entry : found)
    {
      String path = (String) entry.get("path");
      String lower = path.toLowerCase(Locale.ROOT);
      if (lower.endsWith(".px")) pxFiles.put("file:" + path, new PxFile(path, entry));
      else if (lower.endsWith(".nav")) navPaths.add(path);
      else images.add(path);
    }
    Set<String> referencedFiles = new HashSet<String>();
    int parsed = 0;
    for (PxFile px : pxFiles.values())
    {
      if (parsed >= MAX_PX_FILES || System.currentTimeMillis() > deadline)
      {
        truncated = true;
        break;
      }
      parsed++;
      try
      {
        px.doc = BaskStreamPx.parse(files.readBytes(px.path, context));
      }
      catch (BaskStreamProtocolException e)
      {
        punch.add("warning", "px_unreadable", px.path, null, e.getMessage());
        continue;
      }
      if (!px.doc.valid())
      {
        punch.add("error", "px_invalid", px.path, null, px.doc.count("error") + " error(s): " + px.doc.errorSummary(3));
      }
    }

    // Links between files.
    Map<String, Resolution> resolved = new HashMap<String, Resolution>();
    for (PxFile px : pxFiles.values())
    {
      if (px.doc == null) continue;
      for (BaskStreamPx.Ref ref : px.doc.refs)
      {
        if ("view".equals(ref.kind)) continue;
        String fileOrd = fileOrdOf(ref.ord);
        if (fileOrd != null) referencedFiles.add(fileOrd);
        if (fileOrd != null && pxFiles.containsKey(fileOrd))
        {
          // A link to another Px can sit in a hyperlink or in an ORD property (a web widget's linkOrd).
          if ("include".equals(ref.kind)) pxFiles.get(fileOrd).includedBy.add(px.path);
          else pxFiles.get(fileOrd).linkedFrom.add(px.path);
          if ("include".equals(ref.kind)) px.includes.add(fileOrd.substring(5));
        }
        if (ref.isData()) continue;
        Resolution resolution = cached(resolved, ref.ord, context);
        if (!resolution.ok() && !"not_checked".equals(resolution.status) && !"relative".equals(resolution.status))
        {
          punch.add("include".equals(ref.kind) ? "error" : "warning", "include".equals(ref.kind) ? "dead_include" : "dead_link",
              px.path, ref.ord, describeRef(ref) + " on " + ref.widget + " (line " + ref.line + ") " + describeStatus(resolution) + ".");
        }
      }
    }

    // Nav files and who uses them.
    List<Map<String, Object>> users = users(context);
    List<Object> navWire = new ArrayList<Object>();
    for (String navPath : navPaths)
    {
      Nav nav;
      try
      {
        nav = parseNav(files.readBytes(navPath, context));
      }
      catch (BaskStreamProtocolException e)
      {
        punch.add("warning", "nav_unreadable", navPath, null, e.getMessage());
        continue;
      }
      int dead = 0;
      for (NavNode node : nav.nodes)
      {
        if (node.ord == null) continue;
        String fileOrd = fileOrdOf(node.ord);
        if (fileOrd != null)
        {
          referencedFiles.add(fileOrd);
          if (pxFiles.containsKey(fileOrd)) pxFiles.get(fileOrd).linkedFrom.add(navPath);
        }
        if (node.icon != null && fileOrdOf(node.icon) != null) referencedFiles.add(fileOrdOf(node.icon));
        Resolution resolution = cached(resolved, node.ord, context);
        if (!resolution.ok() && !"not_checked".equals(resolution.status))
        {
          dead++;
          punch.add("error", "nav_dead", navPath, node.ord, "Nav node " + node.path + " (line " + node.line + ") " + describeStatus(resolution) + ".");
        }
      }
      if (!nav.valid) punch.add("error", "nav_invalid", navPath, null, "The nav file has errors; check_nav lists them.");
      List<Object> assigned = new ArrayList<Object>();
      for (Map<String, Object> user : users) if (("file:" + navPath).equals(user.get("navFile"))) assigned.add(user.get("user"));
      navWire.add(BaskStreamModelPlans.map("path", navPath, "nodes", Long.valueOf(nav.nodes.size()), "dead", Long.valueOf(dead), "users", assigned));
    }
    for (Map<String, Object> user : users)
    {
      Object navFile = user.get("navFile");
      if (navFile == null) continue;
      String status = files.status(String.valueOf(navFile), context);
      if ("missing".equals(status)) punch.add("warning", "user_nav_missing", "user " + user.get("user"), String.valueOf(navFile), "User " + user.get("user") + "'s nav file is not there.");
    }

    // Views on components.
    List<View> views = new ArrayList<View>();
    Map<String, List<Sibling>> byParent = new HashMap<String, List<Sibling>>();
    BComponent root = component(under == null ? "slot:/" : under, context);
    List<BComponent> stack = new ArrayList<BComponent>();
    stack.add(root);
    int visited = 0;
    while (!stack.isEmpty())
    {
      if (visited >= maxComponents || System.currentTimeMillis() > deadline)
      {
        truncated = true;
        break;
      }
      BComponent current = stack.remove(stack.size() - 1);
      visited++;
      String slot = current.getSlotPath() == null ? null : current.getSlotPath().toString();
      Set<String> attached = new LinkedHashSet<String>();
      boolean first = true;
      for (Property property : current.getDynamicPropertiesArray())
      {
        BValue value = current.get(property);
        if (!(value instanceof BPxView)) continue;
        String pxOrd = normalizeFileOrd(((BPxView) value).getPxFile());
        views.add(new View(slot, property.getName(), pxOrd, first, current));
        first = false;
        if (pxOrd != null) attached.add(pxOrd);
      }
      if (slot != null && current != root)
      {
        String parent = parentOf(slot);
        List<Sibling> siblings = byParent.get(parent);
        if (siblings == null) byParent.put(parent, siblings = new ArrayList<Sibling>());
        siblings.add(new Sibling(slot, current.getType().toString(), attached));
      }
      BComponent[] kids = current.getChildComponents();
      for (int i = kids.length - 1; i >= 0; i--)
      {
        if (readable(kids[i], context)) stack.add(kids[i]);
      }
    }

    List<Object> viewsWire = new ArrayList<Object>();
    for (View view : views)
    {
      PxFile px = view.pxOrd == null ? null : pxFiles.get(view.pxOrd);
      String status = px != null ? "ok" : view.pxOrd == null ? "missing" : view.pxOrd.startsWith("module:")
          ? cached(resolved, view.pxOrd, context).status : files.status(view.pxOrd, context);
      if (px != null) px.attachedTo.add(BaskStreamModelPlans.map("ord", view.ord, "view", view.name, "default", Boolean.valueOf(view.isDefault)));
      if (view.pxOrd != null) referencedFiles.add(view.pxOrd);
      if (!"ok".equals(status) && !"not_checked".equals(status))
      {
        punch.add("error", "view_missing_file", view.ord, view.pxOrd, "View " + view.name + " on " + view.ord + " points at "
            + view.pxOrd + ", which " + ("forbidden".equals(status) ? "is not readable" : "is not there") + ".");
      }
      viewsWire.add(BaskStreamModelPlans.map("ord", view.ord, "view", view.name, "pxFile", view.pxOrd, "default", Boolean.valueOf(view.isDefault), "file", status));
    }

    // Siblings of the same type without a view the others have.
    int missingViews = 0;
    for (List<Sibling> siblings : byParent.values())
    {
      Map<String, Integer> typeCount = new HashMap<String, Integer>();
      Map<String, Integer> viewCount = new HashMap<String, Integer>();
      for (Sibling sibling : siblings)
      {
        typeCount.merge(sibling.type, 1, Integer::sum);
        for (String px : sibling.views) viewCount.merge(sibling.type + "\n" + px, 1, Integer::sum);
      }
      for (Map.Entry<String, Integer> entry : viewCount.entrySet())
      {
        String[] parts = entry.getKey().split("\n", 2);
        int total = typeCount.get(parts[0]).intValue();
        int with = entry.getValue().intValue();
        if (with < 2 || with == total || with * 2 < total) continue;
        for (Sibling sibling : siblings)
        {
          if (!sibling.type.equals(parts[0]) || sibling.views.contains(parts[1])) continue;
          missingViews++;
          punch.add("warning", "missing_view", sibling.ord, parts[1], with + " of the " + total + " " + parts[0] + " components beside "
              + sibling.ord + " have a view of " + parts[1] + "; this one has none.");
        }
      }
    }

    // Bindings on the components the views are on.
    int brokenBindings = 0;
    if (checkBindings)
    {
      Set<String> absoluteChecked = new HashSet<String>();
      for (View view : views)
      {
        if (System.currentTimeMillis() > deadline)
        {
          truncated = true;
          break;
        }
        PxFile px = view.pxOrd == null ? null : pxFiles.get(view.pxOrd);
        if (px == null || px.doc == null) continue;
        Set<String> done = new HashSet<String>();
        int shown = 0;
        for (BaskStreamPx.Ref ref : px.doc.refs)
        {
          if (!ref.isData() || !done.add(ref.ord)) continue;
          boolean relative = isRelative(ref.ord);
          if (!relative && !absoluteChecked.add(px.path + "\n" + ref.ord)) continue;
          Resolution resolution = relative ? resolve(ref.ord, view.ord, context) : cached(resolved, ref.ord, context);
          if (resolution.ok() || "not_checked".equals(resolution.status)) continue;
          brokenBindings++;
          if (shown++ < 25)
          {
            punch.add("error", "broken_binding", relative ? view.ord : px.path, ref.ord, (relative ? "View " + view.name + " (" + px.path + ")" : px.path)
                + ": " + ref.ord + " on " + lastName(ref.widget) + " (line " + ref.line + ") " + describeStatus(resolution) + ".");
          }
        }
      }
      // Absolute bindings in Px files no view uses are still worth knowing about.
      for (PxFile px : pxFiles.values())
      {
        if (px.doc == null || !px.attachedTo.isEmpty() || System.currentTimeMillis() > deadline) continue;
        Set<String> done = new HashSet<String>();
        for (BaskStreamPx.Ref ref : px.doc.refs)
        {
          if (!ref.isData() || isRelative(ref.ord) || !done.add(ref.ord)) continue;
          Resolution resolution = cached(resolved, ref.ord, context);
          if (resolution.ok() || "not_checked".equals(resolution.status)) continue;
          brokenBindings++;
          punch.add("error", "broken_binding", px.path, ref.ord, ref.ord + " on " + lastName(ref.widget)
              + " (line " + ref.line + ") " + describeStatus(resolution) + ".");
        }
      }
    }

    // Px files nothing uses, and images no Px or nav file shows.
    int orphans = 0;
    for (PxFile px : pxFiles.values())
    {
      if (!px.attachedTo.isEmpty() || !px.includedBy.isEmpty() || !px.linkedFrom.isEmpty()) continue;
      orphans++;
      punch.add("info", "orphan_px", px.path, null, px.path + " is not a view on any component, not included and not linked from any Px or nav file.");
    }
    List<Object> unused = new ArrayList<Object>();
    int unusedCount = 0;
    for (String image : images)
    {
      if (referencedFiles.contains("file:" + image)) continue;
      unusedCount++;
      if (unused.size() < 200) unused.add(image);
    }
    if (unusedCount > 0)
    {
      punch.add("info", "unused_files", "^", null, unusedCount + " image file" + (unusedCount == 1 ? " is" : "s are")
          + " not shown by any Px or nav file (listed in unusedFiles). Images a Px builds its ORD for at run time count as unused here.");
    }

    List<Object> pxWire = new ArrayList<Object>();
    for (PxFile px : pxFiles.values()) pxWire.add(px.toWire());
    Map<String, Object> summary = new LinkedHashMap<String, Object>();
    summary.put("pxFiles", Long.valueOf(pxFiles.size()));
    summary.put("navFiles", Long.valueOf(navPaths.size()));
    summary.put("images", Long.valueOf(images.size()));
    summary.put("views", Long.valueOf(views.size()));
    summary.put("componentsVisited", Long.valueOf(visited));
    summary.put("errors", Long.valueOf(punch.count("error")));
    summary.put("warnings", Long.valueOf(punch.count("warning")));
    summary.put("orphanPx", Long.valueOf(orphans));
    summary.put("missingViews", Long.valueOf(missingViews));
    summary.put("unusedFiles", Long.valueOf(unusedCount));
    if (checkBindings) summary.put("brokenBindings", Long.valueOf(brokenBindings));

    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("under", under == null ? "slot:/" : under);
    out.put("summary", summary);
    out.put("punchList", punch.sorted());
    out.put("pxFiles", pxWire);
    out.put("navFiles", navWire);
    out.put("views", viewsWire);
    out.put("users", new ArrayList<Object>(users));
    out.put("unusedFiles", unused);
    out.put("truncated", Boolean.valueOf(truncated || punch.truncated));
    return out;
  }

  private Resolution cached(Map<String, Resolution> cache, String ord, Context context)
  {
    Resolution resolution = cache.get(ord);
    if (resolution == null)
    {
      resolution = resolve(ord, null, context);
      cache.put(ord, resolution);
    }
    return resolution;
  }

  private static String describeStatus(Resolution resolution)
  {
    String what = "forbidden".equals(resolution.status) ? "is not readable here" : "invalid".equals(resolution.status) ? "is not a valid ORD" : "does not resolve";
    return what + (resolution.reason == null ? "" : " (" + resolution.reason + ")");
  }

  /** file:^a/b.px for an ORD that names a station file, else null. */
  private static String fileOrdOf(String ord)
  {
    String text = ord.trim();
    if (text.startsWith("local:|")) text = text.substring(7);
    if (!text.startsWith("file:^") || text.indexOf('|') >= 0) return null;
    return text;
  }

  private static final class PxFile
  {
    final String path;
    final Map<String, Object> entry;
    BaskStreamPx.Doc doc;
    final List<Object> attachedTo = new ArrayList<Object>();
    final Set<String> includes = new LinkedHashSet<String>();
    final Set<String> includedBy = new LinkedHashSet<String>();
    final Set<String> linkedFrom = new LinkedHashSet<String>();

    PxFile(String path, Map<String, Object> entry)
    {
      this.path = path;
      this.entry = entry;
    }

    Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("path", path);
      wire.put("size", entry.get("size"));
      wire.put("modified", entry.get("modified"));
      wire.put("attachedTo", attachedTo);
      wire.put("includes", new ArrayList<Object>(includes));
      wire.put("includedBy", new ArrayList<Object>(includedBy));
      wire.put("linkedFrom", new ArrayList<Object>(linkedFrom));
      if (doc != null)
      {
        int data = 0;
        int relative = 0;
        for (BaskStreamPx.Ref ref : doc.refs)
        {
          if (!ref.isData()) continue;
          data++;
          if (isRelative(ref.ord)) relative++;
        }
        wire.put("bindings", Long.valueOf(data));
        wire.put("relativeBindings", Long.valueOf(relative));
        wire.put("errors", Long.valueOf(doc.count("error")));
        wire.put("imports", new ArrayList<Object>(doc.imports));
      }
      return wire;
    }
  }

  private static final class View
  {
    final String ord;
    final String name;
    final String pxOrd;
    final boolean isDefault;
    final BComponent component;

    View(String ord, String name, String pxOrd, boolean isDefault, BComponent component)
    {
      this.ord = ord;
      this.name = name;
      this.pxOrd = pxOrd;
      this.isDefault = isDefault;
      this.component = component;
    }
  }

  private static final class Sibling
  {
    final String ord;
    final String type;
    final Set<String> views;

    Sibling(String ord, String type, Set<String> views)
    {
      this.ord = ord;
      this.type = type;
      this.views = views;
    }
  }

  private static final class Punch
  {
    private final List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
    boolean truncated;

    void add(String severity, String kind, String where, String target, String message)
    {
      if (items.size() >= MAX_PUNCH_ITEMS)
      {
        truncated = true;
        return;
      }
      Map<String, Object> item = new LinkedHashMap<String, Object>();
      item.put("severity", severity);
      item.put("kind", kind);
      item.put("where", where);
      if (target != null) item.put("target", target);
      item.put("message", message);
      items.add(item);
    }

    int count(String severity)
    {
      int n = 0;
      for (Map<String, Object> item : items) if (severity.equals(item.get("severity"))) n++;
      return n;
    }

    List<Object> sorted()
    {
      List<Map<String, Object>> copy = new ArrayList<Map<String, Object>>(items);
      final List<String> order = Arrays.asList("error", "warning", "info");
      Collections.sort(copy, (a, b) -> order.indexOf(a.get("severity")) - order.indexOf(b.get("severity")));
      return new ArrayList<Object>(copy);
    }
  }
}
