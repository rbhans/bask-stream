# Station model editing (API 1.6)

API 1.6 adds typed editing of the Niagara station component model. It can create installed component types, configure properties, clone, rename, move and delete components, build hierarchy definitions, edit dynamic slots and slot metadata, reorder slots, manage links, and invoke component actions. Drivers, devices, proxy points, services, control logic and schedules can use these same primitives when their installed types and Niagara permissions permit it. Type-specific constraints and licensing still come from Niagara.

This is station component administration. Host shell access, platform software installation, arbitrary filesystem access, and bypassing Niagara permissions are not provided by this API. Vendor action effects, external physical effects, and arbitrary embedded ORD references cannot be fully simulated or undone.

## Write controls

`BASkStreamService.writesEnabled` is the station-side master switch. False blocks point writes, tag and relation writes, alarm acknowledge/clear, and model-plan application for **every** WebSocket client. It is checked at dispatch and immediately before individual mutations. Reads, subscriptions, descriptions and plan-status queries continue working. Previews also need `modelEditsEnabled` (2026-09-28), so a station with model editing off does not accumulate plans. A running action cannot be undone by flipping the switch; subsequent mutations in a batch stop. An interrupted move may finish restoring a detached component to its original parent.

The default is true to preserve existing integrations. `modelEditsEnabled` is a separate opt-in, default false, for the new model editor. Both must be true to apply a model plan. The API does not modify the active baskStream service or its descendants, so it cannot remotely re-enable its own disabled controls. Configure these settings in Workbench. Deleting/moving an ancestor containing the service is also rejected.

Client-side controls do not replace user approval or Niagara permission checks. All model edits require admin-write access; actions additionally require invoke permission. The station's `allowedPathPatterns` is checked for targets, parent/destination paths, new paths, and relevant link endpoints. An arbitrary Niagara action can affect objects beyond its target; this path policy is not a sandbox for vendor action implementations.

### Protected objects

Some parts of a station decide who can reach it and what they may do. Model editing leaves these to Workbench and returns `protected_component`:

- **Protected services:** User, Role, Authentication, Category and Security services, Platform services, Fox and Web services, the Audit History service, the Program service and the baskStream service itself. Nothing inside them can be updated, deleted, moved, renamed or given new slots, and none of their actions can be invoked.
- **Protected creations:** no create or clone may produce a protected service, a second baskStream service, or any `program:` component (these can carry executable code).
- **Password copies:** a clone keeps the source's stored passwords, so cloning anything that holds a password needs admin write on the source, not only read (`forbidden_component`).
- **Confirm-required actions:** an `invoke` of an action Niagara marks confirm-required fails with `confirm_required` unless the change includes `confirm: true`. The preview reports `confirmRequired`, and the plan hash covers it.

Service types that are not installed on a station are skipped.

## Operations

All new request/response operations return `{op:"model_result", id, operation, result}`. Existing response formats are unchanged.

| Operation | Request fields | Behavior |
| --- | --- | --- |
| `describe_component_types` | `typeSpec`, or `module`, `baseType`, `offset`, `limit` | Specific type schema, or paged installed types. Default base `baja:Component`, limit 100, maximum 500. |
| `describe_component` | `ord` | Slot names, types, encoded values, flags, facets, permissions, actions and known link/relation references. |
| `preview_model_changes` | `changes` | Validates 1–100 ordered changes and returns a stored plan, exact normalized diff, hash and expiry. No mounted station edits. |
| `apply_model_changes` | `planId`, `planHash`, `idempotencyKey` | Applies the stored plan once after fresh identity, permission, value and collision checks. |
| `model_plan_status` | `planId` | Retrieves the current principal's retained preview/outcome after reconnect or an uncertain response. |
| `cancel_model_plan` | `planId` | Discards an unapplied preview. Does not undo writes. |

The requested convenience operations also exist: `create_components`, `update_component_properties`, `rename_component`, `move_components`, `delete_components`, `create_hierarchy`, and `configure_hierarchy`. Each accepts a `changes` array of the appropriate action fields, or those fields directly for one change. They **return a preview**, with the same explicit `apply_model_changes` step. No convenience name bypasses plan approval.

