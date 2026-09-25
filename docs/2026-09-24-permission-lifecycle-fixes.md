# baskStream permission and session-lifecycle fixes, 2026-09-24

These are source changes on top of the uncommitted API 1.6 working tree. No Gradle build, Slot-o-matic run, JAR build, deployment or station test was performed. API facts were checked against the installed N4.15.1.16 `niagaraJavadoc.jar` and `docDeveloper-doc.jar`.

## Implemented

| Area | Symptom and cause | Fix | Verification |
| --- | --- | --- | --- |
| Alarm visibility | `read_alarms`, alarm subscription snapshots and live `alarm_cov` events returned every alarm. Only `allowedPathPatterns` was checked, and that check is skipped under the default `slot:/*`. | Records are filtered by `BAlarmService.lookupAlarmClass(record.getAlarmClass()).getPermissions(cx).hasOperatorRead()`. Permissions are cached per alarm class within a read. The live event callback applies the same check. | Javadoc: `lookupAlarmClass` returns the default class for unknown names; `BComponent.getPermissions(cx)` returns the user's permissions. Station check pending. |
| Alarm ack/force-clear | Any authenticated user could acknowledge or force-clear any alarm while writes were enabled. The `writesEnabled` check sat after the record lookup, which revealed whether a UUID existed. | The writes gate now runs before any lookup. Unreadable records report `invalid_alarm`, the same as missing ones. Acknowledge requires operator write on the alarm class; force-clear requires admin write. The new per-entry code is `forbidden_alarm`. | The Developer and Alarms guides do not state Niagara's exact ack permission, so this is the strict reading. Confirm with a restricted user on-station. |
| Point history | Reading a history through its point checked only the point, although `BIHistory` is a separate protected object. | Histories the user cannot read (`getPermissions(cx).hasOperatorRead()`) are omitted from `describe_history`/`read_history` point results. | Javadoc: `BIHistory extends BIProtected`. Station check pending. |
| Point write actions | `OrdTarget.canInvoke()` on the point itself checks only operator invoke (Javadoc), so an operator could run admin-only actions such as `emergencyOverride`. | Each action is checked with `Flags.isOperator(component, action)`, requiring operator or admin invoke to match. The new per-point code is `forbidden_action`. | Javadoc for `BComponent.canInvoke`. Station check pending. |
| Model-edit links | `add_slot` and `update` could create or re-point a `BLink`/`BRelation` without the endpoint checks `create_link` performs. | `decode` rejects link and relation types. Property paths that are, or pass through, a link or relation are rejected. | `tests/model_adapter_regression.py` gained three rejection cases and passes. |
| Session close | `close()` waited up to 5 s for the worker. It could run on Niagara event threads, the shared scheduler or Jetty threads, sometimes while holding the send lock. If the wait timed out, cleanup ran while the worker was still subscribing points, so those subscriptions leaked. | `close()` no longer waits: it closes the transport, clears pending COV and calls `shutdownNow()`. Niagara subscriptions and timers are released in the executor's `terminated()` hook, once the worker has stopped. The lease sweep now hops to the session worker rather than taking `subscriptionLock` on the scheduler. The COV callback no longer runs the sweep. | Source review; Java 8 syntax check passes. Station check pending. A worker stuck forever inside a native call still delays cleanup. |
| Lexicon | Keys used `slot.BaskStreamService.x`. The Developer Guide (`localization.html`) says the key is the bare slot name in the declaring type's module. `servletName` belongs to the web module. | Rekeyed all 19 declared service slots to bare names and dropped `servletName`. The type entry was left unchanged. | Workbench property sheet check pending. |

Docs: `docs/THIRD_PARTY_API.md` documents the tighter behaviour and the two new error codes.

### Found while commissioning the BACnet simulator through baskStream

| Symptom | Cause | Fix |
| --- | --- | --- |
| Updating the IP link's `adapter` returned only "Value type is missing or incompatible." | The property is declared with an abstract type, so the value needs an explicit `typeSpec` (`baja:DynamicEnum`), and the error did not say so. | `invalid_type` messages now name the declared and received types and say when a concrete `typeSpec` is required. |
| Three of four MAC address formats were accepted but stored as `null`. | `BacnetOctetString` decodes unparseable text to its null value (the accepted form is space-separated hex, `c0 a8 00 7d ba c0`). | A non-`null` input that decodes to `null` now fails with `invalid_value`. |
| `writeSettleMillis` had no upper bound. | The delay runs once per point in a batch of up to 1,000. | Capped at 5,000 ms. |

## Checks performed

```sh
/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java tests/SyntaxCheck.java baskStream-rt/src
python3 tests/protocol_regression.py
python3 tests/transport_regression.py
python3 tests/model_plan_regression.py
python3 tests/model_adapter_regression.py
```

All pass. These checks do not type-check against Niagara, and they do not prove station behaviour.

## User build and station acceptance

1. Run Slot-o-matic and the module build, then confirm the JAR contains the changed classes.
2. **Alarms:** using a user who lacks read on one alarm class, confirm `read_alarms` and `alarm_cov` hide that class. Confirm ack is refused without operator write and force-clear without admin write. Confirm that a normal operator can still acknowledge, to check the permission choice against how the station's Alarm Console behaves.
3. **Histories:** restrict a history's category and not its point's, and confirm `read_history` on the point omits it.
4. **Writes:** as an operator-invoke user, confirm `set`/`override` work and `emergency_override` returns `forbidden_action`.
5. **Close:** fill a slow client's outbound queue and confirm other clients' COV keeps flowing. Disconnect during a large `replace_subscriptions` and confirm the station's subscription count and driver polling return to baseline.
6. **Lexicon:** open the service property sheet in Workbench and confirm the labels.
