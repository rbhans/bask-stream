package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.baja.naming.BOrd;
import javax.baja.naming.OrdTarget;
import javax.baja.registry.TypeInfo;
import javax.baja.security.AuditEvent;
import javax.baja.security.Auditor;
import javax.baja.security.BPassword;
import javax.baja.sys.Action;
import javax.baja.sys.BComponent;
import javax.baja.sys.BComplex;
import javax.baja.sys.BFacets;
import javax.baja.sys.BLink;
import javax.baja.sys.BObject;
import javax.baja.sys.BRelation;
import javax.baja.sys.BSimple;
import javax.baja.sys.BValue;
import javax.baja.sys.Context;
import javax.baja.sys.CopyHints;
import javax.baja.sys.Flags;
import javax.baja.sys.LinkCheck;
import javax.baja.sys.Property;
import javax.baja.sys.Slot;
import javax.baja.sys.Sys;
import javax.baja.sys.Type;
import static com.basidekick.baskstream.BaskStreamModelPlans.map;
import static com.basidekick.baskstream.BaskStreamModelPlans.error;

/** Typed station-model editing through public Baja APIs. No shell, reflection or fw calls. */
final class BaskStreamModelResolver
{
  static final int MAX_CHANGES = 100;
  static final int MAX_TREE_VALUES = 5000;
  static final String[] ACTIONS = { "create", "update", "rename", "move", "delete", "clone",
      "create_hierarchy", "configure_hierarchy", "add_slot", "remove_slot", "set_slot_metadata",
      "reorder", "create_link", "delete_link", "invoke" };
  private final BBaskStreamService service;
  private final BaskStreamModelPlans plans = new BaskStreamModelPlans();
  private final ThreadLocal<Context> applyingContext = new ThreadLocal<Context>();
  // Keep value commitments opaque, including low-entropy credentials in redacted diffs.
  private final String fingerprintKey = java.util.UUID.randomUUID().toString();

  BaskStreamModelResolver(BBaskStreamService service) { this.service = service; }

  Map<String, Object> types(Map<String, Object> request, Context cx) throws Exception
  {
    String requested = optional(request, "typeSpec");
    if (requested != null)
    {
      requireLoadable(requested);
      Type type = Sys.getType(requested);
      Map<String, Object> result = typeInfo(type.getTypeInfo(), cx);
      if (!type.isAbstract() && !type.isInterface() && type.is(BComplex.TYPE))
      {
        BObject instance = type.getInstance();
        if (instance instanceof BComplex) result.put("slots", slots((BComplex)instance, null, cx));
      }
      return result;
    }
    String module = optional(request, "module");
    String base = optional(request, "baseType");
    TypeInfo baseType = Sys.getRegistry().getType(base == null ? "baja:Component" : base);
    if (baseType == null) throw error("unknown_type", "Unknown baseType.");
    List<TypeInfo> found = new ArrayList<TypeInfo>();
    for (TypeInfo type : Sys.getRegistry().getTypes(baseType))
      if (module == null || module.equals(type.getModuleName())) found.add(type);
    Collections.sort(found, Comparator.comparing(t -> t.getTypeSpec().toString()));
    int offset = integer(request, "offset", 0, 0, 1000000);
    int limit = integer(request, "limit", 100, 1, 500);
    List<Object> page = new ArrayList<Object>();
    for (int i = offset; i < found.size() && page.size() < limit; i++) page.add(typeInfo(found.get(i), cx));
    return map("types", page, "total", found.size(), "nextOffset", offset + page.size() < found.size() ? offset + page.size() : null);
  }

  private Map<String, Object> typeInfo(TypeInfo type, Context cx)
  {
    return map("typeSpec", type.getTypeSpec().toString(), "module", type.getModuleName(),
        "abstract", type.isAbstract(), "interface", type.isInterface(), "component", type.is(BComponent.TYPE),
        "superType", type.getSuperType() == null ? null : type.getSuperType().getTypeSpec().toString(),
        "runtimeProfile", type.getRuntimeProfile().toString());
  }

  Map<String, Object> describe(Map<String, Object> request, Context cx) throws Exception
  {
    String ord = required(request, "ord");
    BComplex target = complex(ord, cx, false);
    Map<String, Object> result = summary(target, ord);
    result.put("slots", slots(target, ord, cx));
    if (target instanceof BComponent) result.put("dependencies", dependencies((BComponent)target, cx, false));
    result.put("writesEnabled", service.writesAllowed());
    result.put("modelEditsEnabled", service.modelEditsAllowed());
    return result;
  }

  private List<Object> slots(BComplex c, String ord, Context cx) throws Exception
  {
    List<Object> result = new ArrayList<Object>();
    Slot[] available = c.getSlotsArray();
    if (available.length > MAX_TREE_VALUES) throw error("model_limit", "Component has too many slots to describe in one response.");
    for (Slot slot : available)
    {
      OrdTarget resolved = null;
      if (ord != null)
      {
        try { resolved = target(child(ord, slot.getName()), cx, false); }
        catch (Exception e) { continue; }
      }
      Map<String, Object> wire = map("name", slot.getName(), "kind", slot.isProperty() ? "property" : slot.isAction() ? "action" : "topic",
          "dynamic", slot.isDynamic(), "flags", c.getFlags(slot), "facets", c.getSlotFacets(slot).encodeToString());
      if (slot.isProperty())
      {
        Property p = slot.asProperty();
        wire.put("typeSpec", p.getType().toString());
        wire.put("writable", resolved != null && resolved.canWrite() && resolved.getPermissionsForTarget().hasAdminWrite());
        wire.put("value", valueWire(c.get(p), slot.getName(), 0, ord == null ? null : child(ord, slot.getName()), cx));
      }
      if (slot.isAction())
      {
        Action a = slot.asAction();
        wire.put("parameterType", a.getParameterType() == null ? null : a.getParameterType().toString());
        wire.put("returnType", a.getReturnType() == null ? null : a.getReturnType().toString());
        wire.put("parameterDefault", valueWire(a.getParameterDefault(), slot.getName(), 0));
        wire.put("invokable", resolved != null && resolved.canInvoke());
      }
      result.add(wire);
    }
    return result;
  }

  Map<String, Object> preview(Map<String, Object> request, Context cx) throws Exception
  {
    Preparation prep = new Preparation(cx);
    List<Map<String, Object>> changes = objects(request.get("changes"), "changes");
    if (changes.isEmpty() || changes.size() > MAX_CHANGES) throw error("bad_request", "Use 1 to 100 changes per plan.");
    for (Map<String, Object> change : changes) prep.prepare(change);
    List<Object> diffs = new ArrayList<Object>();
    for (BaskStreamModelPlans.Step step : prep.steps) diffs.add(step.diff);
    if (new BaskStreamCodec().encodeMessage(map("changes", diffs)).length > service.getMaxMessageBytesValue() / 2)
      throw error("model_limit", "Preview is too large; submit a smaller batch.");
    return plans.preview(principal(cx), prep.steps, prep::check, audit(cx), System.currentTimeMillis());
  }

