#!/usr/bin/env python3
"""Exercise the actual session-independent plan ledger without loading Niagara."""
from pathlib import Path
import os, re, subprocess, tempfile

root = Path(__file__).resolve().parents[1]
src = root / 'baskStream-rt/src/com/basidekick/baskstream'
imports, bodies = set(), []
for name in ('BaskStreamModelPlans', 'BaskStreamProtocolException'):
    text = (src / (name + '.java')).read_text()
    imports.update(re.findall(r'^import .*;', text, re.M))
    bodies.append(re.sub(r'^(?:package|import) .*;\s*', '', text, flags=re.M))
main = r'''
public class ModelPlanRegression {
  static void check(boolean value) { if (!value) throw new AssertionError(); }
  interface Run { void go() throws Exception; }
  static void rejects(String code, Run run) throws Exception {
    try { run.go(); throw new AssertionError("Accepted " + code); }
    catch (BaskStreamProtocolException e) { check(code.equals(e.getCode())); }
  }
  static long now() { return System.currentTimeMillis(); }
  static BaskStreamModelPlans.Audit audit = (event,id,detail) -> {};
  static List<BaskStreamModelPlans.Step> steps(int[] count, int size) {
    List<BaskStreamModelPlans.Step> out = new ArrayList<>();
    for (int i=0; i<size; i++) out.add(new BaskStreamModelPlans.Step(BaskStreamModelPlans.map("action","create","ord","slot:/A"+i), () -> {
      count[0]++; return BaskStreamModelPlans.map("ord","slot:/A"+count[0]);
    }));
    return out;
  }
  static Map<String,Object> apply(BaskStreamModelPlans plans, Map<String,Object> p, String key, BaskStreamModelPlans.Check gate) throws Exception {
    return plans.apply("u", (String)p.get("planId"), (String)p.get("planHash"), key, gate, audit, now());
  }
  public static void main(String[] args) throws Exception {
    BaskStreamModelPlans plans = new BaskStreamModelPlans(); int[] writes={0};
    Map<String,Object> p=plans.preview("u",steps(writes,2),()->{},audit,now());
    check(writes[0]==0);
    rejects("plan_not_found",()->plans.status("other",(String)p.get("planId"),now()));
    rejects("plan_mismatch",()->plans.apply("u",(String)p.get("planId"),"wrong","key",()->{},audit,now()));
    rejects("writes_disabled",()->apply(plans,p,"key",()->{throw BaskStreamModelPlans.error("writes_disabled","off");}));
    check(writes[0]==0);
    check("applied".equals(apply(plans,p,"key",()->{}).get("state")));
    check(writes[0]==2);
    apply(plans,p,"key",()->{throw new AssertionError("Duplicate reached mutation gate");});
    check(writes[0]==2);
    rejects("idempotency_conflict",()->apply(plans,p,"other-key",()->{}));
    Map<String,Object> second=plans.preview("u",steps(writes,1),()->{},audit,now());
    rejects("idempotency_conflict",()->apply(plans,second,"key",()->{}));
    Map<String,Object> stale=plans.preview("u",steps(writes,1),()->{throw BaskStreamModelPlans.error("stale_plan","changed");},audit,now());
    rejects("stale_plan",()->apply(plans,stale,"stale",()->{})); check(writes[0]==2);
    int[] gateCalls={0};
    Map<String,Object> partial=plans.preview("u",steps(writes,3),()->{},audit,now());
    Map<String,Object> result=apply(plans,partial,"partial",()->{if(++gateCalls[0]==3)throw BaskStreamModelPlans.error("writes_disabled","off");});
    check("partial".equals(result.get("state"))); check(writes[0]==3); check((Integer)result.get("unattempted")==1);
    apply(plans,partial,"partial",()->{}); check(writes[0]==3);
    Map<String,Object> cancelled=plans.preview("u",steps(writes,1),()->{},audit,now());
    plans.cancel("u",(String)cancelled.get("planId"),now());
    rejects("plan_not_found",()->apply(plans,cancelled,"cancelled",()->{}));
    Map<String,Object> expired=plans.preview("u",steps(writes,1),()->{},audit,now());
    rejects("plan_not_found",()->plans.status("u",(String)expired.get("planId"),now()+BaskStreamModelPlans.PREVIEW_TTL+1));
    Map<String,Object> auditFail=plans.preview("u",steps(writes,2),()->{},audit,now());
    Map<String,Object> failed=plans.apply("u",(String)auditFail.get("planId"),(String)auditFail.get("planHash"),"audit",()->{},
      (event,id,detail)->{if(event.equals("model_step_completed"))throw new Exception("audit failed");},now());
    check("partial".equals(failed.get("state"))); check(writes[0]==4);
    apply(plans,auditFail,"audit",()->{}); check(writes[0]==4);
    List<BaskStreamModelPlans.Step> reportedFailure=new ArrayList<>();
    reportedFailure.add(new BaskStreamModelPlans.Step(BaskStreamModelPlans.map("action","update"),()->BaskStreamModelPlans.map("ok",false,"properties",java.util.Arrays.asList("completed"),"unattemptedProperties",1)));
    reportedFailure.addAll(steps(writes,1));
    Map<String,Object> reported=plans.preview("u",reportedFailure,()->{},audit,now());
    Map<String,Object> reportedResult=apply(plans,reported,"reported",()->{});
    check("partial".equals(reportedResult.get("state")));check((Integer)reportedResult.get("unattempted")==1);check(writes[0]==4);
    java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1), release=new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicReference<Throwable> threadFailure=new java.util.concurrent.atomic.AtomicReference<>();
    Map<String,Object> competing=plans.preview("u",steps(writes,1),()->{},audit,now());
    Map<String,Object> running=plans.preview("u",java.util.Arrays.asList(new BaskStreamModelPlans.Step(BaskStreamModelPlans.map("action","invoke"),()->{entered.countDown();if(!release.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("status blocked");return BaskStreamModelPlans.map("outcome","invoked");})),()->{},audit,now());
    Thread worker=new Thread(()->{try{apply(plans,running,"running",()->{});}catch(Throwable e){threadFailure.set(e);}});
    worker.start();check(entered.await(2,java.util.concurrent.TimeUnit.SECONDS));
    try {
      check("applying".equals(plans.status("u",(String)running.get("planId"),now()).get("state")));
      check("applying".equals(apply(plans,running,"running",()->{throw new AssertionError("duplicate executed");}).get("state")));
      rejects("model_busy",()->apply(plans,competing,"separate",()->{}));
      rejects("plan_closed",()->plans.cancel("u",(String)running.get("planId"),now()));
    } finally {release.countDown();worker.join(2000);}
    check(!worker.isAlive());if(threadFailure.get()!=null)throw new AssertionError(threadFailure.get());
    check("applied".equals(plans.status("u",(String)running.get("planId"),now()).get("state")));
    check(BaskStreamModelPlans.digest(BaskStreamModelPlans.map("a",1,"b",2)).equals(BaskStreamModelPlans.digest(BaskStreamModelPlans.map("b",2,"a",1))));
    check(!BaskStreamModelPlans.digest(BaskStreamModelPlans.map("a","1")).equals(BaskStreamModelPlans.digest(BaskStreamModelPlans.map("a",1))));
    BaskStreamModelPlans ledger = new BaskStreamModelPlans(); int[] none={0};
    Map<String,Object> otherUser=ledger.preview("v",steps(none,1),()->{},audit,now());
    Map<String,Object> first=ledger.preview("w",steps(none,1),()->{},audit,now());
    for (int i=0;i<BaskStreamModelPlans.MAX_PREVIEWS_PER_USER;i++) ledger.preview("w",steps(none,1),()->{},audit,now());
    rejects("plan_not_found",()->ledger.status("w",(String)first.get("planId"),now()));
    check("preview".equals(ledger.status("v",(String)otherUser.get("planId"),now()).get("state")));
    System.out.println("PASS: per-user preview cap drops that user's oldest preview only");
    System.out.println("PASS: preview isolation, principal/hash binding, master-off, stale checks, reconnect deduplication, key conflicts, stop-on-failure, cancellation, expiry, audit failure after write, concurrent status/deduplication/apply exclusion, canonical hashing");
  }
}
'''
with tempfile.TemporaryDirectory(prefix='bask-model-plans-') as tmp:
    path = Path(tmp) / 'ModelPlanRegression.java'
    path.write_text('\n'.join(sorted(imports)) + '\n' + main + '\n' + '\n'.join(bodies))
    subprocess.run([os.environ.get('JAVA', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java'), str(path)], check=True)