### Change actions

| `action` | Fields |
| --- | --- |
| `create` | `parent`, `name`, `typeSpec`; optional `ref`, `properties`, `flags`, `facets`, `collision` |
| `clone` | `source`, `parent`, `name`; optional creation fields. Needs admin write on the source when the copy would hold passwords |
| `update` | `ord`, `properties` |
| `rename` | `ord`, `name`; optional `collision` |
| `move` | `ord`, `parent`; optional `name`, `collision` |
| `delete` | `ord`; `recursive:true` required when it contains child components |
| `create_hierarchy` | Same as create with `typeSpec` fixed to `hierarchy:Hierarchy` |
| `configure_hierarchy` | `ord` of a `hierarchy:Hierarchy`, `properties` |
| `add_slot` | `ord`, `slot`, typed `value`; optional `flags`, encoded `facets` |
| `remove_slot` | `ord`, `slot` of a dynamic non-component property |
| `set_slot_metadata` | `ord`, `slot`; optional `flags`, encoded `facets` |
| `reorder` | `ord`, `slots` listing every dynamic property exactly once |
| `create_link` | `source`, `sourceSlot`, `target`, `targetSlot`, `name`; optional `collision` |
| `delete_link` | `ord` of the target component, `slot` containing the link |
| `invoke` | `ord`, `slot` naming an action; optional typed `parameter`; `confirm: true` when Niagara marks the action confirm-required |

Use returned type specifications, never Java class names. There is no component-type allowlist. Abstract/interface types and illegal parent/child combinations are rejected. Generic actions make driver discovery, polling and other module-specific behavior accessible when exposed as Niagara actions. Async action results say `submitted`, not `completed`; read back the module's status afterward.

Slot names are programmatic Niagara names, escaped when necessary, up to 128 characters. Collisions default to failure. `collision:"suffix"` fixes the first available suffix (`Name2`, `Name3`, …) during preview; it never silently chooses a different name during apply.

`ref` assigns a plan-local identifier to a create/clone result. Later changes can use `@identifier` as their component or parent. These are resolved into absolute paths in the stored diff. Forward references are rejected. Structural edits of overlapping branches, duplicate property edits and combinations of branch moves/deletes with creations or edits beneath them require separate previews to avoid ambiguous ordering.

### Typed values

Simple values use Niagara's encoded text representation. For an existing property the type can be inferred; for a new slot include `typeSpec`:

```json
{
  "displayName": { "encoded": "Building A" },
  "enabled": { "typeSpec": "baja:Boolean", "encoded": "true" }
}
```

These property names are examples; inspect the actual type's slots before using them. Complex values use `{typeSpec, properties:{...}}`, with typed values recursively. Property paths such as `scope/someProperty` can address nested existing values. Child components are created/deleted through component actions rather than replaced using `update`. Read-only/frozen restrictions and Niagara validators apply. Nesting, model snapshot size and request sizes are bounded.

Credential-like property names and password/secret types are redacted in descriptions, diffs and audit details. Fingerprints still include their encoded state, so redaction does not weaken stale-plan checking. Avoid placing secrets in arbitrary unmarked string slots or action parameters: the module cannot infer the semantics of every vendor string.

## Example: create a component tree

```json
{
  "op": "preview_model_changes",
  "id": "preview-building",
  "changes": [
    { "action": "create", "parent": "slot:/Models", "name": "BuildingA", "typeSpec": "baja:Folder", "ref": "building" },
    { "action": "create", "parent": "@building", "name": "Floor1", "typeSpec": "baja:Folder", "ref": "floor" },
    { "action": "create", "parent": "@floor", "name": "Room101", "typeSpec": "baja:Folder" }
  ]
}
```