  Map<String, Object> apply(Map<String, Object> request, Context cx) throws Exception
  {
    applyingContext.set(cx);
    try
    {
      return plans.apply(principal(cx), required(request, "planId"), required(request, "planHash"),
          required(request, "idempotencyKey"), service::requireModelEditsEnabled, audit(cx), System.currentTimeMillis());
    }
    finally { applyingContext.remove(); }
  }

  Map<String, Object> status(Map<String, Object> request, Context cx) throws Exception
  { return plans.status(principal(cx), required(request, "planId"), System.currentTimeMillis()); }
  Map<String, Object> cancel(Map<String, Object> request, Context cx) throws Exception
  { return plans.cancel(principal(cx), required(request, "planId"), System.currentTimeMillis()); }

  private String principal(Context cx)
  { return cx.getUser().getUsername() + ":" + String.valueOf(cx.getUser().getHandle()); }

  private BaskStreamModelPlans.Audit audit(final Context cx)
  {
    return (event, plan, detail) -> {
      String user = cx.getUser().getUsername();
      service.audit(event, "user=" + clean(user) + " plan=" + plan + " " + clean(String.valueOf(detail)));
      Auditor auditor = Sys.getAuditor();
      if (auditor != null) auditor.audit(new AuditEvent(event, service.getSlotPathOrd().toString(), plan, null, clean(String.valueOf(detail)), user));
    };
  }

  private final class Preparation
  {
    Context cx;
    final Object principalHandle;
    final List<BaskStreamModelPlans.Step> steps = new ArrayList<BaskStreamModelPlans.Step>();
    final List<BaskStreamModelPlans.Check> checks = new ArrayList<BaskStreamModelPlans.Check>();
    final Map<String, BComponent> refs = new HashMap<String, BComponent>();
    final Map<BComponent, String> futureOrds = new HashMap<BComponent, String>();
    final Set<String> reservations = new HashSet<String>();
    final Set<String> touched = new HashSet<String>();
    final List<String> structuralRoots = new ArrayList<String>();
    Preparation(Context cx) { this.cx = cx; this.principalHandle = cx.getUser().getHandle(); }

    void check() throws Exception
    {
      Context fresh = applyingContext.get();
      if (fresh == null || !java.util.Objects.equals(principalHandle, fresh.getUser().getHandle()))
        throw error("stale_plan", "Authenticated principal changed since preview.");
      cx = fresh;
      for (BaskStreamModelPlans.Check check : checks) check.run();
    }

    BComponent component(String ord, boolean write) throws Exception
    {
      if (ord.startsWith("@"))
      {
        BComponent ref = refs.get(ord.substring(1));
        if (ref == null) throw error("bad_reference", "Reference must identify an earlier create/clone action.");
        return ref;
      }
      for (String root : structuralRoots)
        if (within(ord, root)) throw error("plan_dependency", "Use a separate preview after a move, rename, or delete of this branch.");
      BComplex c = complex(ord, cx, write);
      if (!(c instanceof BComponent)) throw error("invalid_component", "Expected a component ORD.");
      BComponent b = (BComponent)c;
      checks.add(() -> { if (complex(ord, cx, write) != b) throw error("stale_plan", "Target component identity changed: " + ord); });
      return b;
    }

    String ord(BComponent c) { return futureOrds.containsKey(c) ? futureOrds.get(c) : c.getSlotPathOrd().toString(); }

    void touch(String path) throws Exception
    {
      for (String prior : touched)
        if (within(path, prior) || within(prior, path))
          throw error("plan_conflict", "Overlapping property edits require separate previews: " + path);
      touched.add(path);
    }

    void guard(BComponent c, boolean write) throws Exception
    {
      String path = ord(c);
      if (complex(path, cx, write) != c) throw error("stale_plan", "Target changed: " + path);
    }

    void unchanged(BComplex owner, Property p) throws Exception
    {
      final BValue before = owner.get(p).newCopy(true);
      final int flags = owner.getFlags(p);
      final BFacets facets = owner.getSlotFacets(p);
      checks.add(() -> {
        if (owner.getProperty(p.getName()) != p || !before.equivalent(owner.get(p)) || flags != owner.getFlags(p) || !facets.equals(owner.getSlotFacets(p)))
          throw error("stale_plan", "Property changed since preview: " + p.getName());
      });
    }

    String reserve(BComponent parent, String requested, String collision) throws Exception
    {
      name(requested);
      String candidate = requested;
      int suffix = 2;
      while (parent.getSlot(candidate) != null || reservations.contains(child(ord(parent), candidate)))
      {
        if (!"suffix".equals(collision)) throw error("name_conflict", "Slot already exists: " + child(ord(parent), candidate));
        if (suffix > 10000) throw error("name_conflict", "Could not allocate a slot name.");
        candidate = requested + suffix++;
      }
      String result = candidate;
      String path = child(ord(parent), result);
      scope(path);
      reservations.add(path);
      checks.add(() -> { if (parent.getSlot(result) != null) throw error("stale_plan", "Destination slot is now occupied: " + path); });
      return result;
    }

    void prepare(Map<String, Object> change) throws Exception
    {
      String action = required(change, "action");
      if (!Arrays.asList(ACTIONS).contains(action)) throw error("unsupported_action", "Unknown model action: " + action);
      String collision = optional(change, "collision");
      if (collision != null && !"fail".equals(collision) && !"suffix".equals(collision)) throw error("bad_request", "collision must be fail or suffix.");
      if ("create".equals(action) || "clone".equals(action) || "create_hierarchy".equals(action)) { create(change, action); return; }
      if ("create_link".equals(action)) { link(change); return; }
      String targetOrd = required(change, "ord");
      BComponent c = component(targetOrd, true);
      if ("update".equals(action) || "configure_hierarchy".equals(action)) { update(change, c, action); return; }
      if ("invoke".equals(action)) { invoke(change, c); return; }
      if ("rename".equals(action) || "move".equals(action) || "delete".equals(action)) { structure(change, c, action); return; }
      if ("reorder".equals(action)) { reorder(change, c); return; }
      slotChange(change, c, action);
    }

