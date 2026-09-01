package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.baja.data.BIDataValue;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.sys.BBoolean;
import javax.baja.sys.BComponent;
import javax.baja.sys.BDouble;
import javax.baja.sys.BLong;
import javax.baja.sys.BMarker;
import javax.baja.sys.BObject;
import javax.baja.sys.BRelation;
import javax.baja.sys.BString;
import javax.baja.sys.Context;
import javax.baja.tag.Id;
import javax.baja.tag.Relation;
import javax.baja.tag.Relations;
import javax.baja.tag.SmartRelations;
import javax.baja.tag.SmartTags;
import javax.baja.tag.Tag;
import javax.baja.tag.Tags;

/**
 * Reads and writes Niagara component tags and relations for the external API.
 *
 * <p>Tags are dictionary-neutral: Haystack tags ({@code hs:...}), Niagara tags
 * ({@code n:...}), and site/hierarchy dictionary tags are all addressed by their
 * qualified name. Writes touch only <em>direct</em> tags/relations on the target
 * component; implied tags contributed by tag dictionaries are read-only evidence
 * and are reported with {@code "source": "implied"}.</p>
 */
final class BaskStreamTagResolver
{
  private static final int MAX_TARGETS_PER_REQUEST = 100;
  private static final int MAX_OPS_PER_TARGET = 100;
  private static final int MAX_TAGS_ON_WIRE = 500;

  private final BBaskStreamService service;

  BaskStreamTagResolver(BBaskStreamService service)
  {
    this.service = service;
  }

  int getMaxTargetsPerRequest()
  {
    return MAX_TARGETS_PER_REQUEST;
  }

  // ---------------------------------------------------------------- read

