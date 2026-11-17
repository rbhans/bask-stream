package com.basidekick.baskstream;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.baja.registry.ModuleInfo;
import javax.baja.registry.Registry;
import javax.baja.registry.TypeInfo;
import javax.baja.sys.Sys;
import javax.baja.xml.XContent;
import javax.baja.xml.XElem;
import javax.baja.xml.XParser;
import javax.baja.xml.XText;

/**
 * Px files as data. A Px file is XML: {@code <px>} holds {@code <import>} (the modules whose types
 * the file uses) and {@code <content>} (one widget tree). Every other element names a Niagara type,
 * looked up in the imported modules in order; attributes are property values, and child elements are
 * child widgets, bindings or complex property values (those carry a {@code name} attribute).
 *
 * <p>This reads a file into a tree and a list of what it refers to (bindings, ORD properties, links,
 * images, includes), checks every type and module against this station's registry, and writes a tree
 * back out as Px XML. Niagara's own Px encoder lives in Workbench-only modules, so the format is
 * handled here directly; the tree is a lossless copy of the XML, so a file read and written back
 * keeps its elements, attributes and their order.
 */
final class BaskStreamPx
{
  static final int MAX_ELEMENTS = 50000;
  static final int MAX_DEPTH = 64;
  static final int MAX_PROBLEMS = 200;
  static final int MAX_REFS = 5000;