    void create(Map<String, Object> change, String action) throws Exception
    {
      BComponent parent = component(required(change, "parent"), true);
      String slotName = reserve(parent, required(change, "name"), optional(change, "collision"));
      BComponent value;
      if ("clone".equals(action))
      {
        BComponent source = component(required(change, "source"), false);
        verifyTree(source, cx, false, new int[]{0});
        if (containsProtected(source, 0))
          throw error("protected_component", "Protected services and program components cannot be created or copied remotely; use Workbench.");
        // A copy keeps the stored passwords; a reader must not be able to re-point them.
        if (holdsPassword(source, 0, new int[]{0}) && !target(ord(source), cx, false).getPermissionsForTarget().hasAdminWrite())
          throw error("forbidden_component", "Copying components that hold passwords requires admin write on the source.");
        BValue baseline = source.newCopy(true);
        checks.add(() -> { verifyTree(source, cx, false, new int[]{0}); if (!baseline.equivalent(source)) throw error("stale_plan", "Clone source changed."); });
        CopyHints hints = new CopyHints(); hints.cx = cx; hints.keepHandles = false; hints.swizzleHandles = true;
        value = (BComponent)source.newCopy(hints);
      }
      else
      {
        String type = "create_hierarchy".equals(action) ? "hierarchy:Hierarchy" : required(change, "typeSpec");
        value = newComponent(type);
      }
      final BComponent created = value;
      if (containsProtected(created, 0))
        throw error("protected_component", "Protected services and program components cannot be created or copied remotely; use Workbench.");
      if (change.containsKey("properties")) setDetached(created, object(change.get("properties"), "properties"), cx, 0);
      final int flags = integer(change, "flags", 0, 0, Integer.MAX_VALUE);
      final BFacets facets = facets(change.get("facets"));
      legalAdd(parent, slotName, created, flags, facets, cx);
      String future = child(ord(parent), slotName);
      futureOrds.put(created, future);
      String ref = optional(change, "ref");
      if (ref != null)
      {
        name(ref);
        if (refs.putIfAbsent(ref, created) != null) throw error("bad_reference", "Duplicate ref: " + ref);
      }
      Map<String, Object> diff = map("action", action, "parent", ord(parent), "name", slotName, "ord", future,
          "ref", ref, "typeSpec", created.getType().toString(), "after", snapshotDetached(created, 0, new int[]{0}),
          "valueHash", fingerprint(created, 0, new int[]{0}));
      steps.add(new BaskStreamModelPlans.Step(diff, () -> {
        guard(parent, true);
        if (parent.getSlot(slotName) != null) throw error("stale_plan", "Destination slot is occupied.");
        legalAdd(parent, slotName, created, flags, facets, cx);
        service.requireModelEditsEnabled();
        parent.add(slotName, created, flags, facets, cx);
        return map("ord", created.getSlotPathOrd().toString(), "handleOrd", created.getHandleOrd().toString(), "snapshot", after(created, cx));
      }));
    }

    void update(Map<String, Object> change, BComponent c, String action) throws Exception
    {
      if ("configure_hierarchy".equals(action) && !c.getType().is(Sys.getType("hierarchy:Hierarchy")))
        throw error("invalid_component", "configure_hierarchy requires hierarchy:Hierarchy.");
      Map<String, Object> values = object(change.get("properties"), "properties");
      if (values.isEmpty() || values.size() > MAX_CHANGES) throw error("bad_request", "Use 1 to 100 property values.");
      final List<BaskStreamModelPlans.Work> writes = new ArrayList<BaskStreamModelPlans.Work>();
      List<Object> edits = new ArrayList<Object>();
      for (Map.Entry<String, Object> entry : values.entrySet())
      {
        final String path = entry.getKey();
        String key = child(ord(c), path);
        touch(key);
        PropertyTarget pt = property(c, path);
        BaskStreamModelPlans.Check identity = () -> {
          PropertyTarget current = property(c, path);
          if (current.owner != pt.owner || current.property != pt.property) throw error("stale_plan", "Property owner changed: " + path);
        };
        checks.add(identity);
        if (!futureOrds.containsKey(c)) target(key, cx, true);
        if (Flags.isReadonly(pt.owner, pt.property)) throw error("readonly", "Property is read-only: " + path);
        final BValue old = pt.owner.get(pt.property).newCopy(true);
        if (old instanceof BComplex && !futureOrds.containsKey(c))
        {
          verifyValues((BComplex)old, key, cx, false, new int[]{0}, 0);
          checks.add(() -> verifyValues((BComplex)pt.owner.get(pt.property), key, cx, false, new int[]{0}, 0));
        }
        final BValue value = decode(entry.getValue(), pt.property.getType(), cx, 0);
        if (value instanceof BComponent || old instanceof BComponent) throw error("bad_request", "Edit child components through their own ORD; use create/delete for component slots.");
        javax.baja.sys.IPropertyValidator validator = pt.owner.getPropertyValidator(pt.property, cx);
        if (validator != null) validator.validateSet(pt.owner, pt.property, value, cx);
        if (!futureOrds.containsKey(c)) unchanged(pt.owner, pt.property);
        edits.add(map("property", path, "before", valueWire(old, path, 0), "after", valueWire(value, path, 0), "valueHash", fingerprint(value, 0, new int[]{0})));
        writes.add(() -> {
          guard(c, true); target(key, cx, true); identity.run();
          if (!old.equivalent(pt.owner.get(pt.property))) throw error("stale_plan", "Property changed: " + path);
          service.requireModelEditsEnabled();
          pt.owner.set(pt.property, value.newCopy(true), cx);
          BValue now = pt.owner.get(pt.property);
          Map<String, Object> written = map("property", path, "value", valueWire(now, path, 0, key, cx));
          // Some components undo a change they cannot act on (a driver that may not open its socket,
          // for example). Report it rather than letting the plan read as a clean success.
          if (!value.equivalent(now)) written.put("reverted", Boolean.TRUE);
          return written;
        });
      }
      steps.add(new BaskStreamModelPlans.Step(map("action", action, "ord", ord(c), "properties", edits), () -> {
        List<Object> results = new ArrayList<Object>();
        for (int index = 0; index < writes.size(); index++)
        {
          try { results.add(writes.get(index).run()); }
          catch (Exception failure)
          {
            results.add(map("property", ((Map<?, ?>)edits.get(index)).get("property"), "ok", false, "outcome", "unknown_or_partial"));
            return map("ord", ord(c), "ok", false, "properties", results, "unattemptedProperties", writes.size() - index - 1,
                "code", failure instanceof BaskStreamProtocolException ? ((BaskStreamProtocolException)failure).getCode() : "model_change_failed");
          }
        }
        Map<String, Object> done = map("ord", ord(c), "properties", results, "snapshot", after(c, cx));
        for (Object result : results) if (Boolean.TRUE.equals(((Map<?, ?>)result).get("reverted"))) done.put("reverted", Boolean.TRUE);
        return done;
      }));
    }