  List<Object> readTags(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    List<String> ords = normalizeOrds(request);
    String dictionary = normalizeDictionary(optionalString(request, "dictionary"));
    boolean includeRelations = !Boolean.FALSE.equals(request.get("includeRelations"));

    List<Object> results = new ArrayList<Object>(ords.size());
    for (String ord : ords)
    {
      try
      {
        BComponent component = resolveReadable(ord, context);
        Map<String, Object> entry = baseEntry(ord, component, context);
        entry.put("tags", tagsToWire(component, dictionary));
        if (includeRelations)
        {
          entry.put("relations", relationsToWire(component, dictionary));
        }
        results.add(entry);
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(ord, e.getCode(), e.getMessage()));
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- write tags

  List<Object> writeTags(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    List<Map<String, Object>> specs = normalizeSpecs(request);
    List<Object> results = new ArrayList<Object>(specs.size());
    for (Map<String, Object> spec : specs)
    {
      String ord = specOrd(spec);
      try
      {
        results.add(writeTagsForTarget(ord, spec, context));
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(ord, e.getCode(), e.getMessage()));
      }
    }
    return results;
  }

  private Map<String, Object> writeTagsForTarget(String ord, Map<String, Object> spec, Context context)
      throws BaskStreamProtocolException
  {
    BComponent component = resolveWritable(ord, context);
    List<Map<String, Object>> sets = optionalMapList(spec, "set");
    List<Object> removes = optionalList(spec, "remove");
    int opCount = (sets == null ? 0 : sets.size()) + (removes == null ? 0 : removes.size());
    if (opCount == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Tag write requires a 'set' and/or 'remove' array.");
    }
    if (opCount > MAX_OPS_PER_TARGET)
    {
      throw new BaskStreamProtocolException("bad_request",
          "Tag write cannot contain more than " + MAX_OPS_PER_TARGET + " operations per target.");
    }

    Tags tags = component.tags();
    List<Object> opResults = new ArrayList<Object>(opCount);

    if (sets != null)
    {
      for (Map<String, Object> setSpec : sets)
      {
        opResults.add(applyTagSet(tags, setSpec));
      }
    }
    if (removes != null)
    {
      for (Object removeSpec : removes)
      {
        opResults.add(applyTagRemove(tags, removeSpec));
      }
    }

    Map<String, Object> entry = baseEntry(ord, component, context);
    entry.put("results", opResults);
    entry.put("tags", tagsToWire(component, null));
    return entry;
  }

  private Map<String, Object> applyTagSet(Tags tags, Map<String, Object> setSpec)
  {
    String qname = tagName(setSpec);
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("op", "set");
    result.put("id", qname);
    try
    {
      Id id = parseId(qname);
      BIDataValue value = toDataValue(setSpec.get("value"), optionalString(setSpec, "valueType"));
      boolean ok = tags.set(new Tag(id, value));
      result.put("ok", Boolean.valueOf(ok));
      if (!ok)
      {
        result.put("code", "tag_rejected");
        result.put("message", "Niagara rejected the tag set (target tags may be read-only).");
      }
    }
    catch (BaskStreamProtocolException e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", e.getCode());
      result.put("message", e.getMessage());
    }
    catch (Exception e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", "tag_failed");
      result.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    return result;
  }

  private Map<String, Object> applyTagRemove(Tags tags, Object removeSpec)
  {
    String qname = removeSpec instanceof String
        ? (String) removeSpec
        : removeSpec instanceof Map ? tagName(castMap(removeSpec)) : null;
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("op", "remove");
    result.put("id", qname);
    try
    {
      Id id = parseId(qname);
      if (isImpliedOnly(tags, id))
      {
        result.put("ok", Boolean.FALSE);
        result.put("code", "implied_tag");
        result.put("message", "Tag is implied by a tag dictionary and cannot be removed from the component.");
        return result;
      }
      boolean ok = tags.removeAll(id);
      result.put("ok", Boolean.valueOf(ok));
      if (!ok)
      {
        result.put("code", "tag_not_found");
        result.put("message", "No direct tag with this id exists on the component.");
      }
    }
    catch (BaskStreamProtocolException e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", e.getCode());
      result.put("message", e.getMessage());
    }
    catch (Exception e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", "tag_failed");
      result.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    return result;
  }

  // ---------------------------------------------------------------- write relations

  List<Object> writeRelations(Map<String, Object> request, Context context) throws BaskStreamProtocolException
  {
    List<Map<String, Object>> specs = normalizeSpecs(request);
    List<Object> results = new ArrayList<Object>(specs.size());
    for (Map<String, Object> spec : specs)
    {
      String ord = specOrd(spec);
      try
      {
        results.add(writeRelationsForTarget(ord, spec, context));
      }
      catch (BaskStreamProtocolException e)
      {
        results.add(errorEntry(ord, e.getCode(), e.getMessage()));
      }
    }
    return results;
  }

  private Map<String, Object> writeRelationsForTarget(String ord, Map<String, Object> spec, Context context)
      throws BaskStreamProtocolException
  {
    BComponent component = resolveWritable(ord, context);
    List<Map<String, Object>> adds = optionalMapList(spec, "add");
    List<Map<String, Object>> removes = optionalMapList(spec, "remove");
    int opCount = (adds == null ? 0 : adds.size()) + (removes == null ? 0 : removes.size());
    if (opCount == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Relation write requires an 'add' and/or 'remove' array.");
    }
    if (opCount > MAX_OPS_PER_TARGET)
    {
      throw new BaskStreamProtocolException("bad_request",
          "Relation write cannot contain more than " + MAX_OPS_PER_TARGET + " operations per target.");
    }

    Relations relations = component.relations();
    List<Object> opResults = new ArrayList<Object>(opCount);

    if (adds != null)
    {
      for (Map<String, Object> addSpec : adds)
      {
        opResults.add(applyRelationAdd(relations, addSpec, context));
      }
    }
    if (removes != null)
    {
      for (Map<String, Object> removeSpec : removes)
      {
        opResults.add(applyRelationRemove(component, removeSpec));
      }
    }

    Map<String, Object> entry = baseEntry(ord, component, context);
    entry.put("results", opResults);
    entry.put("relations", relationsToWire(component, null));
    return entry;
  }

  private Map<String, Object> applyRelationAdd(Relations relations, Map<String, Object> addSpec, Context context)
  {
    String qname = optionalString(addSpec, "id");
    String endpointOrd = optionalString(addSpec, "endpoint");
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("op", "add");
    result.put("id", qname);
    result.put("endpoint", endpointOrd);
    try
    {
      Id id = parseId(qname);
      BComponent endpoint = resolveReadable(endpointOrd, context);
      boolean inbound = Boolean.TRUE.equals(addSpec.get("inbound"));
      // Component-space relations must be BRelation structs; ComponentRelations.add
      // rejects generic javax.baja.tag.BasicRelation instances ("not a BRelation type").
      Relation added = relations.add(new BRelation(id, endpoint, inbound));
      result.put("ok", Boolean.valueOf(added != null));
      if (added == null)
      {
        result.put("code", "relation_rejected");
        result.put("message", "Niagara rejected the relation add.");
      }
    }
    catch (BaskStreamProtocolException e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", e.getCode());
      result.put("message", e.getMessage());
    }
    catch (Exception e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", "relation_failed");
      result.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    return result;
  }

  private Map<String, Object> applyRelationRemove(BComponent component, Map<String, Object> removeSpec)
  {
    String qname = optionalString(removeSpec, "id");
    String endpointOrd = optionalString(removeSpec, "endpoint");
    String direction = optionalString(removeSpec, "direction");
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("op", "remove");
    result.put("id", qname);
    result.put("endpoint", endpointOrd);
    try
    {
      Id id = parseId(qname);
      Relations relations = component.relations();
      BRelation[] stored = component.getComponentRelations();
      if (stored == null)
      {
        stored = new BRelation[0];
      }
      int removed = 0;
      // Remove the stored BRelation structs. Relations.getAll() wrappers are
      // BasicRelation instances and cannot be mapped back to a property.
      for (int i = 0; i < stored.length; i++)
      {
        BRelation relation = stored[i];
        if (relation == null || !id.equals(relation.getId()))
        {
          continue;
        }
        if (direction != null && !matchesDirection(relation, direction))
        {
          continue;
        }
        if (endpointOrd != null && !matchesEndpoint(relation, endpointOrd))
        {
          continue;
        }
        if (removeStoredRelation(component, relations, relation))
        {
          removed++;
        }
      }
      result.put("removed", Long.valueOf(removed));
      result.put("ok", Boolean.valueOf(removed > 0));
      if (removed == 0)
      {
        result.put("code", "relation_not_found");
        result.put("message", "No matching direct relation was found on the component.");
      }
    }
    catch (BaskStreamProtocolException e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", e.getCode());
      result.put("message", e.getMessage());
    }
    catch (Exception e)
    {
      result.put("ok", Boolean.FALSE);
      result.put("code", "relation_failed");
      result.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
    return result;
  }

  private boolean removeStoredRelation(BComponent component, Relations relations, BRelation relation)
  {
    try
    {
      if (relations.remove(relation))
      {
        return true;
      }
    }
    catch (Exception ignored)
    {
      // Fall through to component.remove, which deletes the dynamic BRelation slot.
    }
    try
    {
      component.remove(relation);
      return true;
    }
    catch (Exception ignored)
    {
      return false;
    }
  }

  private boolean matchesDirection(Relation relation, String direction)
  {
    if ("in".equalsIgnoreCase(direction) || "inbound".equalsIgnoreCase(direction))
    {
      return relation.isInbound();
    }
    if ("out".equalsIgnoreCase(direction) || "outbound".equalsIgnoreCase(direction))
    {
      return relation.isOutbound();
    }
    return true;
  }

  private boolean matchesEndpoint(Relation relation, String endpointOrd)
  {
    BOrd relationEndpoint = relation.getEndpointOrd();
    if (relationEndpoint != null && endpointOrd.equals(relationEndpoint.toString()))
    {
      return true;
    }
    Object endpoint = relation.getEndpoint();
    if (endpoint instanceof BComponent)
    {
      BComponent endpointComponent = (BComponent) endpoint;
      return endpointComponent.getSlotPath() != null
          && endpointOrd.equals(endpointComponent.getSlotPath().toString());
    }
    return false;
  }

  // ---------------------------------------------------------------- wire helpers

  private List<Object> tagsToWire(BComponent component, String dictionary)
  {
    List<Object> out = new ArrayList<Object>();
    try
    {
      Tags tags = component.tags();
      Set<Id> directIds = directTagIds(tags);
      int count = 0;
      for (Tag tag : tags)
      {
        if (dictionary != null && !dictionary.equals(tag.getId().getDictionary()))
        {
          continue;
        }
        if (count++ >= MAX_TAGS_ON_WIRE)
        {
          break;
        }
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        wire.put("id", tag.getId().toString());
        wire.put("dictionary", tag.getId().hasDictionary() ? tag.getId().getDictionary() : null);
        wire.put("name", tag.getId().getName());
        wire.put("value", dataValueToWire(tag.getValue()));
        wire.put("valueType", tag.getValue() == null ? null : tag.getValue().getType().toString());
        wire.put("marker", Boolean.valueOf(tag.getValue() instanceof BMarker));
        wire.put("source", directIds == null ? "unknown" : directIds.contains(tag.getId()) ? "direct" : "implied");
        out.add(wire);
      }
    }
    catch (Exception ignored)
    {
      // Tags are supplemental; a failing tag dictionary should not fail the whole read.
    }
    return out;
  }

  private List<Object> relationsToWire(BComponent component, String dictionary)
  {
    List<Object> out = new ArrayList<Object>();
    try
    {
      Relations relations = component.relations();
      Set<Id> directIds = directRelationIds(relations);
      int count = 0;
      for (Relation relation : relations.getAll())
      {
        if (dictionary != null && !dictionary.equals(relation.getId().getDictionary()))
        {
          continue;
        }
        if (count++ >= MAX_TAGS_ON_WIRE)
        {
          break;
        }
        Map<String, Object> wire = new LinkedHashMap<String, Object>();
        wire.put("id", relation.getId().toString());
        wire.put("dictionary", relation.getId().hasDictionary() ? relation.getId().getDictionary() : null);
        wire.put("name", relation.getId().getName());
        wire.put("direction", relation.isInbound() ? "in" : "out");
        wire.put("endpointOrd", relation.getEndpointOrd() == null ? null : relation.getEndpointOrd().toString());
        wire.put("source", directIds == null ? "unknown" : directIds.contains(relation.getId()) ? "direct" : "implied");
        out.add(wire);
      }
    }
    catch (Exception ignored)
    {
      // Relations are supplemental; a failing relation provider should not fail the whole read.
    }
    return out;
  }

  private Set<Id> directTagIds(Tags tags)
  {
    if (!(tags instanceof SmartTags))
    {
      return null;
    }
    try
    {
      Set<Id> ids = new LinkedHashSet<Id>();
      for (Tag tag : ((SmartTags) tags).getDirectTags())
      {
        ids.add(tag.getId());
      }
      return ids;
    }
    catch (Exception e)
    {
      return null;
    }
  }

  private Set<Id> directRelationIds(Relations relations)
  {
    if (!(relations instanceof SmartRelations))
    {
      return null;
    }
    try
    {
      Set<Id> ids = new LinkedHashSet<Id>();
      for (Relation relation : ((SmartRelations) relations).getDirectRelations())
      {
        ids.add(relation.getId());
      }
      return ids;
    }
    catch (Exception e)
    {
      return null;
    }
  }

  private boolean isImpliedOnly(Tags tags, Id id)
  {
    if (!(tags instanceof SmartTags))
    {
      return false;
    }
    try
    {
      SmartTags smart = (SmartTags) tags;
      return !smart.getDirectTags().contains(id) && smart.getImpliedTags().contains(id);
    }
    catch (Exception e)
    {
      return false;
    }
  }

  private Object dataValueToWire(BIDataValue value)
  {
    if (value == null || value instanceof BMarker)
    {
      return null;
    }
    if (value instanceof BBoolean)
    {
      return Boolean.valueOf(((BBoolean) value).getBoolean());
    }
    if (value instanceof BLong)
    {
      return Long.valueOf(((BLong) value).getLong());
    }
    if (value instanceof BDouble)
    {
      return Double.valueOf(((BDouble) value).getDouble());
    }
    if (value instanceof BString)
    {
      return ((BString) value).getString();
    }
    return value.toString();
  }

  private BIDataValue toDataValue(Object value, String valueType) throws BaskStreamProtocolException
  {
    if (valueType != null && valueType.trim().length() > 0)
    {
      String kind = valueType.trim().toLowerCase();
      if ("marker".equals(kind))
      {
        return BMarker.MARKER;
      }
      if ("string".equals(kind))
      {
        return BString.make(value == null ? "" : String.valueOf(value));
      }
      if ("boolean".equals(kind) || "bool".equals(kind))
      {
        if (value instanceof Boolean)
        {
          return BBoolean.make(((Boolean) value).booleanValue());
        }
        return BBoolean.make(Boolean.parseBoolean(String.valueOf(value)));
      }
      if ("double".equals(kind) || "number".equals(kind))
      {
        return BDouble.make(requireNumber(value).doubleValue());
      }
      if ("long".equals(kind) || "int".equals(kind) || "integer".equals(kind))
      {
        return BLong.make(requireNumber(value).longValue());
      }
      throw new BaskStreamProtocolException("bad_request",
          "Unsupported tag valueType '" + valueType + "'. Use marker, string, boolean, double, or long.");
    }

    if (value == null)
    {
      return BMarker.MARKER;
    }
    if (value instanceof Boolean)
    {
      return BBoolean.make(((Boolean) value).booleanValue());
    }
    if (value instanceof Number)
    {
      // Numbers default to BDouble to match Niagara's Haystack number tags; pass
      // valueType "long" when an integral tag value is required.
      return BDouble.make(((Number) value).doubleValue());
    }
    if (value instanceof String)
    {
      return BString.make((String) value);
    }
    throw new BaskStreamProtocolException("bad_request",
        "Tag 'value' must be null (marker), boolean, number, or string.");
  }

  private Number requireNumber(Object value) throws BaskStreamProtocolException
  {
    if (value instanceof Number)
    {
      return (Number) value;
    }
    if (value instanceof String)
    {
      try
      {
        return Double.valueOf(Double.parseDouble(((String) value).trim()));
      }
      catch (NumberFormatException ignored)
      {
        // fall through to the protocol error below
      }
    }
    throw new BaskStreamProtocolException("bad_request", "Tag 'value' must be numeric for this valueType.");
  }

  // ---------------------------------------------------------------- resolution

  private BComponent resolveReadable(String ord, Context context) throws BaskStreamProtocolException
  {
    OrdTarget target = resolveTarget(ord, context);
    if (!target.canRead())
    {
      throw new BaskStreamProtocolException("forbidden_point", "Target is not readable for the authenticated user.");
    }
    return componentOf(target);
  }

  private BComponent resolveWritable(String ord, Context context) throws BaskStreamProtocolException
  {
    OrdTarget target = resolveTarget(ord, context);
    if (!target.canRead())
    {
      throw new BaskStreamProtocolException("forbidden_point", "Target is not readable for the authenticated user.");
    }
    // Tag and relation edits change the component model itself, so mirror Workbench
    // semantics and require admin write rather than operator write.
    boolean adminWrite;
    try
    {
      adminWrite = target.canWrite() && target.getPermissionsForTarget().hasAdminWrite();
    }
    catch (Exception e)
    {
      adminWrite = false;
    }
    if (!adminWrite)
    {
      throw new BaskStreamProtocolException("forbidden_point",
          "Tag/relation writes require admin write permission on the target component.");
    }
    return componentOf(target);
  }

  private OrdTarget resolveTarget(String ord, Context context) throws BaskStreamProtocolException
  {
    if (ord == null || ord.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("invalid_point", "Target ORD cannot be blank.");
    }
    if (!ord.startsWith("slot:/"))
    {
      throw new BaskStreamProtocolException("invalid_point", "Tag operations support slot:/ ORDs only.");
    }
    if (!BaskStreamAccessPolicy.isAllowed(service, ord))
    {
      throw new BaskStreamProtocolException("forbidden_point", "Target is outside the allowedPathPatterns policy.");
    }
    try
    {
      return BOrd.make(ord).resolve(service, context);
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("invalid_point",
          e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private BComponent componentOf(OrdTarget target) throws BaskStreamProtocolException
  {
    BObject object = target.get();
    BComponent component = object instanceof BComponent ? (BComponent) object : target.getComponent();
    if (component == null)
    {
      throw new BaskStreamProtocolException("invalid_point", "Target did not resolve to a component.");
    }
    return component;
  }

  // ---------------------------------------------------------------- request shaping

  private List<String> normalizeOrds(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object raw = request.get("ords");
    if (raw instanceof List)
    {
      List<?> rawList = (List<?>) raw;
      requireMaxTargets(rawList.size());
      List<String> ords = new ArrayList<String>(rawList.size());
      for (Object entry : rawList)
      {
        if (!(entry instanceof String))
        {
          throw new BaskStreamProtocolException("bad_request", "Field 'ords' must be an array of ORD strings.");
        }
        ords.add((String) entry);
      }
      return ords;
    }

    String ord = optionalString(request, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'ord' or 'ords' is required.");
    }
    List<String> single = new ArrayList<String>(1);
    single.add(ord);
    return single;
  }

  private List<Map<String, Object>> normalizeSpecs(Map<String, Object> request) throws BaskStreamProtocolException
  {
    Object raw = request.get("targets");
    if (raw == null)
    {
      List<Map<String, Object>> single = new ArrayList<Map<String, Object>>(1);
      single.add(request);
      return single;
    }
    if (!(raw instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field 'targets' must be an array of write objects.");
    }
    List<?> rawList = (List<?>) raw;
    requireMaxTargets(rawList.size());
    List<Map<String, Object>> specs = new ArrayList<Map<String, Object>>(rawList.size());
    for (Object entry : rawList)
    {
      if (!(entry instanceof Map))
      {
        throw new BaskStreamProtocolException("bad_request", "Field 'targets' must be an array of write objects.");
      }
      specs.add(castMap(entry));
    }
    return specs;
  }

  private void requireMaxTargets(int size) throws BaskStreamProtocolException
  {
    if (size > MAX_TARGETS_PER_REQUEST)
    {
      throw new BaskStreamProtocolException("bad_request",
          "Tag operations cannot address more than " + MAX_TARGETS_PER_REQUEST + " targets per request.");
    }
  }

  private String specOrd(Map<String, Object> spec)
  {
    String ord = optionalString(spec, "ord");
    if (ord == null || ord.trim().length() == 0)
    {
      ord = optionalString(spec, "point");
    }
    return ord;
  }

  private String tagName(Map<String, Object> spec)
  {
    String qname = optionalString(spec, "id");
    if (qname == null || qname.trim().length() == 0)
    {
      qname = optionalString(spec, "name");
    }
    return qname;
  }

  private Id parseId(String qname) throws BaskStreamProtocolException
  {
    if (qname == null || qname.trim().length() == 0)
    {
      throw new BaskStreamProtocolException("bad_request", "Tag/relation 'id' is required (e.g. \"hs:site\").");
    }
    try
    {
      return Id.newId(qname.trim());
    }
    catch (Exception e)
    {
      throw new BaskStreamProtocolException("bad_request", "Invalid tag/relation id '" + qname + "': "
          + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
  }

  private String normalizeDictionary(String dictionary)
  {
    if (dictionary == null || dictionary.trim().length() == 0)
    {
      return null;
    }
    String normalized = dictionary.trim();
    return normalized.endsWith(":") ? normalized.substring(0, normalized.length() - 1) : normalized;
  }

  private Map<String, Object> baseEntry(String ord, BComponent component, Context context)
  {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put("ord", ord);
    entry.put("ok", Boolean.TRUE);
    entry.put("slotPath", component.getSlotPath() == null ? null : component.getSlotPath().toString());
    entry.put("display", component.getDisplayName(context));
    entry.put("typeSpec", component.getType().toString());
    return entry;
  }

  private Map<String, Object> errorEntry(String ord, String code, String message)
  {
    Map<String, Object> error = new LinkedHashMap<String, Object>();
    error.put("ord", ord);
    error.put("ok", Boolean.FALSE);
    error.put("code", code);
    error.put("message", message);
    return error;
  }

  private List<Map<String, Object>> optionalMapList(Map<String, Object> request, String key)
      throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null)
    {
      return null;
    }
    if (!(value instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of objects.");
    }
    List<?> raw = (List<?>) value;
    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>(raw.size());
    for (Object entry : raw)
    {
      if (!(entry instanceof Map))
      {
        throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array of objects.");
      }
      out.add(castMap(entry));
    }
    return out;
  }

  private List<Object> optionalList(Map<String, Object> request, String key) throws BaskStreamProtocolException
  {
    Object value = request.get(key);
    if (value == null)
    {
      return null;
    }
    if (!(value instanceof List))
    {
      throw new BaskStreamProtocolException("bad_request", "Field '" + key + "' must be an array.");
    }
    return new ArrayList<Object>((List<?>) value);
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> castMap(Object value)
  {
    return (Map<String, Object>) value;
  }

  private static String optionalString(Map<String, Object> request, String key)
  {
    Object value = request.get(key);
    return value instanceof String ? (String) value : null;
  }
}
