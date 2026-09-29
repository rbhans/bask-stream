#!/usr/bin/env python3
"""Run actual model resolver/ledger source against in-memory Baja API doubles.

This verifies protocol decisions, not Niagara lifecycle/driver/runtime behavior.
"""
from pathlib import Path
import os, re, subprocess, tempfile

root = Path(__file__).resolve().parents[1]
src = root / 'baskStream-rt/src/com/basidekick/baskstream'
imports, bodies = set(), []
for name in ('BaskStreamModelResolver', 'BaskStreamModelPlans', 'BaskStreamProtocolException'):
    source = (src / (name + '.java')).read_text()
    imports.update(re.findall(r'^import java\..*;', source, re.M))
    source = re.sub(r'^(?:package|import) .*;\s*', '', source, flags=re.M)
    source = source.replace('javax.baja.sys.IPropertyValidator', 'IPropertyValidator').replace('javax.baja.sys.RelationKnob', 'RelationKnob').replace('javax.baja.sys.Knob', 'Knob')
    if name == 'BaskStreamModelResolver':
        source = source.replace('error(', 'BaskStreamModelPlans.error(')
        source = re.sub(r'(?<![\w.])map\(', 'BaskStreamModelPlans.map(', source)
    bodies.append(source)

test = r'''
@SuppressWarnings("unchecked")
class ModelAdapterRegression {
  static Map<String,Object> m(Object... v){return BaskStreamModelPlans.map(v);}
  static Map<String,Object> value(String s){return m("encoded",s);}
  static void check(boolean b){if(!b)throw new AssertionError();}
  interface Run {void go() throws Exception;}
  static void reject(String code,Run r)throws Exception{try{r.go();throw new AssertionError("Accepted "+code);}catch(BaskStreamProtocolException e){if(!e.getCode().equals(code))throw e;}}
  static Map<String,Object> preview(BaskStreamModelResolver model,Context cx,Map<String,Object>... changes)throws Exception{return model.preview(m("changes",Arrays.asList(changes)),cx);}
  static Map<String,Object> apply(BaskStreamModelResolver model,Context cx,Map<String,Object> p)throws Exception{return model.apply(m("planId",p.get("planId"),"planHash",p.get("planHash"),"idempotencyKey",p.get("planId")),cx);}
  public static void main(String[] args)throws Exception{
    BComponent root=new BComponent();Sys.root=root;
    BComponent test=new BComponent();root.add("Test",test,null);
    BComponent services=new BComponent();root.add("Services",services,null);
    BBaskStreamService service=new BBaskStreamService();services.add("baskStream",service,null);
    Context cx=new Context();BaskStreamModelResolver model=new BaskStreamModelResolver(service);
    Map<String,Object> create=preview(model,cx,m("action","create","parent","slot:/Test","name","Building","typeSpec","baja:Folder","ref","b"),m("action","create","parent","@b","name","Floor","typeSpec","baja:Folder"));
    check(test.get("Building")==null);
    service.writes=false;reject("writes_disabled",()->apply(model,cx,create));check(test.get("Building")==null);
    service.writes=true;check(apply(model,cx,create).get("state").equals("applied"));
    BComponent building=(BComponent)test.get("Building");check(building.get("Floor")!=null);
    apply(model,new Context(),create);check(test.getChildComponents().length==1);
    reject("name_conflict",()->preview(model,cx,m("action","create","parent","slot:/Test","name","Building","typeSpec","baja:Folder")));
    Map<String,Object> suffix=preview(model,cx,m("action","create","parent","slot:/Test","name","Building","typeSpec","baja:Folder","collision","suffix"));
    check(suffix.toString().contains("Building2"));
    building.add("value",new BSimple("old"),null);
    Map<String,Object> update=preview(model,cx,m("action","update","ord","slot:/Test/Building","properties",m("value",value("new"))));
    building.set(building.getProperty("value"),new BSimple("external"),cx);
    reject("stale_plan",()->apply(model,cx,update));check(building.get("value").toString().equals("external"));
    Map<String,Object> changed=preview(model,cx,m("action","update","ord","slot:/Test/Building","properties",m("value",value("new"))));
    check(apply(model,cx,changed).get("state").equals("applied"));check(building.get("value").toString().equals("new"));
    building.add("password",new BSimple("old-secret"),null);
    Map<String,Object> secret=preview(model,cx,m("action","update","ord","slot:/Test/Building","properties",m("password",value("new-secret"))));
    check(!secret.toString().contains("new-secret"));check(!secret.toString().contains("old-secret"));
    check(!Sys.events.toString().contains("new-secret"));
    Map<String,Object> perms=preview(model,cx,m("action","update","ord","slot:/Test/Building","properties",m("value",value("denied"))));
    Sys.denied.add("slot:/Test/Building");reject("forbidden_component",()->apply(model,cx,perms));Sys.denied.clear();
    reject("forbidden_component",()->preview(model,cx,m("action","create","parent","slot:/Outside","name","X","typeSpec","baja:Folder")));
    reject("protected_component",()->preview(model,cx,m("action","add_slot","ord","slot:/Services/baskStream","slot","switch","value",m("typeSpec","baja:String","encoded","true"))));
    reject("children_present",()->preview(model,cx,m("action","delete","ord","slot:/Test/Building")));
    reject("cycle",()->preview(model,cx,m("action","move","ord","slot:/Test/Building","parent","slot:/Test/Building/Floor")));
    Map<String,Object> renamed=preview(model,cx,m("action","rename","ord","slot:/Test/Building","name","Renamed"));
    Object handle=building.getHandle();check(apply(model,cx,renamed).get("state").equals("applied"));
    check(test.get("Renamed")==building);check(handle.equals(building.getHandle()));
    BComponent dest=new BComponent();test.add("Destination",dest,null);
    Map<String,Object> moved=preview(model,cx,m("action","move","ord","slot:/Test/Renamed","parent","slot:/Test/Destination"));
    check(apply(model,cx,moved).get("state").equals("applied"));check(dest.get("Renamed")==building);check(test.get("Renamed")==null);
    Map<String,Object> deleted=preview(model,cx,m("action","delete","ord","slot:/Test/Destination/Renamed","recursive",true));
    check(apply(model,cx,deleted).get("state").equals("applied"));check(dest.get("Renamed")==null);
    Map<String,Object> slot=preview(model,cx,m("action","add_slot","ord","slot:/Test/Destination","slot","label","value",m("typeSpec","baja:String","encoded","first")));
    check(apply(model,cx,slot).get("state").equals("applied"));check(dest.get("label").toString().equals("first"));
    Map<String,Object> metadata=preview(model,cx,m("action","set_slot_metadata","ord","slot:/Test/Destination","slot","label","flags",8));
    check(apply(model,cx,metadata).get("state").equals("applied"));check(dest.getFlags(dest.getProperty("label"))==8);
    dest.add("second",new BSimple("second"),cx);
    Map<String,Object> order=preview(model,cx,m("action","reorder","ord","slot:/Test/Destination","slots",Arrays.asList("second","label")));
    check(apply(model,cx,order).get("state").equals("applied"));check(dest.getDynamicPropertiesArray()[0].getName().equals("second"));
    Map<String,Object> link=preview(model,cx,m("action","create_link","source","slot:/Test/Destination","sourceSlot","label","target","slot:/Test/Destination","targetSlot","second","name","connection"));
    check(apply(model,cx,link).get("state").equals("applied"));check(dest.get("connection") instanceof BLink);
    reject("invalid_type",()->preview(model,cx,m("action","add_slot","ord","slot:/Test/Destination","slot","sneaky","value",m("typeSpec","baja:Link","properties",m()))));
    reject("invalid_type",()->preview(model,cx,m("action","add_slot","ord","slot:/Test/Destination","slot","sneaky","value",m("typeSpec","baja:Relation","properties",m()))));
    reject("invalid_property",()->preview(model,cx,m("action","update","ord","slot:/Test/Destination","properties",m("connection/sourceOrd",value("slot:/Outside")))));
    check(apply(model,cx,preview(model,cx,m("action","delete_link","ord","slot:/Test/Destination","slot","connection"))).get("state").equals("applied"));check(dest.get("connection")==null);
    check(apply(model,cx,preview(model,cx,m("action","remove_slot","ord","slot:/Test/Destination","slot","second"))).get("state").equals("applied"));check(dest.get("second")==null);
    Map<String,Object> clone=preview(model,cx,m("action","clone","source","slot:/Test/Destination","parent","slot:/Test","name","Copy"));
    check(apply(model,cx,clone).get("state").equals("applied"));check(test.get("Copy")!=dest);check(((BComponent)test.get("Copy")).get("label").toString().equals("first"));
    check(apply(model,cx,preview(model,cx,m("action","create_hierarchy","parent","slot:/Test","name","Hierarchy"))).get("state").equals("applied"));
    BComponent hierarchy=(BComponent)test.get("Hierarchy");hierarchy.add("label",new BSimple("old"),cx);
    check(apply(model,cx,preview(model,cx,m("action","configure_hierarchy","ord","slot:/Test/Hierarchy","properties",m("label",value("configured"))))).get("state").equals("applied"));check(hierarchy.get("label").toString().equals("configured"));
    Action action=new Action();action.name="run";dest.actions.put("run",action);
    check(apply(model,cx,preview(model,cx,m("action","invoke","ord","slot:/Test/Destination","slot","run"))).get("state").equals("applied"));check(dest.invocations==1);
    BComplex nested=new BComplex();Property privateField=new Property("internal",BSimple.TYPE);nested.props.put("internal",privateField);nested.set(privateField,new BSimple("must-not-disclose"),cx);dest.add("settings",nested,cx);
    Sys.readDenied.add("slot:/Test/Destination/settings/internal");
    check(!model.describe(m("ord","slot:/Test/Destination"),cx).toString().contains("must-not-disclose"));
    reject("forbidden_component",()->preview(model,cx,m("action","clone","source","slot:/Test/Destination","parent","slot:/Test","name","DeniedCopy")));
    Sys.readDenied.clear();
    Map<String,Object> nestedEdit=preview(model,cx,m("action","update","ord","slot:/Test/Destination","properties",m("settings/internal",value("replacement"))));
    BValue newSettings=nested.newCopy(true);dest.set(dest.getProperty("settings"),newSettings,cx);
    reject("stale_plan",()->apply(model,cx,nestedEdit));
    reject("plan_conflict",()->preview(model,cx,m("action","update","ord","slot:/Test/Destination","properties",m("settings/internal",value("a"))),m("action","set_slot_metadata","ord","slot:/Test/Destination","slot","settings","flags",0)));
    Sys.allowProtectedLookup=true;BComponent users=new BComponent();users.type=Sys.getType("baja:UserService");Sys.allowProtectedLookup=false;services.add("UserService",users,null);
    reject("protected_component",()->preview(model,cx,m("action","create","parent","slot:/Services/UserService","name","Eve","typeSpec","baja:Folder")));
    reject("protected_component",()->preview(model,cx,m("action","create","parent","slot:/Test","name","Users2","typeSpec","baja:UserService")));
    reject("protected_component",()->preview(model,cx,m("action","create","parent","slot:/Test","name","Code","typeSpec","program:Program")));
    reject("protected_component",()->preview(model,cx,m("action","clone","source","slot:/Services/baskStream","parent","slot:/Test","name","Stream2")));
    Action restart=new Action();restart.name="restart";restart.flags=4096;dest.actions.put("restart",restart);
    reject("confirm_required",()->preview(model,cx,m("action","invoke","ord","slot:/Test/Destination","slot","restart")));
    check(apply(model,cx,preview(model,cx,m("action","invoke","ord","slot:/Test/Destination","slot","restart","confirm",true))).get("state").equals("applied"));
    BComponent vault=new BComponent();test.add("Vault",vault,null);vault.add("password",new BPassword("s3cret"),null);
    Sys.adminDenied.add("slot:/Test/Vault");
    reject("forbidden_component",()->preview(model,cx,m("action","clone","source","slot:/Test/Vault","parent","slot:/Test","name","VaultCopy")));
    Sys.adminDenied.clear();
    check("preview".equals(preview(model,cx,m("action","clone","source","slot:/Test/Vault","parent","slot:/Test","name","VaultCopy")).get("state")));
    StubbornComponent port=new StubbornComponent();test.add("Port",port,null);port.add("adapter",new BSimple("none"),null);port.add("label",new BSimple("a"),null);
    Map<String,Object> undone=apply(model,cx,preview(model,cx,m("action","update","ord","slot:/Test/Port","properties",m("adapter",value("eth0")))));
    check(undone.toString().contains("reverted=true"));
    Map<String,Object> kept=apply(model,cx,preview(model,cx,m("action","update","ord","slot:/Test/Port","properties",m("label",value("b")))));
    check(!kept.toString().contains("reverted"));
    reject("invalid_type",()->model.types(m("typeSpec","program:Program"),cx));
    reject("invalid_type",()->preview(model,cx,m("action","add_slot","ord","slot:/Test/Destination","slot","p","value",m("typeSpec","program:Robot","properties",m()))));
    System.out.println("PASS: reverted values are reported; program type names refused before loading");
    System.out.println("PASS: protected services, program types, service copies, confirm-required actions, password copies");
    System.out.println("PASS: actual resolver with API doubles: all 15 actions, refs, master gate, deduplication, naming, stale values, redaction, fresh permissions, nested read permissions, scope, service protection, deletion, cycles and move identity");
  }
}
class Context { BUser getUser(){return new BUser();} }
class BUser {String getUsername(){return "test";}Object getHandle(){return "user-handle";} }
class BObject {Type getType(){return Sys.getType("baja:String");} }
class BValue extends BObject {BValue newCopy(boolean exact){return this;}boolean equivalent(Object v){return equals(v);} }
class BSimple extends BValue {
  static final Type TYPE=new Type("baja:String");final String value;
  BSimple(){this("");}BSimple(String v){value=v;}
  String encodeToString(){return value;}BObject decodeFromString(String v){return new BSimple(v);}
  public String toString(){return value;}public boolean equals(Object v){return v instanceof BSimple&&value.equals(((BSimple)v).value);}
}
class BFacets extends BSimple {static final BFacets DEFAULT=new BFacets();static BFacets make(String s){return new BFacets();}}
class BComplex extends BValue {
  static final Type TYPE=new Type("baja:Complex");String name="";BComplex parent;Type type=Sys.getType("baja:Component");
  LinkedHashMap<String,Property> props=new LinkedHashMap<>();LinkedHashMap<String,BValue> values=new LinkedHashMap<>();
  Type getType(){return type;}String getName(){return name;}BComplex getParent(){return parent;}
  Map<String,Action> actions=new HashMap<>();
  Property getProperty(String n){return props.get(n);}Slot getSlot(String n){return actions.containsKey(n)?actions.get(n):props.get(n);}Action getAction(String n){return actions.get(n);}
  BValue get(Property p){return values.get(p.name);}BValue get(String n){return values.get(n);}
  void set(Property p,BValue v,Context cx){values.put(p.name,v);if(v instanceof BComplex){((BComplex)v).name=p.name;((BComplex)v).parent=this;}}
  int getFlags(Slot p){return p.flags;}BFacets getSlotFacets(Slot p){return p.facets;}
  void setFlags(Slot p,int v,Context cx){p.flags=v;}void setFacets(Slot p,BFacets f,Context cx){p.facets=f;}
  Slot[] getSlotsArray(){return props.values().toArray(new Slot[0]);}Property[] getPropertiesArray(){return props.values().toArray(new Property[0]);}
  Property[] getDynamicPropertiesArray(){return getPropertiesArray();}int getPropertyCount(){return props.size();}
  IPropertyValidator getPropertyValidator(Property p,Context cx){return null;}
  BValue newCopy(boolean exact){BComplex c=this instanceof BComponent?new BComponent():new BComplex();c.type=type;for(Property p:props.values()){Property q=new Property(p.name,p.type);q.flags=p.flags;c.props.put(q.name,q);c.set(q,get(p).newCopy(exact),null);}return c;}
  BValue newCopy(CopyHints h){return newCopy(true);}
  boolean equivalent(Object v){if(!(v instanceof BComplex))return false;BComplex c=(BComplex)v;if(!props.keySet().equals(c.props.keySet()))return false;for(Property p:props.values())if(!get(p).equivalent(c.get(p.name)))return false;return true;}
}
class BComponent extends BComplex {
  static final Type TYPE=new Type("baja:Component");final Object handle=UUID.randomUUID().toString();boolean pending;int invocations;
  BComponent(){type=Sys.getType("baja:Component");}
  Property add(String n,BValue v,Context cx){return add(n,v,0,BFacets.DEFAULT,cx);}
  Property add(String n,BValue v,int flags,BFacets f,Context cx){if(props.containsKey(n))throw new IllegalStateException("exists");Property p=new Property(n,v.getType());p.flags=flags;p.facets=f;props.put(n,p);set(p,v,cx);return p;}
  void remove(Property p,Context cx){BValue v=values.remove(p.name);props.remove(p.name);if(v instanceof BComplex)((BComplex)v).parent=null;}
  void rename(Property p,String n,Context cx){BValue v=get(p);remove(p,cx);add(n,v,cx);}
  void reorder(Property[] order,Context cx){LinkedHashMap<String,Property> m=new LinkedHashMap<>();for(Property p:order)m.put(p.name,p);props=m;}
  BComponent getParentComponent(){return parent instanceof BComponent?(BComponent)parent:null;}
  Property getPropertyInParent(){return parent==null?null:parent.getProperty(name);}
  BComponent[] getChildComponents(){return values.values().stream().filter(v->v instanceof BComponent).toArray(BComponent[]::new);}
  boolean isDescendentOf(BComponent c){int n=0;for(BComplex p=parent;p!=null&&n++<64;p=p.parent)if(p==c)return true;return false;}
  BOrd getSlotPathOrd(){return new BOrd(parent==null?"slot:/":parent instanceof BComponent?((BComponent)parent).getSlotPathOrd().path.replaceAll("/$","")+"/"+name:"slot:/"+name);}
  Object getHandle(){return handle;}BOrd getHandleOrd(){return new BOrd("h:"+handle);}
  boolean isChildLegal(BComponent c){return true;}boolean isParentLegal(BComponent c){return true;}
  void checkAdd(String n,BValue v,int f,BFacets facets,Context cx){}void checkRemove(Property p,Context cx){}void checkRename(Property p,String n,Context cx){}
  void checkReorder(Property[] p,Context cx){}void checkSetFlags(Slot p,int f,Context cx){}void checkSetFacets(Slot p,BFacets f,Context cx){}
  void setPendingMove(boolean v){pending=v;}LinkCheck checkLink(BComponent c,Slot a,Slot b,Context cx){return new LinkCheck();}
  BLink makeLink(BComponent c,Slot a,Slot b,Context cx){return new BLink();}
  BValue invoke(Action a,BValue v,Context cx){invocations++;return null;}BValue getActionParameterDefault(Action a){return null;}
  Knob[] getKnobs(){return new Knob[0];}RelationKnob[] getRelationKnobs(){return new RelationKnob[0];}
}
class BBaskStreamService extends BComponent {
  {type=new Type("baskStream:BaskStreamService");}
  boolean writes=true;boolean writesAllowed(){return writes;}boolean modelEditsAllowed(){return writes;}
  void requireModelEditsEnabled()throws Exception{if(!writes)throw BaskStreamModelPlans.error("writes_disabled","off");}
  int getMaxMessageBytesValue(){return 1048576;}void audit(String e,String detail){Sys.events.add(e+detail);}
}
class Slot {String name;int flags;BFacets facets=BFacets.DEFAULT;boolean isProperty(){return this instanceof Property;}boolean isAction(){return this instanceof Action;}boolean isDynamic(){return true;}String getName(){return name;}Property asProperty(){return (Property)this;}Action asAction(){return (Action)this;} }
class Property extends Slot {Type type;Property(String n,Type t){name=n;type=t;}Type getType(){return type;} }
class Action extends Slot {Type getParameterType(){return null;}Type getReturnType(){return null;}BValue getParameterDefault(){return null;} }
class Type {
  String spec;Type sup;Type(String s){spec=s;}Type getSuperType(){return sup;}boolean isAbstract(){return false;}boolean isInterface(){return false;}
  boolean is(Type t){return spec.equals(t.spec)||t.spec.equals("baja:Complex")&&!spec.equals("baja:String")||t.spec.equals("baja:Component")&&!spec.equals("baja:String");}
  BObject getInstance(){if(spec.startsWith("program:"))throw new IllegalStateException("instantiated "+spec);if(spec.equals("baja:String"))return new BSimple();BComponent c=new BComponent();c.type=this;return c;}
  TypeInfo getTypeInfo(){return new TypeInfo(this);}public String toString(){return spec;}
}
class TypeInfo {Type type;TypeInfo(Type t){type=t;}String getTypeSpec(){return type.spec;}String getModuleName(){return type.spec.split(":")[0];}boolean isAbstract(){return false;}boolean isInterface(){return false;}boolean is(Type t){return type.is(t);}TypeInfo getSuperType(){return null;}String getRuntimeProfile(){return "rt";} }
class Registry {TypeInfo getType(String s){return new TypeInfo(Sys.getType(s));}TypeInfo[] getTypes(TypeInfo t){return new TypeInfo[0];}}
class Sys {static BComponent root;static Set<String> denied=new HashSet<>(),readDenied=new HashSet<>(),adminDenied=new HashSet<>();static List<String> events=new ArrayList<>();static Type getType(String s){if(s.startsWith("program:")||s.equals("baja:UserService")&&!allowProtectedLookup)throw new IllegalStateException("looked up "+s);return new Type(s);}static boolean allowProtectedLookup;static Registry getRegistry(){return new Registry();}static Auditor getAuditor(){return e->{};} }
class BOrd {
  String path;BOrd(String p){path=p;}static BOrd make(String p){return new BOrd(p);}public String toString(){return path;}
  OrdTarget resolve(BComponent base,Context cx)throws Exception{BValue v=Sys.root;BComplex owner=null;Property p=null;for(String s:path.substring(6).split("/")){if(s.isEmpty())continue;owner=(BComplex)v;p=owner.getProperty(s);v=owner.getAction(s)!=null?new BSimple():owner.get(s);if(v==null)throw new Exception("missing "+path);}return new OrdTarget(path,v,owner,p);}
}
class OrdTarget {String path;BObject value;BComplex owner;Property p;OrdTarget(String s,BValue v,BComplex o,Property prop){path=s;value=v;owner=o;p=prop;}BObject get(){return value;}boolean canRead(){return !Sys.readDenied.contains(path);}boolean canWrite(){return !Sys.denied.contains(path);}boolean canInvoke(){return true;}Permissions getPermissionsForTarget(){Permissions p=new Permissions();p.admin=!Sys.adminDenied.contains(path);return p;}BComponent getComponent(){if(value instanceof BComponent)return (BComponent)value;BComplex c=owner;while(c!=null&&!(c instanceof BComponent))c=c.parent;return (BComponent)c;} }
class Permissions {boolean admin=true;boolean hasAdminWrite(){return admin;}}
class Flags {static boolean isReadonly(BComplex c,Slot p){return (p.flags&1)!=0;}static boolean isTransient(BComplex c,Slot p){return false;}static boolean isAsync(BComponent c,Action a){return false;}static boolean isConfirmRequired(BComplex c,Slot s){return (s.flags&4096)!=0;}}
class CopyHints {Context cx;boolean keepHandles,swizzleHandles;}
interface IPropertyValidator {void validateSet(BComplex c,Property p,BValue v,Context cx);}
class LinkCheck {boolean isValid(){return true;}String getInvalidReason(){return "invalid";}}
class BLink extends BComplex {static final Type TYPE=new Type("baja:Link");}
class StubbornComponent extends BComponent {void set(Property p,BValue v,Context cx){if("adapter".equals(p.name)&&cx!=null)return;super.set(p,v,cx);} }
class BPassword extends BSimple {BPassword(String v){super(v);} }
class BRelation extends BComplex {static final Type TYPE=new Type("baja:Relation");}
interface Knob {BComponent getTargetComponent();String getSourceSlotName();String getTargetSlotName();}
interface RelationKnob {BComponent getRelationComponent();String getRelationId();}
interface Auditor {void audit(AuditEvent e);}
class AuditEvent {AuditEvent(String a,String b,String c,String d,String e,String f){} }
class BaskStreamAccessPolicy {static boolean isAllowed(BBaskStreamService s,String ord){return !ord.startsWith("slot:/Outside")&&!ord.contains("..");}}
class BaskStreamCodec {byte[] encodeMessage(Map<String,Object> m){return m.toString().getBytes(StandardCharsets.UTF_8);}}
'''
with tempfile.TemporaryDirectory(prefix='bask-model-adapter-') as tmp:
    path = Path(tmp) / 'ModelAdapterRegression.java'
    path.write_text('\n'.join(sorted(imports)) + '\n' + test + '\n' + '\n'.join(bodies))
    subprocess.run([os.environ.get('JAVA', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java'), str(path)], check=True)