    void invoke(Map<String, Object> change, BComponent c) throws Exception
    {
      String slotName = required(change, "slot"); name(slotName);
      Action action = c.getAction(slotName);
      if (action == null) throw error("invalid_action", "No such action.");
      if (withinProtected(c))
        throw error("protected_component", "Actions on protected services must be invoked in Workbench.");
      final boolean confirmRequired = Flags.isConfirmRequired(c, action);
      if (confirmRequired && !Boolean.TRUE.equals(change.get("confirm")))
        throw error("confirm_required", "Niagara marks '" + slotName + "' as needing confirmation; resend this change with confirm: true.");
      String actionOrd = child(ord(c), slotName);
      if (!futureOrds.containsKey(c)) requireInvoke(actionOrd, cx);
      BValue parameter = action.getParameterType() == null ? null : change.containsKey("parameter")
          ? decode(change.get("parameter"), action.getParameterType(), cx, 0) : c.getActionParameterDefault(action);
      if (action.getParameterType() == null && change.containsKey("parameter")) throw error("bad_request", "This action takes no parameter.");
      final BValue argument = parameter == null ? null : parameter.newCopy(true);
      checks.add(() -> { if (c.getAction(slotName) != action) throw error("stale_plan", "Action changed since preview."); });
      steps.add(new BaskStreamModelPlans.Step(map("action", "invoke", "ord", ord(c), "slot", slotName,
          "parameter", valueWire(argument, slotName, 0), "parameterHash", fingerprint(argument, 0, new int[]{0}),
          "effectPreview", "Invocation only; vendor action side effects cannot be simulated", "async", Flags.isAsync(c, action),
          "confirmRequired", confirmRequired), () -> {
        guard(c, true); requireInvoke(actionOrd, cx);
        if (c.getAction(slotName) != action) throw error("stale_plan", "Action changed before apply.");
        service.requireModelEditsEnabled();
        BValue returned = c.invoke(action, argument, cx);
        return map("ord", ord(c), "outcome", Flags.isAsync(c, action) ? "submitted" : "invoked", "returnValue", valueWire(returned, slotName, 0));
      }));
    }

    void structure(Map<String, Object> change, BComponent c, String action) throws Exception
    {
      if (futureOrds.containsKey(c)) throw error("plan_dependency", "Move/rename/delete newly created objects in a subsequent plan.");
      String oldOrd = ord(c);
      for (String root : structuralRoots) if (within(root, oldOrd)) throw error("plan_conflict", "Overlapping structural edits must use separate plans.");
      for (String path : touched) if (within(path, oldOrd)) throw error("plan_conflict", "Do not combine structural and property edits of one branch.");
      for (String path : reservations) if (within(path, oldOrd)) throw error("plan_conflict", "Do not combine structural edits with creations in the same branch.");
      verifyTree(c, cx, true, new int[]{0});
      final BComponent parent = c.getParentComponent();
      final Property slot = c.getPropertyInParent();
      if (parent == null || c.getParent() != parent || slot == null || !slot.isDynamic()) throw error("frozen_slot", "Only dynamic child components can be moved, renamed, or deleted.");
      component(parent.getSlotPathOrd().toString(), true);
      final String oldName = slot.getName();
      final int flags = parent.getFlags(slot);
      final BFacets facets = parent.getSlotFacets(slot);
      final Object before = snapshotDetached(c, 0, new int[]{0});
      final String baseline = fingerprint(c, 0, new int[]{0});
      final Object dependenciesBefore = dependencies(c, cx, true);
      final String dependencyHash = BaskStreamModelPlans.digest(dependenciesBefore);
      checks.add(() -> { verifyTree(c, cx, true, new int[]{0}); if (!baseline.equals(fingerprint(c, 0, new int[]{0}))) throw error("stale_plan", "Branch changed: " + oldOrd); });
      checks.add(() -> { if (!dependencyHash.equals(BaskStreamModelPlans.digest(dependencies(c, cx, true)))) throw error("stale_plan", "Known references changed since preview."); });
      final BComponent destination = "move".equals(action) ? component(required(change, "parent"), true) : parent;
      if (destination == c || destination.isDescendentOf(c)) throw error("cycle", "Cannot move a component into its own subtree.");
      final String newName = "delete".equals(action) ? oldName : reserve(destination, optional(change, "name") == null ? oldName : required(change, "name"), optional(change, "collision"));
      if ("delete".equals(action) && !Boolean.TRUE.equals(change.get("recursive")) && c.getChildComponents().length > 0)
        throw error("children_present", "Deleting a branch requires recursive=true.");
      if ("rename".equals(action)) parent.checkRename(slot, newName, cx);
      else parent.checkRemove(slot, cx);
      if ("move".equals(action)) legalAdd(destination, newName, c, flags, facets, cx);
      structuralRoots.add(oldOrd);
      steps.add(new BaskStreamModelPlans.Step(map("action", action, "ord", oldOrd, "destination", "delete".equals(action) ? null : child(ord(destination), newName),
          "before", before, "beforeHash", baseline, "dependencies", dependenciesBefore, "references", "Path-based references outside this branch are not rewritten; handle references retain identity on move"), () -> {
        guard(c, true); guard(parent, true); guard(destination, true); verifyTree(c, cx, true, new int[]{0});
        if (!baseline.equals(fingerprint(c, 0, new int[]{0}))) throw error("stale_plan", "Branch changed before apply.");
        service.requireModelEditsEnabled();
        if ("delete".equals(action)) parent.remove(slot, cx);
        else if ("rename".equals(action)) parent.rename(slot, newName, cx);
        else
        {
          if (destination.getSlot(newName) != null) throw error("stale_plan", "Destination is occupied.");
          c.setPendingMove(true);
          try
          {
            parent.remove(slot, cx);
            try { service.requireModelEditsEnabled(); destination.add(newName, c, flags, facets, cx); }
            catch (Exception failure)
            {
              // Restore the detached original if destination adoption failed. This is
              // completion of the interrupted move, not rollback of the whole batch.
              if (c.getParent() == null && parent.getSlot(oldName) == null) parent.add(oldName, c, flags, facets, cx);
              throw failure;
            }
          }
          finally { c.setPendingMove(false); }
        }
        return "delete".equals(action) ? map("deletedOrd", oldOrd) : map("oldOrd", oldOrd, "ord", c.getSlotPathOrd().toString(),
            "handleOrd", c.getHandleOrd().toString(), "snapshot", after(c, cx));
      }));
    }

