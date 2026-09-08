# baskStream maintenance fixes, 2026-09-06

These are source changes against `d236354a9b2773d08e7161289bca8dfa505aaa12`. The existing JAR, service properties, module descriptors, authentication defaults, API version, and station have not been changed. No Niagara module build or deployment was performed.

## Implemented

| Area | Cause and change | Verification |
| --- | --- | --- |
| ORD policy | A later compound query or parent traversal could escape a matching prefix. Reject compound and dot-segment inputs at the policy gate. | Actual policy source regression cases for allowed, outside, compound and parent traversal paths. |
| Subscriptions | Heartbeat milliseconds were supplied as Subscriber depth. Use depth zero for each explicitly registered point, alarm service and model component; model recursion remains explicit. | Installed Niagara Subscriber Javadoc and source review; station COV/model checks pending. |
| Inbound work | An unbounded executor retained arbitrary numbers of requests. Bound each session to 32 queued tasks and close overloaded sessions. | Source review and Java syntax check. |
| Outbound work | Blocking socket writes stalled their calling thread. Use Jetty's asynchronous callback overload with one send in flight, FIFO ordering, and limits of 128 frames or 16 MiB including the active frame. Overflow closes the session. | Actual connection source with test doubles: FIFO, single in-flight send, close while pending, overflow, failed-send cleanup. |
| Write cancellation | Disconnect drained queued work; interrupted settle waits did not prevent later writes. Cancel queued tasks immediately and check session closure/interruption between writes and immediately before invocation. | Source review; native write/disconnect test pending. An already invoked Niagara action cannot be rolled back. |
| Partial write results | Native runtime failures escaped the per-point result loop. Return a `write_failed` entry and retain other results. | Source review; Niagara action failure test pending. |
| Group replacement | New points were admitted before obsolete references were released. Release obsolete references from the replaced group first, retaining references owned by other groups/direct subscriptions. | Source review; at-capacity replacement test pending. Existing partial-success semantics remain; replacement is not transactional. |
| Group bounds | Arbitrarily many names could refer to the same points. Bound group count by `maxSubscriptionsPerClient`, with a minimum bound of one. | Source review. |
| Lease timers | Cancellation retained scheduled tasks and unchanged expiry caused repeated scheduling. Enable remove-on-cancel and reuse the existing timer when the next deadline is unchanged. | Source review; station lease expiry/renewal checks pending. |
| Browse/search | Depth alone did not bound browse; search eagerly resolved siblings before checking budgets. Browse now checks a shared 5,000-child/5-second budget and adds `truncated: true` when exhausted. Search checks time and an examined-child budget before resolving each child. | Source review. Native `getNavChildren()` and individual resolution calls are still synchronous and cannot be preempted by these cooperative limits. |
| Tag writes | `Tags.set` reports whether the collection changed, not whether the operation succeeded. Successful no-ops now return `ok: true, changed: false`; exceptions still report failure. | Installed Tags Javadoc and source review. |
| Relations | Unknown directions matched both directions. Reject invalid explicit directions before deleting anything. Direct/implied classification now keys on ID, direction and endpoint ORD instead of ID alone. | Source review; mixed direct/implied relation test pending. Equivalent endpoints represented by different ORDs still need station verification. |
| Read completeness | History/alarm limits silently omitted records. Add `truncated` after detecting an additional qualifying record. | Source review; zero/exact-limit/over-limit station data checks pending. |
| Browse permissions | Unreadable or failed-to-resolve children fell back to named metadata. Omit those children. | Source review; restricted-user browse check pending. |
| MessagePack | Trailing bytes and duplicate keys were accepted; uint64 overflow became negative. Reject all three. Decoder now takes the configured message limit. | Current codec source regression tests pass. |
| Grafana live | Read timeouts were treated as recoverable, and lease renewal could occur after station idle expiry. Treat timeout as fatal; use a dedicated reader with independently scheduled heartbeat/renewal and close/join it at teardown. | All Go package tests pass with race detection; added fatal-timeout and heartbeat interval tests. |

Jetty's [RemoteEndpoint API](https://javadoc.jetty.org/jetty-9/org/eclipse/jetty/websocket/api/RemoteEndpoint.html) documents the callback overload used here as asynchronous. The transport harness uses test doubles and is not a Jetty or Niagara integration test.

## Compatibility and remaining review items

Normal operations retain their names and existing fields. `changed` and `truncated` are additive. Clients sending compound/dot-segment ORDs, duplicate keys or trailing data now receive rejection. Very large browse results and overloaded sessions now encounter explicit resource limits. A deployment needs to test these thresholds against the real application's traffic.

The evaluation is not fully closed:

- **F01:** The demonstrated raw-ORD escape is blocked. A complete authorization review of resolved targets, aliases and hierarchy bindings still needs the existing station's examples and permission contexts.
- **F04:** Socket writes are asynchronous. Alarm snapshot queries, encoding and some event processing still run on callback/scheduler paths. Moving those across executors changes event ordering and requires station acceptance tests.
- **F06:** The tracked release JAR remains stale relative to source. It has intentionally not been replaced. The user must build, verify contents, sign as appropriate and deploy the resulting artifact.
- **F16:** Decoder size now follows configuration. Jetty factory/session limits, path naming and enabling periodic revalidation on already connected clients retain existing lifecycle behavior. Reconnect/restart semantics need a separate tested change.
- **F17:** Unreadable child fallback is fixed. Related metadata and relation endpoint authorization are still open, as are live alarm visibility and cached subscription permission changes identified in the evaluation. This patch does not certify those boundaries.

Broad architecture restructuring and station-dependent security behavior have not been guessed into the working product.

## Checks performed

From the module repository:

```sh
python3 tests/protocol_regression.py
python3 tests/transport_regression.py
/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java tests/SyntaxCheck.java baskStream-rt/src
git diff --check
```

From the Grafana plugin directory:

```sh
go test -race ./pkg/...
```

All passed. The Java syntax check parses 16 project sources as Java 8, excluding macOS resource-fork files. It does not resolve Niagara API types, run annotation processing or generate module classes. The two Java harnesses run project-owned source in isolation and use test doubles for platform boundaries.

## User build and station acceptance

Root `AGENTS.md` reserves Gradle, Slot-o-matic, JAR compilation, deployment, signing and station tests to the user. After the user builds a candidate, test it with the existing application and its current points:

1. Keep the application open and change point values externally; verify initial reads and COV, including nested model subscriptions and alarms.
2. Replace a full subscription group with different points; test shared references, direct references, renewal and expiry.
3. Disconnect during a multi-point write; verify later entries are not invoked. Include one failing native action in an otherwise valid batch.
4. Exercise a slow reader and request burst, then verify other clients remain responsive and metrics return to baseline after disconnect.
5. Repeat tag set with the same value, reject a misspelled relation direction, and inspect direct/implied relations sharing an ID.
6. Check restricted-user browse and over-limit history/alarm responses. Review truncation handling in existing consumers.
7. Leave a Grafana live query open across several station idle periods and renewals, then cancel it and verify session cleanup.

Keep the current working JAR available for rollback. These source checks are not station acceptance evidence.
