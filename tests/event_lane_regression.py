#!/usr/bin/env python3
"""Run the real BaskStreamEventLane source against a plain JDK thread pool."""
from pathlib import Path
import os, re, subprocess, tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'baskStream-rt/src/com/basidekick/baskstream/BaskStreamEventLane.java').read_text()
source = re.sub(r'^package .*;\s*', '', source, flags=re.M)
imports = '\n'.join(re.findall(r'^import .*;', source, re.M))
source = re.sub(r'^import .*;\s*', '', source, flags=re.M)
java = os.environ.get('JAVA', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java')

test = r'''
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.Logger;

public class EventLaneRegression {
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }

  public static void main(String[] args) throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Logger log = Logger.getLogger("test");

    // Order is kept within a lane.
    List<Integer> seen = Collections.synchronizedList(new ArrayList<>());
    BaskStreamEventLane lane = new BaskStreamEventLane(pool, 1000, n -> () -> seen.add(-n), log);
    for (int i = 0; i < 500; i++) { int v = i; lane.submit(() -> seen.add(v)); }
    waitFor(() -> seen.size() == 500);
    for (int i = 0; i < 500; i++) check(seen.get(i) == i, "order at " + i);

    // A long backlog on one lane does not starve another lane on the same pool.
    CountDownLatch release = new CountDownLatch(1);
    BaskStreamEventLane busy = new BaskStreamEventLane(pool, 100000, n -> () -> {}, log);
    for (int i = 0; i < 5000; i++) busy.submit(() -> { try { release.await(); } catch (InterruptedException e) {} });
    BaskStreamEventLane other = new BaskStreamEventLane(pool, 1000, n -> () -> {}, log);
    CountDownLatch otherRan = new CountDownLatch(1);
    other.submit(otherRan::countDown);
    check(otherRan.await(5, TimeUnit.SECONDS), "second lane ran while the first had a backlog");
    release.countDown();

    // Overflow replaces the backlog with one resync task, then keeps going.
    CountDownLatch gate = new CountDownLatch(1);
    List<String> out = Collections.synchronizedList(new ArrayList<>());
    BaskStreamEventLane small = new BaskStreamEventLane(pool, 10, n -> () -> out.add("resync " + n), log);
    small.submit(() -> { try { gate.await(); } catch (InterruptedException e) {} out.add("first"); });
    waitFor(() -> small.size() == 0);  // the blocking task has been taken
    for (int i = 0; i < 15; i++) { int v = i; small.submit(() -> out.add("e" + v)); }
    gate.countDown();
    waitFor(() -> out.contains("e14"));
    check(out.get(0).equals("first"), "running task finished");
    check(out.get(1).startsWith("resync "), "resync replaced the backlog: " + out);
    check(!out.contains("e0"), "dropped events were not delivered");

    // A closed lane delivers nothing more.
    List<String> late = Collections.synchronizedList(new ArrayList<>());
    BaskStreamEventLane closing = new BaskStreamEventLane(pool, 10, n -> () -> {}, log);
    closing.close();
    closing.submit(() -> late.add("x"));
    Thread.sleep(200);
    check(late.isEmpty(), "closed lane ignored new work");

    // A failing task does not stop the lane.
    List<String> after = Collections.synchronizedList(new ArrayList<>());
    BaskStreamEventLane sturdy = new BaskStreamEventLane(pool, 10, n -> () -> {}, Logger.getAnonymousLogger());
    sturdy.submit(() -> { throw new RuntimeException("boom (expected in test)"); });
    sturdy.submit(() -> after.add("ok"));
    waitFor(() -> after.contains("ok"));

    pool.shutdownNow();
    System.out.println("PASS: event lane order, fairness across lanes, overflow resync, close, failure isolation");
  }

  interface Cond { boolean ok(); }
  static void waitFor(Cond c) throws Exception {
    long end = System.currentTimeMillis() + 10000;
    while (!c.ok()) { if (System.currentTimeMillis() > end) throw new AssertionError("timed out"); Thread.sleep(5); }
  }
}
'''

with tempfile.TemporaryDirectory(prefix='bask-event-lane-') as tmp:
    path = Path(tmp) / 'EventLaneRegression.java'
    path.write_text(imports + '\n' + test + '\n' + source)
    result = subprocess.run([java, str(path)], capture_output=True, text=True)
    lines = [l for l in (result.stdout + result.stderr).splitlines() if 'boom (expected in test)' not in l and 'WARNING' not in l and not l.startswith('\tat ') and 'event task failed' not in l and 'BaskStreamEventLane drain' not in l]
    print('\n'.join(lines))
    if result.returncode != 0:
        raise SystemExit(result.returncode)