    void link(Map<String, Object> change) throws Exception
    {
      BComponent source = component(required(change, "source"), false);
      BComponent dest = component(required(change, "target"), true);
      String sourceSlot = required(change, "sourceSlot"), targetSlot = required(change, "targetSlot");
      Slot from = source.getSlot(sourceSlot), to = dest.getSlot(targetSlot);
      if (from == null || to == null) throw error("invalid_slot", "Link endpoints must name existing slots.");
      BaskStreamModelPlans.Check endpoints = () -> {
        if (source.getSlot(sourceSlot) != from || dest.getSlot(targetSlot) != to) throw error("stale_plan", "Link endpoint slots changed.");
      };
      checks.add(endpoints);
      if (!futureOrds.containsKey(source)) target(child(ord(source), sourceSlot), cx, false);
      if (!futureOrds.containsKey(dest)) target(child(ord(dest), targetSlot), cx, true);
      LinkCheck check = dest.checkLink(source, from, to, cx);
      if (!check.isValid()) throw error("invalid_link", check.getInvalidReason());
      String slotName = reserve(dest, required(change, "name"), optional(change, "collision"));
      steps.add(new BaskStreamModelPlans.Step(map("action", "create_link", "source", ord(source), "sourceSlot", sourceSlot,
          "target", ord(dest), "targetSlot", targetSlot, "name", slotName), () -> {
        guard(source, false); guard(dest, true); endpoints.run();
        target(child(ord(source), sourceSlot), cx, false); target(child(ord(dest), targetSlot), cx, true);
        LinkCheck fresh = dest.checkLink(source, from, to, cx);
        if (!fresh.isValid()) throw error("invalid_link", fresh.getInvalidReason());
        if (dest.getSlot(slotName) != null) throw error("stale_plan", "Link name is occupied.");
        BLink value = dest.makeLink(source, from, to, cx);
        service.requireModelEditsEnabled(); dest.add(slotName, value, cx);
        return map("ord", child(ord(dest), slotName), "snapshot", after(dest, cx));
      }));
    }

    void reorder(Map<String, Object> change, BComponent c) throws Exception
    {
      List<?> names = list(change.get("slots"), "slots");
      Property[] before = c.getDynamicPropertiesArray();
      if (names.size() != before.length) throw error("bad_request", "List each dynamic property exactly once.");
      Property[] order = new Property[names.size()]; Set<String> seen = new HashSet<String>();
      for (int i = 0; i < names.size(); i++)
      {
        String n = String.valueOf(names.get(i)); Property p = c.getProperty(n);
        if (!seen.add(n) || p == null || !p.isDynamic()) throw error("bad_request", "Invalid reorder slot.");
        order[i] = p;
      }
      c.checkReorder(order, cx);
      checks.add(() -> { if (!Arrays.equals(before, c.getDynamicPropertiesArray())) throw error("stale_plan", "Slot order changed."); });
      List<String> beforeNames = new ArrayList<String>();
      for (Property p : before) beforeNames.add(p.getName());
      steps.add(new BaskStreamModelPlans.Step(map("action", "reorder", "ord", ord(c), "beforeSlots", beforeNames, "slots", names), () -> {
        guard(c, true);
        if (!Arrays.equals(before, c.getDynamicPropertiesArray())) throw error("stale_plan", "Slot order changed before apply.");
        service.requireModelEditsEnabled(); c.reorder(order, cx);
        return map("ord", ord(c), "snapshot", after(c, cx));
      }));
    }

    void slotChange(Map<String, Object> change, BComponent c, String action) throws Exception
    {
      String slotName = required(change, "slot"); name(slotName);
      String path = child(ord(c), slotName);
      touch(path);
      if ("add_slot".equals(action))
      {
        reserve(c, slotName, "fail");
        BValue value = decode(change.get("value"), null, cx, 0);
        if (value instanceof BComponent) throw error("bad_request", "Use create for component-valued slots.");
        int flags = integer(change, "flags", 0, 0, Integer.MAX_VALUE); BFacets facets = facets(change.get("facets"));
        c.checkAdd(slotName, value, flags, facets, cx);
        steps.add(new BaskStreamModelPlans.Step(map("action", action, "ord", ord(c), "slot", slotName, "after", valueWire(value, slotName, 0), "valueHash", fingerprint(value, 0, new int[]{0}), "flags", flags, "facets", facets.encodeToString()), () -> {
          guard(c, true); if (c.getSlot(slotName) != null) throw error("stale_plan", "Slot is occupied.");
          service.requireModelEditsEnabled(); c.add(slotName, value.newCopy(true), flags, facets, cx);
          return map("ord", ord(c), "snapshot", after(c, cx));
        }));
        return;
      }
      Slot slot = c.getSlot(slotName);
      if (slot == null) throw error("invalid_slot", "Slot does not exist.");
      checks.add(() -> { if (c.getSlot(slotName) != slot) throw error("stale_plan", "Slot identity changed."); });
      if (!futureOrds.containsKey(c)) target(path, cx, true);
      if ("remove_slot".equals(action) || "delete_link".equals(action))
      {
        if (!slot.isProperty() || !slot.isDynamic()) throw error("frozen_slot", "Only dynamic properties can be removed.");
        Property p = slot.asProperty(); BValue old = c.get(p);
        if (old instanceof BComponent) throw error("bad_request", "Use delete for components.");
        if ("delete_link".equals(action) && !(old instanceof BLink)) throw error("invalid_link", "Slot does not contain a link.");
        unchanged(c, p); c.checkRemove(p, cx);
        final BValue baseline = old.newCopy(true);
        steps.add(new BaskStreamModelPlans.Step(map("action", action, "ord", ord(c), "slot", slotName, "before", valueWire(old, slotName, 0, path, cx), "beforeHash", fingerprint(old, 0, new int[]{0})), () -> {
          guard(c, true); target(path, cx, true);
          if (c.getSlot(slotName) != slot) throw error("stale_plan", "Slot identity changed before apply.");
          if (!baseline.equivalent(c.get(p))) throw error("stale_plan", "Slot changed.");
          service.requireModelEditsEnabled(); c.remove(p, cx);
          return map("removedOrd", path, "snapshot", after(c, cx));
        }));
        return;
      }
      int oldFlags = c.getFlags(slot); BFacets oldFacets = c.getSlotFacets(slot);
      int flags = integer(change, "flags", oldFlags, 0, Integer.MAX_VALUE);
      BFacets facets = change.containsKey("facets") ? facets(change.get("facets")) : oldFacets;
      c.checkSetFlags(slot, flags, cx); c.checkSetFacets(slot, facets, cx);
      checks.add(() -> { if (c.getFlags(slot) != oldFlags || !c.getSlotFacets(slot).equals(oldFacets)) throw error("stale_plan", "Slot metadata changed."); });
      steps.add(new BaskStreamModelPlans.Step(map("action", action, "ord", ord(c), "slot", slotName, "beforeFlags", oldFlags,
          "flags", flags, "beforeFacets", oldFacets.encodeToString(), "facets", facets.encodeToString()), () -> {
        guard(c, true); target(path, cx, true);
        if (c.getSlot(slotName) != slot) throw error("stale_plan", "Slot identity changed before apply.");
        if (c.getFlags(slot) != oldFlags || !c.getSlotFacets(slot).equals(oldFacets)) throw error("stale_plan", "Slot metadata changed before apply.");
        service.requireModelEditsEnabled();
        c.setFlags(slot, flags, cx); service.requireModelEditsEnabled(); c.setFacets(slot, facets, cx);
        return map("ord", ord(c), "snapshot", after(c, cx));
      }));
    }
  }