  /** Elements of the Px format itself; every other element names a Niagara type. */
  private static final Set<String> STRUCTURE = new HashSet<String>(Arrays.asList("px", "import", "module", "content"));
  private static final Pattern XML_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_.:-]{0,199}");
  private static final Pattern ORD_LIKE = Pattern.compile("[a-zA-Z][a-zA-Z0-9]*:.*");

  /** Something a Px file points at. */
  static final class Ref
  {
    /** binding, ordProperty, link, file, include or view. */
    final String kind;
    final String ord;
    /** The widget it belongs to, as a path of element names, e.g. /ScrollPane/CanvasPane[content]/Label#2. */
    final String widget;
    /** The property that holds it (hyperlink, image, valueOrd...), or null for a binding's own ord. */
    final String property;
    final String element;
    final int line;

    Ref(String kind, String ord, String widget, String property, String element, int line)
    {
      this.kind = kind;
      this.ord = ord;
      this.widget = widget;
      this.property = property;
      this.element = element;
      this.line = line;
    }

    Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("kind", kind);
      wire.put("ord", ord);
      wire.put("widget", widget);
      if (property != null) wire.put("property", property);
      wire.put("element", element);
      wire.put("line", Long.valueOf(line));
      return wire;
    }

    /** Bindings and ORD properties name the data a widget shows; the others are files and pages. */
    boolean isData()
    {
      return "binding".equals(kind) || "ordProperty".equals(kind);
    }
  }

  static final class Problem
  {
    final String severity;
    final String code;
    final String message;
    final int line;

    Problem(String severity, String code, String message, int line)
    {
      this.severity = severity;
      this.code = code;
      this.message = message;
      this.line = line;
    }

    Map<String, Object> toWire()
    {
      Map<String, Object> wire = new LinkedHashMap<String, Object>();
      wire.put("severity", severity);
      wire.put("code", code);
      wire.put("message", message);
      if (line > 0) wire.put("line", Long.valueOf(line));
      return wire;
    }
  }

  /** A parsed Px file: its tree, what it imports and refers to, and what is wrong with it. */
  static final class Doc
  {
    XElem root;
    String version;
    String media;
    final List<String> imports = new ArrayList<String>();
    final Map<String, Integer> types = new LinkedHashMap<String, Integer>();
    final List<Ref> refs = new ArrayList<Ref>();
    final List<Problem> problems = new ArrayList<Problem>();
    final Map<XElem, String> typeSpecs = new HashMap<XElem, String>();
    int elements;
    boolean truncated;

    void problem(String severity, String code, String message, int line)
    {
      if (problems.size() < MAX_PROBLEMS) problems.add(new Problem(severity, code, message, line));
      else truncated = true;
    }

    int count(String severity)
    {
      int n = 0;
      for (Problem problem : problems) if (severity.equals(problem.severity)) n++;
      return n;
    }

    boolean valid()
    {
      return root != null && count("error") == 0;
    }

    List<Object> problemsWire()
    {
      List<Object> out = new ArrayList<Object>();
      for (Problem problem : problems) out.add(problem.toWire());
      return out;
    }

    List<Object> refsWire()
    {
      List<Object> out = new ArrayList<Object>();
      for (Ref ref : refs) out.add(ref.toWire());
      return out;
    }

    /** The first few errors in one line, for an error message. */
    String errorSummary(int max)
    {
      StringBuilder text = new StringBuilder();
      int shown = 0;
      for (Problem problem : problems)
      {
        if (!"error".equals(problem.severity)) continue;
        if (shown == max) { text.append("; ..."); break; }
        if (shown++ > 0) text.append("; ");
        if (problem.line > 0) text.append("line ").append(problem.line).append(": ");
        text.append(problem.message);
      }
      return text.toString();
    }
  }

  // ---- Reading ----------------------------------------------------------------------------------

  static Doc parse(byte[] bytes)
  {
    Doc doc = new Doc();
    XElem root;
    try
    {
      root = XParser.make(new ByteArrayInputStream(bytes)).parse();
    }
    catch (Exception e)
    {
      doc.problem("error", "xml_invalid", "Not well-formed XML: " + message(e), 0);
      return doc;
    }
    doc.root = root;
    if (!"px".equals(root.qname()))
    {
      doc.problem("error", "not_px", "The root element is <" + root.qname() + ">, not <px>.", root.line());
      return doc;
    }
    doc.version = root.get("version", null);
    doc.media = root.get("media", null);
    if (doc.version == null) doc.problem("warning", "px_version_missing", "<px> has no version attribute (Workbench writes version=\"1.0\").", root.line());
    if (doc.media != null && typeInfo(doc.media) == null)
    {
      doc.problem("warning", "unknown_media", "Media type " + doc.media + " is not installed on this station.", root.line());
    }

    XElem imports = root.elem("import");
    if (imports == null)
    {
      doc.problem("warning", "no_imports", "<px> has no <import>; only fully qualified element names (module:Type) resolve.", root.line());
    }
    else
    {
      for (XElem module : imports.elems("module"))
      {
        String name = module.get("name", null);
        if (name == null || name.trim().length() == 0)
        {
          doc.problem("error", "module_missing", "An <import> <module> has no name.", module.line());
          continue;
        }
        doc.imports.add(name);
        if (!moduleInstalled(name))
        {
          doc.problem("error", "module_missing", "Module " + name + " is imported but not installed on this station.", module.line());
        }
      }
    }

    XElem content = root.elem("content");
    if (content == null)
    {
      doc.problem("error", "content_missing", "<px> has no <content> element.", root.line());
      return doc;
    }
    XElem[] widgets = content.elems();
    if (widgets.length != 1)
    {
      doc.problem("error", "content_root", "<content> must hold exactly one widget; it holds " + widgets.length + ".", content.line());
    }
    Resolver resolver = new Resolver(doc.imports);
    Map<String, Integer> seen = new HashMap<String, Integer>();
    for (XElem widget : widgets) walk(doc, resolver, widget, "", 1, label(widget, seen));
    return doc;
  }

  static Doc parse(String text)
  {
    return parse(text.getBytes(StandardCharsets.UTF_8));
  }

  private static void walk(Doc doc, Resolver resolver, XElem elem, String parentPath, int depth, String label)
  {
    if (doc.elements >= MAX_ELEMENTS)
    {
      if (!doc.truncated) doc.problem("warning", "px_too_large", "Only the first " + MAX_ELEMENTS + " elements were read.", elem.line());
      doc.truncated = true;
      return;
    }
    doc.elements++;
    if (depth > MAX_DEPTH)
    {
      doc.problem("error", "px_too_deep", "Elements are nested more than " + MAX_DEPTH + " deep.", elem.line());
      return;
    }
    String name = elem.qname();
    String path = parentPath + "/" + label;
    String spec = STRUCTURE.contains(name) ? null : resolver.spec(name);
    if (STRUCTURE.contains(name))
    {
      doc.problem("error", "misplaced_element", "<" + name + "> belongs at the top of the file, not inside <content>.", elem.line());
    }
    else if (spec == null)
    {
      doc.problem("error", "unknown_type", "<" + name + "> is not a type in any imported module"
          + (doc.imports.isEmpty() ? "" : " (" + join(doc.imports) + ")") + ".", elem.line());
    }
    else
    {
      doc.typeSpecs.put(elem, spec);
    }
    String key = spec != null ? spec : name;
    Integer count = doc.types.get(key);
    doc.types.put(key, Integer.valueOf(count == null ? 1 : count.intValue() + 1));

    collectRefs(doc, resolver, elem, name, spec, parentPath, path);

    Map<String, Integer> seen = new HashMap<String, Integer>();
    for (XElem child : elem.elems()) walk(doc, resolver, child, path, depth + 1, label(child, seen));
  }

  /** A widget's place in the path: Type[name] when it has a name, else Type#n among its like siblings. */
  private static String label(XElem elem, Map<String, Integer> seen)
  {
    String name = elem.get("name", null);
    if (name != null) return elem.qname() + "[" + name + "]";
    Integer n = seen.get(elem.qname());
    int next = n == null ? 1 : n.intValue() + 1;
    seen.put(elem.qname(), Integer.valueOf(next));
    return elem.qname() + "#" + next;
  }

  private static void collectRefs(Doc doc, Resolver resolver, XElem elem, String name, String spec, String parentPath, String path)
  {
    String propertyName = elem.get("name", null);
    boolean binding = resolver.isBinding(name, spec);
    boolean include = resolver.isInclude(name, spec);
    boolean ordValue = "Ord".equals(name) || "baja:Ord".equals(spec);
    boolean stringValue = "String".equals(name) || "baja:String".equals(spec);
    for (int i = 0; i < elem.attrSize(); i++)
    {
      String attr = elem.attrName(i);
      String value = elem.attrValue(i);
      if (value == null) continue;
      value = value.trim();
      if (value.length() == 0 || "null".equals(value)) continue;
      if ("ord".equals(attr))
      {
        // A binding belongs to the widget it sits in; an include is a widget itself.
        add(doc, include ? "include" : binding ? "binding" : "ordProperty", value, binding ? parentPath : path, binding || include ? null : "ord", name, elem.line());
      }
      else if ("hyperlink".equals(attr))
      {
        add(doc, "link", value, path, attr, name, elem.line());
      }
      else if ("value".equals(attr) && propertyName != null && ordValue)
      {
        add(doc, "ordProperty", value, parentPath, propertyName, name, elem.line());
      }
      else if ("value".equals(attr) && propertyName != null && stringValue
          && propertyName.toLowerCase().matches(".*ords?") && ORD_LIKE.matcher(value).matches())
      {
        // Web widgets often keep an ORD in a String property named like valueOrd or point1Ord.
        add(doc, "ordProperty", value, parentPath, propertyName, name, elem.line());
      }
      else if ("js".equals(attr) && value.startsWith("view:"))
      {
        add(doc, "view", value, path, attr, name, elem.line());
      }
      else if (value.startsWith("file:") || value.startsWith("module://"))
      {
        add(doc, "file", value, "value".equals(attr) && propertyName != null ? parentPath : path,
            "value".equals(attr) && propertyName != null ? propertyName : attr, name, elem.line());
      }
    }
  }

  private static void add(Doc doc, String kind, String ord, String widget, String property, String element, int line)
  {
    if (doc.refs.size() >= MAX_REFS)
    {
      if (!doc.truncated) doc.problem("warning", "px_too_large", "Only the first " + MAX_REFS + " references were read.", line);
      doc.truncated = true;
      return;
    }
    doc.refs.add(new Ref(kind, ord, widget.length() == 0 ? "/" : widget, property, element, line));
  }

  /** The module of a {@code view:Module:Name} widget reference, or null. */
  static String viewModule(String view)
  {
    if (view == null || !view.startsWith("view:")) return null;
    String rest = view.substring(5);
    int colon = rest.indexOf(':');
    return colon > 0 ? rest.substring(0, colon) : null;
  }

  // ---- The tree as wire data, and back -----------------------------------------------------------

  /** The element and everything under it, with each element's type where it resolved. */
  static Map<String, Object> tree(Doc doc, XElem elem)
  {
    Map<String, Object> node = new LinkedHashMap<String, Object>();
    node.put("element", elem.qname());
    String spec = doc.typeSpecs.get(elem);
    if (spec != null) node.put("typeSpec", spec);
    Map<String, Object> attributes = new LinkedHashMap<String, Object>();
    for (int i = 0; i < elem.attrSize(); i++) attributes.put(elem.attrName(i), elem.attrValue(i));
    node.put("attributes", attributes);
    node.put("line", Long.valueOf(elem.line()));
    StringBuilder text = new StringBuilder();
    List<Object> children = new ArrayList<Object>();
    for (XContent content : elem.content())
    {
      if (content instanceof XElem) children.add(tree(doc, (XElem) content));
      else if (content instanceof XText) text.append(((XText) content).string());
    }
    if (text.toString().trim().length() > 0) node.put("text", text.toString());
    node.put("children", children);
    return node;
  }

  /**
   * Px XML from a tree in the form {@link #tree} returns ({element, attributes, children, text};
   * typeSpec and line are ignored). The root must be the {@code px} element.
   */
  static String toXml(Object tree) throws BaskStreamProtocolException
  {
    if (!(tree instanceof Map)) throw new BaskStreamProtocolException("bad_request", "Field 'tree' must be an object.");
    Object element = ((Map<?, ?>) tree).get("element");
    if (!"px".equals(element)) throw new BaskStreamProtocolException("bad_request", "The tree's root element must be \"px\".");
    StringBuilder out = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- Niagara Presentation XML -->\n");
    int[] count = new int[1];
    write(out, tree, 0, count);
    return out.toString();
  }

  private static void write(StringBuilder out, Object value, int depth, int[] count) throws BaskStreamProtocolException
  {
    if (!(value instanceof Map)) throw new BaskStreamProtocolException("bad_request", "Every tree node must be an object.");
    if (++count[0] > MAX_ELEMENTS) throw new BaskStreamProtocolException("bad_request", "The tree has more than " + MAX_ELEMENTS + " elements.");
    if (depth > MAX_DEPTH + 2) throw new BaskStreamProtocolException("bad_request", "The tree is nested more than " + MAX_DEPTH + " deep.");
    Map<?, ?> node = (Map<?, ?>) value;
    Object name = node.get("element");
    if (!(name instanceof String) || !XML_NAME.matcher((String) name).matches())
      throw new BaskStreamProtocolException("bad_request", "Tree node has no valid 'element' name: " + name);
    String indent = depth <= 1 ? "" : spaces(2 * (depth - 2));
    out.append(indent).append('<').append(name);
    Object attributes = node.get("attributes");
    if (attributes != null && !(attributes instanceof Map))
      throw new BaskStreamProtocolException("bad_request", "Tree node 'attributes' must be an object of strings.");
    if (attributes != null)
    {
      for (Map.Entry<?, ?> attr : ((Map<?, ?>) attributes).entrySet())
      {
        String attrName = String.valueOf(attr.getKey());
        if (!XML_NAME.matcher(attrName).matches())
          throw new BaskStreamProtocolException("bad_request", "Not a valid attribute name: " + attrName);
        Object attrValue = attr.getValue();
        if (attrValue == null) continue;
        if (attrValue instanceof Map || attrValue instanceof List)
          throw new BaskStreamProtocolException("bad_request", "Attribute " + attrName + " must be a string, number or boolean.");
        out.append(' ').append(attrName).append("=\"").append(escape(String.valueOf(attrValue), true)).append('"');
      }
    }
    Object children = node.get("children");
    if (children != null && !(children instanceof List))
      throw new BaskStreamProtocolException("bad_request", "Tree node 'children' must be a list.");
    Object text = node.get("text");
    List<?> kids = children == null ? new ArrayList<Object>() : (List<?>) children;
    if (kids.isEmpty() && !(text instanceof String))
    {
      out.append("/>\n");
      return;
    }
    out.append('>');
    if (text instanceof String) out.append(escape((String) text, false));
    if (!kids.isEmpty())
    {
      out.append('\n');
      for (Object kid : kids) write(out, kid, depth + 1, count);
      out.append(indent);
    }
    out.append("</").append(name).append(">\n");
  }

  private static String spaces(int n)
  {
    char[] chars = new char[n];
    Arrays.fill(chars, ' ');
    return new String(chars);
  }

  static String escape(String text, boolean attribute)
  {
    StringBuilder out = new StringBuilder(text.length() + 8);
    for (int i = 0; i < text.length(); i++)
    {
      char ch = text.charAt(i);
      switch (ch)
      {
        case '&': out.append("&amp;"); break;
        case '<': out.append("&lt;"); break;
        case '>': out.append("&gt;"); break;
        case '"': out.append(attribute ? "&quot;" : "\""); break;
        default:
          if (ch < 0x20 && (attribute || (ch != '\n' && ch != '\t' && ch != '\r'))) out.append("&#x").append(Integer.toHexString(ch)).append(';');
          else out.append(ch);
      }
    }
    return out.toString();
  }

  // ---- The station's types and modules -----------------------------------------------------------

  /** Element names to types, the way the Px decoder looks them up: the imported modules in order. */
  private static final class Resolver
  {
    private final List<String> imports;
    private final Map<String, String> specs = new HashMap<String, String>();
    private final TypeInfo binding = typeInfo("bajaui:Binding");
    private final TypeInfo include = typeInfo("bajaui:PxInclude");

    Resolver(List<String> imports)
    {
      this.imports = imports;
    }

    String spec(String name)
    {
      if (specs.containsKey(name)) return specs.get(name);
      String found = null;
      if (name.indexOf(':') > 0)
      {
        if (typeInfo(name) != null) found = name;
      }
      else
      {
        for (String module : imports)
        {
          if (typeInfo(module + ":" + name) != null)
          {
            found = module + ":" + name;
            break;
          }
        }
      }
      specs.put(name, found);
      return found;
    }

    boolean isBinding(String name, String spec)
    {
      TypeInfo info = spec == null ? null : typeInfo(spec);
      if (info != null && binding != null) return is(info, binding);
      return name.endsWith("Binding");
    }

    boolean isInclude(String name, String spec)
    {
      TypeInfo info = spec == null ? null : typeInfo(spec);
      if (info != null && include != null) return is(info, include);
      return name.endsWith("PxInclude");
    }
  }

  private static boolean is(TypeInfo info, TypeInfo base)
  {
    try
    {
      return info.is(base);
    }
    catch (RuntimeException e)
    {
      return false;
    }
  }

  static TypeInfo typeInfo(String spec)
  {
    try
    {
      Registry registry = Sys.getRegistry();
      return registry == null ? null : registry.getType(spec);
    }
    catch (Exception e)
    {
      return null;
    }
  }

  static boolean moduleInstalled(String name)
  {
    try
    {
      ModuleInfo[] modules = Sys.getRegistry().getModules(name);
      return modules != null && modules.length > 0;
    }
    catch (Exception e)
    {
      return false;
    }
  }

  private static String join(List<String> items)
  {
    StringBuilder text = new StringBuilder();
    for (String item : items)
    {
      if (text.length() > 0) text.append(", ");
      text.append(item);
    }
    return text.toString();
  }

  static String message(Throwable e)
  {
    String text = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    return text.length() > 300 ? text.substring(0, 300) : text;
  }

  private BaskStreamPx()
  {
  }
}