`slot:/Models` must already exist and be writable. These are ordinary folders; apply appropriate tags/relations with the existing APIs to give them site/building/floor/space semantics. For tag-based Niagara navigation, discover the installed `hierarchy` types, create the hierarchy under its service, then create and configure its supported level-definition children. Actual hierarchy query and scope properties come from those installed type schemas.

Display the returned `result.changes` to the user. Apply exactly that approved plan:

```json
{
  "op": "apply_model_changes",
  "id": "apply-building",
  "planId": "<preview result.planId>",
  "planHash": "<preview result.planHash>",
  "idempotencyKey": "building-a-user-approved-1"
}
```

Successful component changes return current slot ORDs, handles where applicable, and a post-write snapshot. Large snapshots return `truncated:true` and `refreshWith:"describe_component"`; a snapshot read failure is separately marked `unavailable` and does not erase the known write result. Basdraw should bind using those returned slot ORDs. Handle identities are returned as evidence, but this API's model operations currently accept `slot:/` paths.

## Failure and lifecycle contract

- Preview lasts five minutes. Terminal results last thirty minutes. The bounded station-instance ledger holds up to 32 plans. Each user may hold 8 open previews; a ninth preview drops that user's oldest one. When the ledger is full, the oldest finished result is dropped before a new preview is refused with `plan_limit`. It survives WebSocket reconnects, not module/station restarts. Expired/unknown plans fail closed; never reconstruct an uncertain plan and automatically replay it.
- A plan is bound to the authenticated principal and hash. The server applies its stored operations, never a replacement `changes` payload. One key cannot identify two retained plans for the same principal. Repeating the same plan/key returns the recorded outcome, including partial failure, without repeating writes.
- One model plan applies at a time. Another application returns `model_busy`; status and duplicate-key lookup remain available during a running vendor action and report `state:"applying"`. That state is not permission to create a replacement plan.
- There is no blanket transaction across arbitrary Niagara types/actions. `atomic:false` is explicit. Mutations run in order, stop on the first failure, and return step results and `unattempted`. Property batches retain completed property results and the failed/unknown property. A vendor exception can occur after side effects; `outcome:"unknown_or_partial"` means inspect the station before further action.
- Known link/relation references are included for structural changes and checked again before applying. This is not a complete scan of arbitrary ORD strings, graphics or external clients. Moves retain the original component object and use Niagara's pending-move mechanism, with local restoration if destination adoption fails. Path references outside the moved branch are not rewritten. There is no automatic batch rollback or retry.
- Native permission checks, component identity, original property values/metadata, branch fingerprints, and destination collisions are checked again at application. Each mutation rechecks the master switch and its target. Unrelated Workbench/vendor changes are not globally locked; conflicts can still produce an explicit partial result.
- Audit records include principal, plan ID/hash, normalized redacted diff, step start/completion and final state through station logging and Niagara's configured auditor. The auditor/log retention is station configuration; result caching is not a durable transaction journal.
- After each property is set, it is read back. If the component changed it again straight away (for example, a driver that could not act on the new value), the property result and its step carry `reverted: true`. Treat that as a failed edit and check the component's `faultCause`.
- Edits run with baskStream's own Java permissions, not Workbench's. If setting a property makes the component do something baskStream is not permitted to do, such as a driver opening a network socket, Niagara's security manager blocks that side effect. The component then usually reverts or faults. In the live BACnet test, enabling a BACnet/IP port and choosing its adapter failed this way. Make those driver network-port settings in Workbench.
- Existing `subscribe_model` receives the usual component events plus a `model_cov` hint with `event:"model_plan_applied"`, readable subscribed `bases`, and `refreshRecommended:true` after full or partial application. Re-browse those bases, including after reconnect. It is not an exactly-once event log.

## Validation boundary

Source tests exercise the actual plan ledger and resolver using API doubles. Read-only Java type analysis uses installed N4.15 API signatures. None establishes Niagara lifecycle, driver, hierarchy licensing, move-handle preservation, or real-station acceptance. New `writesEnabled` and `modelEditsEnabled` frozen properties require the user's Slot-o-matic/build step. The shipped JAR is not updated by source edits.