  private Map<String, Object> after(BComponent c, Context cx)
  {
    String ord = c.getSlotPathOrd() == null ? null : c.getSlotPathOrd().toString();
    try
    {
      Map<String, Object> result = describe(map("ord", ord), cx);
      if (new BaskStreamCodec().encodeMessage(result).length <= service.getMaxMessageBytesValue() / (2 * MAX_CHANGES)) return result;
      return map("ord", ord, "typeSpec", c.getType().toString(), "truncated", true, "refreshWith", "describe_component");
    }
    catch (Exception e)
    {
      return map("ord", ord, "unavailable", true, "refreshWith", "describe_component");
    }
  }

  private Map<String, Object> dependencies(BComponent root, Context cx, boolean recursive) throws Exception
  {
    List<BComponent> pending = new ArrayList<BComponent>(); pending.add(root);
    List<Object> entries = new ArrayList<Object>(); int hidden = 0;
    for (int i = 0; i < pending.size(); i++)
    {
      BComponent c = pending.get(i);
      for (javax.baja.sys.Knob knob : c.getKnobs())
      {
        BComponent other = knob.getTargetComponent();
        if (other == null) { hidden++; continue; }
        try
        {
          String ord = other.getSlotPathOrd().toString(); target(ord, cx, false);
          entries.add(map("kind", "incoming_link", "source", c.getSlotPathOrd().toString(), "sourceSlot", knob.getSourceSlotName(), "target", ord, "targetSlot", knob.getTargetSlotName()));
        }
        catch (Exception e) { hidden++; }
      }
      for (javax.baja.sys.RelationKnob knob : c.getRelationKnobs())
      {
        BComponent other = knob.getRelationComponent();
        if (other == null) { hidden++; continue; }
        try
        {
          String ord = other.getSlotPathOrd().toString(); target(ord, cx, false);
          entries.add(map("kind", "incoming_relation", "source", ord, "relation", knob.getRelationId(), "target", c.getSlotPathOrd().toString()));
        }
        catch (Exception e) { hidden++; }
      }
      if (recursive) pending.addAll(Arrays.asList(c.getChildComponents()));
      if (pending.size() + entries.size() > MAX_TREE_VALUES) throw error("model_limit", "Dependency listing exceeds bounds.");
    }
    return map("knownReferences", entries, "unreadableOrUnresolved", hidden, "complete", false,
        "note", "Niagara link/relation knobs only. Arbitrary ORD strings, graphics and vendor references require separate review.");
  }

  private OrdTarget target(String ord, Context cx, boolean write) throws Exception
  {
    scope(ord);
    OrdTarget t = BOrd.make(ord).resolve(service, cx);
    if (!t.canRead()) throw error("forbidden_component", "Target is not readable.");
    if (write && (!t.canWrite() || !t.getPermissionsForTarget().hasAdminWrite())) throw error("forbidden_component", "Target requires Niagara admin-write permission.");
    if (write)
    {
      BComponent component = t.getComponent();
      if (component == service || (component != null && component.isDescendentOf(service)))
        throw error("protected_component", "Edit the baskStream service in Workbench; it cannot change its own write controls remotely.");
      if (component != null && withinProtected(component))
        throw error("protected_component", "Security, identity, remote-access, platform and audit services must be changed in Workbench.");
    }
    return t;
  }
  /**
   * Services that decide who can reach the station and what they may do, plus audit and code
   * execution. Model editing leaves them to Workbench. Types not installed on a station are skipped.
   */
  private static final String[] PROTECTED_TYPES = { "baja:UserService", "baja:RoleService",
      "baja:AuthenticationService", "baja:CategoryService", "nss:SecurityService",
      "platform:PlatformServiceContainer", "fox:FoxService", "web:WebService",
      "history:AuditHistoryService", "program:ProgramService" };

  /**
   * Walks the type's own (already loaded) superclass chain and compares names. It never calls
   * Sys.getType for the protected names: on a live station, loading program-module types from
   * the session worker never returned.
   */
  private boolean protectedType(Type type)
  {
    Type t = type;
    for (int depth = 0; t != null && depth < 64; depth++)
    {
      String spec = t.toString();
      if (spec.equals(service.getType().toString()) || Arrays.asList(PROTECTED_TYPES).contains(spec)) return true;
      Type next = t.getSuperType();
      if (next == t) break;
      t = next;
    }
    return false;
  }

  /** Client-supplied type names are checked before Sys.getType, which never returned for program types. */
  private static void requireLoadable(String spec) throws Exception
  {
    if (spec.startsWith("program:"))
      throw error("invalid_type", "program: types cannot be loaded through baskStream; use Workbench.");
  }

  /** Name-only check for a requested type, made before anything is loaded or created. */
  private static boolean protectedSpec(String spec)
  {
    return spec.startsWith("program:") || spec.startsWith("baskStream:") || Arrays.asList(PROTECTED_TYPES).contains(spec);
  }

  private boolean protectedType(BComponent c)
  {
    return c instanceof BBaskStreamService || protectedType(c.getType());
  }

  private static boolean programType(Type type)
  {
    return type.toString().startsWith("program:");
  }

  /** True when the component or anything above it is a protected service. */
  private boolean withinProtected(BComponent c)
  {
    // Bounded, and uses getParent() like browse: on the live station the unbounded
    // getParentComponent() walk from ordinary components never finished.
    BComplex x = c;
    for (int depth = 0; x != null && depth < 64; depth++)
    {
      if (x instanceof BComponent && protectedType((BComponent)x)) return true;
      BComplex parent = x.getParent();
      if (parent == x) break;
      x = parent;
    }
    return false;
  }

  /** True when a new or copied component, or anything inside it, is protected or can carry program code. */
  private boolean containsProtected(BComponent c, int depth) throws Exception
  {
    if (protectedType(c) || programType(c.getType())) return true;
    if (depth >= 32) throw error("model_limit", "Branch exceeds model bounds.");
    for (BComponent child : c.getChildComponents()) if (containsProtected(child, depth + 1)) return true;
    return false;
  }

  private static boolean holdsPassword(BComplex c, int depth, int[] count) throws Exception
  {
    if (++count[0] > MAX_TREE_VALUES || depth > 32) throw error("model_limit", "Branch exceeds model bounds.");
    for (Property p : c.getPropertiesArray())
    {
      BValue value = c.get(p);
      if (value instanceof BPassword) return true;
      if (value instanceof BComplex && holdsPassword((BComplex)value, depth + 1, count)) return true;
    }
    return false;
  }

  private BComplex complex(String ord, Context cx, boolean write) throws Exception
  {
    BObject object = target(ord, cx, write).get();
    if (!(object instanceof BComplex)) throw error("invalid_component", "Target must resolve exactly to a component or struct.");
    return (BComplex)object;
  }
  private void scope(String ord) throws Exception
  {
    if (ord == null || !ord.startsWith("slot:/") || !BaskStreamAccessPolicy.isAllowed(service, ord))
      throw error("forbidden_component", "ORD must be inside the station allowedPathPatterns policy.");
  }
  private void requireInvoke(String ord, Context cx) throws Exception
  {
    OrdTarget t = target(ord, cx, false);
    if (!t.canInvoke() || !t.getPermissionsForTarget().hasAdminWrite()) throw error("forbidden_action", "Action requires invoke and admin-write permission.");
  }
  private void verifyTree(BComponent c, Context cx, boolean write, int[] count) throws Exception
  { verifyValues(c, c.getSlotPathOrd().toString(), cx, write, count, 0); }

  private void verifyValues(BComplex c, String path, Context cx, boolean write, int[] count, int depth) throws Exception
  {
    if (++count[0] > MAX_TREE_VALUES || depth > 32) throw error("model_limit", "Branch exceeds model bounds.");
    target(path, cx, write && c instanceof BComponent);
    for (Property p : c.getPropertiesArray())
    {
      if (Flags.isTransient(c, p)) continue;
      String propertyPath = child(path, p.getName());
      target(propertyPath, cx, false);
      BValue value = c.get(p);
      if (value instanceof BComplex) verifyValues((BComplex)value, propertyPath, cx, write, count, depth + 1);
      else if (++count[0] > MAX_TREE_VALUES) throw error("model_limit", "Branch exceeds model bounds.");
    }
  }

  private static final class PropertyTarget
  {
    final BComplex owner; final Property property;
    PropertyTarget(BComplex c, Property p) { owner = c; property = p; }
  }
  private static boolean isLinkOrRelation(BValue value)
  { return value instanceof BLink || value instanceof BRelation; }

  private PropertyTarget property(BComplex c, String path) throws Exception
  {
    String[] parts = path.split("/", -1);
    if (parts.length > 16) throw error("bad_request", "Property path is too deep.");
    for (int i = 0; i < parts.length; i++)
    {
      name(parts[i]); Property p = c.getProperty(parts[i]);
      if (p == null) throw error("invalid_property", "Property does not exist: " + path);
      // Links and relations change only through create_link/delete_link and the tag operations, which check both endpoints.
      if (isLinkOrRelation(c) || isLinkOrRelation(c.get(p))) throw error("invalid_property", "Links and relations cannot be edited as properties: " + path);
      if (i == parts.length - 1) return new PropertyTarget(c, p);
      BValue value = c.get(p);
      if (!(value instanceof BComplex)) throw error("invalid_property", "Property path crosses a scalar.");
      c = (BComplex)value;
    }
    throw error("invalid_property", "Empty property path.");
  }

  private BComponent newComponent(String spec) throws Exception
  {
    // Decide from the name first: on a live station, loading or instantiating program types never returned.
    if (protectedSpec(spec))
      throw error("protected_component", "Protected services and program components cannot be created or copied remotely; use Workbench.");
    Type type = Sys.getType(spec);
    if (type.isAbstract() || type.isInterface() || !type.is(BComponent.TYPE)) throw error("invalid_type", "Type must be a concrete installed component.");
    if (protectedType(type) || programType(type))
      throw error("protected_component", "Protected services and program components cannot be created or copied remotely; use Workbench.");
    return (BComponent)type.getInstance();
  }
  private void legalAdd(BComponent parent, String name, BComponent value, int flags, BFacets facets, Context cx) throws Exception
  {
    parent.checkAdd(name, value, flags, facets, cx);
    if (!parent.isChildLegal(value) || !value.isParentLegal(parent)) throw error("illegal_parent", "Niagara rejected this parent/type combination.");
  }

  /** Explicit typed representation: {typeSpec, encoded} for scalars; {typeSpec, properties} for complex values. */
  private BValue decode(Object raw, Type expected, Context cx, int depth) throws Exception
  {
    if (depth > 16) throw error("model_limit", "Value nesting exceeds 16 levels.");
    Map<String, Object> wire = object(raw, "typed value");
    if (wire.containsKey("encoded") == wire.containsKey("properties")) throw error("bad_request", "Supply exactly one of encoded or properties.");
    for (String key : wire.keySet()) if (!Arrays.asList("encoded", "properties", "typeSpec").contains(key)) throw error("bad_request", "Unknown typed value field: " + key);
    String spec = optional(wire, "typeSpec");
    if (spec != null) requireLoadable(spec);
    Type type = spec == null ? expected : Sys.getType(spec);
    if (type == null) throw error("invalid_type", spec == null ? "Value needs a typeSpec." : "Unknown typeSpec: " + spec);
    if (type.isAbstract() || type.isInterface())
      throw error("invalid_type", "Type " + type + " is abstract; supply a concrete typeSpec" + (spec == null ? " (the property is declared as " + type + ")." : "."));
    if (expected != null && !type.is(expected)) throw error("invalid_type", "Type " + type + " is not compatible with the property type " + expected + ".");
    if (type.is(BLink.TYPE) || type.is(BRelation.TYPE)) throw error("invalid_type", "Use create_link or the relation operations for links and relations.");
    BObject value = type.getInstance();
    if (value instanceof BSimple)
    {
      Object encoded = wire.get("encoded");
      if (!(encoded instanceof String)) throw error("bad_request", "Simple values require an encoded string.");
      BObject decoded = ((BSimple)value).decodeFromString((String)encoded);
      if (!(decoded instanceof BValue) || !decoded.getType().is(type)) throw error("invalid_type", "Decoder returned an incompatible type.");
      // Some decoders turn text they cannot parse into the type's null value instead of failing.
      if (!"null".equals(((String)encoded).trim()) && "null".equals(((BSimple)decoded).encodeToString()))
        throw error("invalid_value", "Encoded value was not understood by " + type + "; it would have been stored as null.");
      return (BValue)decoded;
    }
    if (value instanceof BComplex)
    {
      setDetached((BComplex)value, object(wire.get("properties"), "properties"), cx, depth + 1);
      return (BValue)value;
    }
    throw error("invalid_type", "Type cannot be represented as a Baja value.");
  }
  private void setDetached(BComplex value, Map<String, Object> properties, Context cx, int depth) throws Exception
  {
    if (properties.size() > MAX_CHANGES) throw error("model_limit", "Too many properties in a value.");
    for (Map.Entry<String, Object> entry : properties.entrySet())
    {
      PropertyTarget pt = property(value, entry.getKey());
      if (Flags.isReadonly(pt.owner, pt.property)) throw error("readonly", "Cannot initialize a read-only property: " + entry.getKey());
      BValue decoded = decode(entry.getValue(), pt.property.getType(), cx, depth);
      pt.owner.set(pt.property, decoded, cx);
    }
  }
  private Object valueWire(BValue value, String name, int depth) throws Exception
  { return valueWire(value, name, depth, null, null); }

  private Object valueWire(BValue value, String name, int depth, String path, Context cx) throws Exception
  {
    if (value == null) return null;
    if (sensitive(name, value.getType().toString())) return map("typeSpec", value.getType().toString(), "redacted", true);
    if (value instanceof BSimple) return map("typeSpec", value.getType().toString(), "encoded", ((BSimple)value).encodeToString());
    if (value instanceof BComponent || depth >= 4) return map("typeSpec", value.getType().toString(), "expand", true);
    Map<String, Object> properties = new LinkedHashMap<String, Object>();
    for (Property p : ((BComplex)value).getPropertiesArray())
    {
      if (properties.size() >= MAX_CHANGES) break;
      String nested = path == null ? null : child(path, p.getName());
      if (nested != null)
      {
        try { target(nested, cx, false); }
        catch (Exception e) { continue; }
      }
      properties.put(p.getName(), valueWire(((BComplex)value).get(p), p.getName(), depth + 1, nested, cx));
    }
    return map("typeSpec", value.getType().toString(), "properties", properties, "truncated", ((BComplex)value).getPropertyCount() > properties.size());
  }
  private Object snapshotDetached(BValue value, int depth, int[] count) throws Exception
  {
    if (value == null) return null;
    if (++count[0] > MAX_TREE_VALUES || depth > 32) throw error("model_limit", "Model snapshot exceeds its bounds.");
    if (value instanceof BSimple) return valueWire(value, "", depth);
    BComplex c = (BComplex)value;
    Map<String, Object> properties = new LinkedHashMap<String, Object>();
    for (Property p : c.getPropertiesArray())
    {
      if (Flags.isTransient(c, p)) continue;
      BValue v = c.get(p);
      Object rendered = sensitive(p.getName(), v.getType().toString()) ? map("redacted", true) : snapshotDetached(v, depth + 1, count);
      properties.put(p.getName(), map("value", rendered, "flags", c.getFlags(p), "facets", c.getSlotFacets(p).encodeToString()));
    }
    return map("typeSpec", value.getType().toString(), "properties", properties);
  }
  private String fingerprint(BValue value, int depth, int[] count) throws Exception
  {
    if (++count[0] > MAX_TREE_VALUES || depth > 32) throw error("model_limit", "Fingerprint exceeds model bounds.");
    if (value == null) return BaskStreamModelPlans.digest(map("key", fingerprintKey, "value", null));
    if (value instanceof BSimple) return BaskStreamModelPlans.digest(map("key", fingerprintKey, "type", value.getType().toString(), "encoded", ((BSimple)value).encodeToString()));
    BComplex c = (BComplex)value;
    List<Object> state = new ArrayList<Object>();
    for (Property p : c.getPropertiesArray())
      if (!Flags.isTransient(c, p)) state.add(map("name", p.getName(), "value", fingerprint(c.get(p), depth + 1, count),
          "flags", c.getFlags(p), "facets", c.getSlotFacets(p).encodeToString()));
    return BaskStreamModelPlans.digest(map("key", fingerprintKey, "type", c.getType().toString(), "properties", state));
  }

  static boolean sensitive(String name, String type)
  { return (name + " " + type).toLowerCase(java.util.Locale.ROOT).matches(".*(password|credential|secret|privatekey|apikey|passphrase|token).*"); }
  private static Map<String, Object> summary(BComplex c, String ord)
  { return map("ord", ord, "typeSpec", c.getType().toString(), "name", c.getName()); }
  private static String clean(String s) { return s.replace('\n', ' ').replace('\r', ' '); }
  private static String child(String parent, String slot) { return parent.endsWith("/") ? parent + slot : parent + "/" + slot; }
  private static boolean within(String ord, String root) { return ord.equals(root) || ord.startsWith(root.endsWith("/") ? root : root + "/"); }
  private static void name(String s) throws Exception
  {
    if (s == null || !s.matches("[a-zA-Z_$][a-zA-Z0-9_$]*") || s.length() > 128) throw error("invalid_name", "Use a Niagara slot name (escaped when necessary), 1 to 128 characters.");
  }
  private static BFacets facets(Object value) throws Exception
  { return value == null ? BFacets.DEFAULT : BFacets.make(String.valueOf(value)); }
  private static String optional(Map<String, Object> m, String key) throws Exception
  {
    Object v = m.get(key);
    if (v == null) return null;
    if (!(v instanceof String) || ((String)v).isEmpty()) throw error("bad_request", key + " must be a nonempty string.");
    return (String)v;
  }
  static String required(Map<String, Object> m, String key) throws Exception
  { String s = optional(m, key); if (s == null) throw error("bad_request", "Missing " + key); return s; }
  private static int integer(Map<String, Object> m, String key, int fallback, int min, int max) throws Exception
  {
    Object v = m.get(key); if (v == null) return fallback;
    if (!(v instanceof Number) || ((Number)v).doubleValue() != ((Number)v).longValue() || ((Number)v).longValue() < min || ((Number)v).longValue() > max)
      throw error("bad_request", "Invalid " + key);
    return ((Number)v).intValue();
  }
  @SuppressWarnings("unchecked") static Map<String, Object> object(Object v, String key) throws Exception
  { if (!(v instanceof Map)) throw error("bad_request", key + " must be an object."); return (Map<String, Object>)v; }
  private static List<?> list(Object v, String key) throws Exception
  { if (!(v instanceof List)) throw error("bad_request", key + " must be an array."); return (List<?>)v; }
  private static List<Map<String, Object>> objects(Object v, String key) throws Exception
  {
    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
    for (Object item : list(v, key)) out.add(object(item, key)); return out;
  }
}
