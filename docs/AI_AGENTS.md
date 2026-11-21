# AI agents (API 1.8; direct kinds of work since 1.11; one setting per kind since 1.13)

baskStream can tell an AI agent apart from a person, ask it why it is changing something, keep it within limits, and let a person approve its writes before they run. All of it is optional: with nothing configured, nothing changes.

It sits on top of Niagara rather than replacing it:

- **Niagara roles stay the hard boundary.** What an agent may read, write or invoke is still decided by its Niagara user's roles and categories. An agent that should only look gets a user without write permission.
- **Niagara's audit history stays the record of truth.** Approved and direct changes are audited by Niagara as usual. baskStream adds one `Agent` record next to each, with what Niagara can't express: who the agent is, why it acted, and what happened to the request.

## Use as much as you like

| Level | What you do | What you get |
| --- | --- | --- |
| 0 | Nothing | Agents that call `declare_actor` follow the agent rules below and leave `Agent` records. Everyone else is unaffected. |
| 1 | Put the agent's Niagara login in **`agentUsers`** | That login follows the agent rules whether or not it declares itself. This is the one setting most stations need. |
| 2 | Turn on the **`agentDirect…`** settings you want | The agent can do those kinds of work by itself (draw graphics, run discovery, build logic, tag, schedule, acknowledge alarms) while its point writes still wait for a person. |
| 3 | Adjust the other `agent…` settings | Refuse or allow point commands outright, change limits, add value ranges. |

Recommended setup: give each agent its own Niagara user (for example `ai-claude`) with a role covering only what it should touch, and list it in `agentUsers`.

Levels 0, 1 and 3 work from API 1.8. Level 2 needs API 1.11. This page describes API 1.13; [what changed in 1.13](#what-changed-in-api-113) is at the end.

## In a bask workspace

`bask workspace --agent-user ai-claude` starts the station panes on your own login and the AI agent's pane on that Niagara user. bask asks for the agent user's password once, saves that login and uses it from then on; plain `bask workspace` is enough afterwards. As it starts it reports which user the agent is signed in as and whether the station lists that user in `agentUsers`. See [the CLI's workspace section](../cli/README.md#workspace).

## Settings

All are properties on **BASkStreamService**. The easiest place to set them is the service's **baskStream Settings** view, on its **AI agents** tab (in Workbench: right-click the service → Views); see [the settings view](#the-settings-view). The property sheet shows the same slots.

| Property | Default | Meaning |
| --- | --- | --- |
| `agentUsers` | blank | Niagara logins that are agents, comma separated. |
| `agentPointWrites` | ask | What an agent's point command does. `refuse`: it is refused. `ask`: it becomes a **proposal** a person approves. `allow`: it is written, within the limits below. |
| `agentDirectFiles` | blank | Station file paths an agent may write and delete, comma separated, `*` matching anything. `^bask/*` covers the graphics bask keeps in the station. Blank = none. A path that does not start with `^` is ignored; the settings view will not save one. |
| `agentDirectDiscovery` | false | Agents may start BACnet discovery, cancel a job, and add the devices and points discovery found. |
| `agentDirectModelEdits` | false | Agents may apply any model plan: create, change, link, rename, move and delete components, and invoke actions. This is the broad one (see below). |
| `agentDirectTags` | false | Agents may write tags and relations. |
| `agentDirectSchedules` | false | Agents may change schedules. |
| `agentDirectAlarms` | false | Agents may acknowledge and clear alarms. |
| `agentRequireReason` | true | Every agent change or proposal must include a `reason`. |
| `agentMaxChangesPerMinute` | 10 | Changes and proposals per agent user per minute. `0` = no limit. |
| `agentAllowEmergency` | false | Allow emergency (priority level 1) commands. Normal agent commands use level 8 or the fallback. |
| `agentBounds` | blank | Value limits for agent writes, one rule per line: an ORD pattern and `min..max`, e.g. `slot:/Drivers/*/ZoneSP 68..76`. `*` matches anything; either end may be left out (`..80`). The first matching rule applies. Any number of rules. |
| `agentUnlistedPoints` | allow | What an agent's command does on a point no rule in `agentBounds` names. `allow`: whatever `agentPointWrites` says. `ask`: a proposal, even when `agentPointWrites` is `allow`. `refuse`: refused. It only ever makes a command stricter. |
| `agentAskKinds` | blank | Kinds of change that **wait for a person** instead of being refused when the setting above does not allow them directly: any of `files`, `discovery`, `modelEdits`, `tags`, `schedules`, `alarms`, comma separated (API 1.14). |
| `agentProposalMinutes` | 15 | How long a proposal waits for a person before it expires. Up to 10080, a week. |
| `agentAlarmClass` | blank | An alarm class. While a change waits for a person, or a check after a change has failed, the station keeps one alarm open in it, so it reaches whoever that class notifies. Blank = no alarm (API 1.14). |
| `agentChangeHistory` | 200 | How many agent changes are kept, for a week at most, so they can be listed and put back (API 1.14). |
| `pendingProposals` | read-only | One line per waiting proposal: id, change, target, agent and reason. |
| `agentAttention` | read-only | What needs a person now: changes waiting, and checks that failed in the last day. Blank when there is nothing. |

A point's own `min`/`max` facets always limit agent writes too.

Each setting stands alone: none of them changes what another means. `agentApprovalRequired` and `agentBound1`…`agentBound4` are still on the service, hidden, for stations saved before API 1.13 (see [what changed](#what-changed-in-api-113)).

## Profiles: different rules for different agents

The settings above are one set of rules for every agent. A **profile** gives chosen Niagara users their own. Use one per job: a user that draws graphics, another that tunes setpoints, a third that brings in a new network for two weeks.

A profile is a `baskStream:AgentProfile` component under BASkStreamService; its name is the profile's name. Add one on the AI agents tab of the settings view (**+ Add a profile**), or from the `baskStream` palette.

| Property | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Off: the profile's users can read and change nothing. |
| `users` | blank | The Niagara users it covers, comma separated. A user in two profiles follows the first. |
| `expires` | null | When the profile stops allowing changes. After it, the users can read and change nothing. |
| `pathPatterns` | blank | The parts of the station these users may reach, one slot path per line. It narrows the service's `allowedPathPatterns` and never widens it. Blank = whatever the service allows. |
| `agentPointWrites`, `agentDirect…`, `agentRequireReason`, `agentMaxChangesPerMinute`, `agentAllowEmergency`, `agentBounds`, `agentUnlistedPoints` | as on the service | The same settings, for these users only. |

- **A listed user is an agent**, whether or not it is also in `agentUsers`, and follows its profile in place of the service's agent settings. Those remain the default rules: for agent users no profile lists, and for a session that declares itself an agent.
- **A profile replaces the default rules; it does not add to them.** It can be narrower or wider. What it cannot pass are `writesEnabled`, `modelEditsEnabled`, the service's `allowedPathPatterns`, and the user's Niagara roles.
- **Off or ended never means "a person".** The users stay agents with nothing allowed. Deleting a profile is different: its users go back to the default rules if `agentUsers` lists them, and are otherwise no longer agents.
- **While `pathPatterns` is set**, everything the session reads, watches, browses, searches and changes is held to those paths, alarms and model notices included, and BQL queries are refused (as they are whenever the service's own paths are narrowed).
- The rate limit, proposals and audit records are per Niagara user, as before. `agentProposalMinutes` is one setting for every agent.
- `capabilities.agents.profile` names the profile a session follows (null for the default rules), `profileOff` says why it allows nothing when it is off or ended, and `pathPatterns` gives its narrower reach.

Niagara roles remain the stronger boundary. A profile's paths limit what goes through baskStream; they do not change what the user could do by signing in to the station another way. Give each agent user a role that covers only its job as well.

## What an agent may do by itself

Every change an agent can ask for is one of these kinds, and each kind has its own setting:

| Kind of work | Operations | Allowed directly when |
| --- | --- | --- |
| Commanding a point | `write` | `agentPointWrites` is `allow` (and, for a point no value limit names, `agentUnlistedPoints` is too). With `ask` it becomes a proposal; with `refuse` it fails with `agent_writes_refused` |
| Station files, such as graphics | `write_file`, `delete_file`, `write_px` | the path is under one listed in `agentDirectFiles` |
| Discovery | `discover`, `cancel_job`, applying a plan that `add_discovered` built | `agentDirectDiscovery` |
| Building and changing the station (programming) | `apply_model_changes` for any plan, and `attach_px_view` | `agentDirectModelEdits` |
| Tags and relations | `write_tags`, `write_relations` | `agentDirectTags` |
| Schedules | `write_schedule` | `agentDirectSchedules` |
| Alarms | `ack_alarm(s)`, `clear_alarm(s)` | `agentDirectAlarms` |
| Deciding a proposal | `approve_proposal`, `reject_proposal` | never: a person decides |

- A refused change comes back as `approval_required`, with a message that names the setting that would allow it, and it is recorded as `refused`.
- **A kind named in `agentAskKinds` waits for a person instead** (API 1.14). The request is answered with the error code `change_proposed`, `outcome: "proposed"` and the proposal. It is an error on the wire so that no client, old or new, takes the change for done. See [any kind of change can wait](#any-kind-of-change-can-wait-for-a-person).
- Direct changes still need a reason, count against `agentMaxChangesPerMinute`, and are limited by the agent's Niagara role. Each leaves a `completed` record.
- `agentDirectModelEdits` reaches whatever the Niagara role allows in the station tree, which includes the things the narrower switches cover (a plan can add a tag slot or edit a schedule's properties). Leave it off and use the narrower ones unless the agent is meant to build.
- **Commanding a point always goes through `write`.** An agent's model plan may not invoke `set`, `override`, `auto` (or the emergency and boolean forms) on a writable point, nor set its `in1`…`in16` inputs or `fallback`; that is refused with `agent_use_write`, whatever `agentPointWrites` says. Linking logic into a point's input is programming and is allowed with model edits.
- `capabilities.agents.direct` reports what agents may do directly right now: `pointWrites`, `files` (the path patterns), `discovery`, `modelEdits`, `tags`, `schedules`, `alarms`. `capabilities.agents.pointWrites` and `unlistedPoints` give the two modes as `refuse`, `ask` or `allow` (API 1.13).
- `capabilities.agents.kinds` gives every kind of work as `refuse`, `ask` or `allow` (API 1.14). For `files`, `allow` means under the paths in `direct.files`; `filesElsewhere` says whether any other path waits for a person (`ask`) or is refused.

### A programming agent

An agent that writes control logic and nothing else is one profile:

| Setting on the profile | Value |
| --- | --- |
| `users` | the agent's Niagara user |
| `agentDirectModelEdits` | true |
| `agentPointWrites` | refuse |
| everything else | left off |
| `pathPatterns` | the branch it works in, such as `slot:/Logic/AHU_1/*` |

Checked on a station: such an agent adds logic blocks, sets their properties, wires points into blocks and blocks into a point's input, and adds, renames and moves components, all inside its branch. It cannot command a point by any route (not with `write`, and not by setting a writable point's `fallback` or inputs or invoking its actions in a plan), write a file, a tag or a schedule, see or build anything outside its branch, or edit baskStream's own settings or its profile. Each plan it applies is listed and a person can put it back. `modelEditsEnabled` has to be on for the station.

To have a person look at each plan first, leave `agentDirectModelEdits` off and put `modelEdits` in `agentAskKinds`: the agent's plans then wait on the Approvals tab.

For an agent that draws graphics and brings equipment in through bask, a typical setting is `agentDirectFiles = ^bask/*` and `agentDirectDiscovery = true`, with `agentMaxChangesPerMinute` raised for discovery (each job and each batch of up to 100 additions is one change).

## Any kind of change can wait for a person

From API 1.14 a proposal is not only a point command. Name a kind in `agentAskKinds` and an agent's change of that kind, when it is not allowed directly, is kept for a person:

- **It is tried first, without being made, as the agent.** A path that does not exist, a target outside the agent's reach or one its Niagara role does not allow is refused straight away, so nobody is asked about a change that could never run. Operations with a dry run are rehearsed with it; tag and relation targets are read; a plan was already previewed.
- **Approving makes the change with the approver's Niagara permissions**, still held to the agent's narrower reach if its profile has one.
- **A model plan** is kept as the changes the agent sent and the differences its preview showed. On approval it is previewed again as the approver and applied only if it would do the same thing. If the station has changed since, the proposal fails with `stale_plan` and the agent previews again. The plan keeps the agent's restrictions: it cannot command a writable point or edit users and roles.
- **Size.** A waiting change holds its request, so a file change that waits can be 256 KB at most. Larger ones are refused with a message saying so.
- **What cannot be put back is said before approval**: a proposal lists `irreversible` steps (a delete, an invoked action, an alarm acknowledgement, discovery).

## Changes can be listed, checked and put back

Every change an agent makes, directly or by approval, is kept on the station for a week (`agentChangeHistory` entries), with the station, so it is still there after a restart.

- **List:** the settings view's **Activity** tab, `bask changes`, or `list_changes`. A change is `pending`, `approved`, `applied` (made by the agent directly), `rejected`, `expired`, `failed` or `reverted`.
- **Put back:** **Put back** on the Activity tab, `bask revert P7`, the service's **Revert Change** action, or `revert_change`. People only; it runs with their Niagara permissions and is recorded.

| Kind | What putting it back does |
| --- | --- |
| Point command | Writes the old value at the same priority level, or releases the level if it was empty. `set` restores the old fallback |
| Station file | Deletes a file the change created; restores the copy under `^bask/backups` for one it replaced. An agent's own file writes always keep that copy unless the request says `backup: false` |
| Schedule | Writes the days back as they were |
| Tags | Sets each tag to its old value, or removes one that was not there |
| Relations | Removes the ones that were added. Removed ones are not kept |
| Model plan | Runs the reverse plan: a create becomes a delete, an update restores the old values, a rename, a move, a link and an added slot go back |
| Deleted file, alarm acknowledgement or clear, discovery, a plan's delete and invoke steps | Cannot be put back. The change says why (`notRevertible`), or lists the steps (`notReverted`), and the rest can be put back with `partial` |

- A point, schedule or file that has been **changed again since** is not put back (`change_conflict`) unless `force` is set. Tags, relations and plans are put back as recorded; a plan's own preview refuses a step whose target is gone.
- **The check afterwards.** After an agent's point command the station reads the point again and records `passed` or `failed` on the change. By default it looks after a minute, and the point has to be readable and not in fault. A `write` may say what it expects instead: `"expect": { "point": "slot:/…/ZoneTemp", "min": 68, "max": 74, "withinMinutes": 20 }`. A failed check shows on the Activity tab, in `agentAttention`, in the audit history (`check failed P7`) and as the alarm. It does not put the change back by itself.
- A direct change is listed a moment after its reply, not before.

## Approving proposals

A person (any user not listed in `agentUsers`, in a session that hasn't declared itself an agent) can decide a proposal in three places:

- **Workbench:** the **Approvals** tab of the service's baskStream Settings view lists each waiting proposal with **Approve** and **Reject** buttons. Or read `pendingProposals` on the service, then right-click the service → **Actions → Approve Proposal** (or **Reject Proposal**) and enter the id, e.g. `P7`.
- **bask:** `bask proposals`, `bask approve P7`, `bask reject P7`, or the dashboard's **AI Activity** view (`0`; `a` approves, `x` rejects).
- **The API:** `approve_proposal` / `reject_proposal`.

Approving makes the change **with the approver's Niagara permissions**, so the approver needs the permission the change itself needs (invoke on the point, write on the file or component), and Niagara's audit history shows the approver making the change. Proposals expire after `agentProposalMinutes` (up to 10080, a week). From API 1.13 the waiting ones are stored with the station, so they are still waiting after a restart if the station was saved after they were made; one made after the last save is lost.

With `agentAlarmClass` set, a waiting proposal also raises an alarm in that class, so the approval does not depend on someone looking at the service.

## What gets recorded

Every agent action adds an audit record with operation **`Agent`** to the station's audit history (Workbench: the station's Audit History, filtered by operation). Its fields:

- **user:** the Niagara user who acted (the approver, for approvals)
- **target / slot:** the point (or ORD) and the action, e.g. `override`
- **value:** `outcome=…; agentUser=…; agent=…; model=…; for=…; change=…; reason=…`

Outcomes are `proposed P7`, `approved P7 by ben`, `rejected P7 by ben`, `expired P7`, `reverted P7 by ben`, `revert failed P7 by ben`, `check failed P7`, `written`, `completed` (other direct changes) and `refused` (with a `code`). Because the record sits next to Niagara's own record of the change (same user, target and time), retention, export to a Supervisor and history queries all work as for any audit history. `read_agent_log` returns these records as structured fields.

## Protocol

```json
{ "op": "declare_actor", "id": "1", "name": "Claude Code", "model": "claude-opus-5-5", "onBehalfOf": "ben" }
```

Reply `actor_declared` with `agents`: the rules that now apply (`isAgent`, `pointWrites`, `unlistedPoints`, `approvalRequired`, `direct`, `reasonRequired`, `maxChangesPerMinute`, `allowEmergency`, `bounds`, `proposalMinutes`, `pendingProposals`). `approvalRequired` is true exactly when `pointWrites` is `ask`. `capabilities.agents` carries the same block. Send `kind: "person"` for a person; a listed agent user stays an agent either way. The name, model and `onBehalfOf` are claims recorded alongside the Niagara user; the login stays the identity.

An agent's `write` takes a request-level `reason`. Each point is checked (permissions, action, emergency, facets and bound rules), then:

```json
{ "point": "slot:/Drivers/.../ZoneSP", "ok": true, "outcome": "proposed",
  "proposal": { "id": "P7", "status": "pending", "description": "override 72 for 30 min", "reason": "Room 204 is too cold", "expiresAt": 1790000900000 } }
```

When the command is allowed the entry is a normal write result with `outcome: "written"`. Refused points have `ok: false` and a `code`. With `agentPointWrites` on `refuse` the whole request fails with `agent_writes_refused`.

| Operation | Use |
| --- | --- |
| `declare_actor` | Say who is behind the session. |
| `list_proposals` | Proposals this session may see (`status` filter): an agent sees its own; a person sees point commands for points they can read, and every other kind. |
| `approve_proposal` | `{ "proposal": "P7" }` makes the change as the approver. People only. |
| `list_changes` | Every agent change, including the direct ones (`status`, `kind` filters) (API 1.14). |
| `revert_change` | `{ "change": "P7" }` puts it back as the caller; `force`, `partial`. People only (API 1.14). |
| `reject_proposal` | `{ "proposal": "P7", "note": "…" }`. People only. |
| `explain_change` | `{ "change": "write_file", "path": "^px/Home.px" }` says what would happen and why, without doing it (API 1.13). |
| `read_agent_log` | `Agent` records, newest first (`since`, `limit`). Needs read permission on the audit history. |

`explain_change` replies with `explanation`: `{ change, user, isAgent, profile, outcome, rule, message }`, where `outcome` is `allow`, `ask` or `refuse` and `rule` is the setting that decided (`agentPointWrites`, `agentDirectFiles`, `writesEnabled`, a profile's `enabled`…). It reads the same rules as the real check, is not recorded, and does not count against the rate limit. It does not judge Niagara roles. A person may add `user` to ask about any Niagara user; an agent may ask only about itself. With `change: "write"`, add `point` to have value limits and `agentUnlistedPoints` taken into account.

`proposal_cov` notices tell each session about proposals it may see as they are created and decided, so an agent learns the outcome without polling.

A change of another kind that waits for a person is answered like this (API 1.14):

```json
{ "op": "error", "id": "7", "code": "change_proposed", "outcome": "proposed",
  "message": "This change was not made. It is waiting for a person to approve it as P8. Do not send it again.",
  "proposal": { "id": "P8", "status": "pending", "kind": "schedules", "operation": "write_schedule", "point": "slot:/Schedules/Occupancy", "description": "write_schedule slot:/Schedules/Occupancy ([monday])" } }
```

The SDK raises it as `ChangeProposedError` with the `proposal`; `bask` prints `proposed P8` and exits with code 2; the MCP server returns `outcome: "proposed"` as a result, not an error.

Errors: `reason_required`, `approval_required`, `change_proposed`, `agent_writes_refused`, `agent_rate_limited`, `agent_priority_blocked`, `agent_value_out_of_bounds`, `agent_cannot_approve`, `proposal_not_found`, `proposal_closed`, `not_revertible`, `change_conflict`, `change_failed`, `stale_plan`, `plan_partial`.

## The settings view

`baskStream-ux.jar` adds a view to the service, **baskStream Settings**. It is the first entry under right-click → **Views** in Workbench. It sets the same properties as the property sheet, in seven tabs, with a sentence under each setting and its slot name beside it:

| Tab | What is on it |
| --- | --- |
| Status | Connection and request counts, a summary of what is allowed, what needs a person now, and, on a service nothing has been set up on, what to do first |
| Access | The service switch, the three "may clients change…" switches, path patterns and origins |
| AI agents | The default rules and each profile, chosen at the top, with **+ Add a profile**. For each: agent users (or the profile's users, on switch, end time and reach); one row per kind of work with Refuse, Ask a person or Allow; value limits as a table; the rule for points no limit names; reason, rate, emergency, proposal time, the alarm class and how many changes are kept; and **Check a change**, which says what the station would do with a change by a user and which setting decides |
| Approvals | Waiting proposals of every kind, each with Approve and Reject |
| Activity | Every agent change, newest first, with what the check afterwards found, and **Put back** on each one that can be |
| Limits | Connections, message size, subscriptions and timings |
| Security | Sign-in hardening and audit records |

- Nothing is written until **Save**; **Discard** drops the edits. The tab warns when a setting would have no effect (changes off for everyone, no agent users listed, a value limit that is not understood).
- Every row offers "Ask a person". For station files, Allow lists the paths and has a box for asking a person about any other path.
- The view does not open in a web browser at the service's own address: Niagara sends a browser there to the service's `/stream` endpoint. Use it in Workbench.

## What changed in API 1.13

- **One setting per kind of work.** Before, `agentApprovalRequired` off made every kind of change direct and the six `agentDirect…` settings were ignored. Now point commands have their own setting, `agentPointWrites`, and the `agentDirect…` settings always decide the other kinds.
- **A station saved with `agentApprovalRequired` off keeps what its agents could do.** When the service starts it sets `agentPointWrites` to `allow`, `agentDirectFiles` to `^*` and the five other `agentDirect…` settings on, turns the old switch back on, and says so in the station log. Review those settings afterwards, and save the station.
- **Value limits are one list.** `agentBounds` holds any number of rules; a rule left in `agentBound1`…`agentBound4` is moved there when the service starts.
- **New:** `agentUnlistedPoints`, the `refuse` mode for point commands, error `agent_writes_refused`, the settings view, [profiles](#profiles-different-rules-for-different-agents), `explain_change`, and proposals that survive a restart.
- `approval_required` messages no longer begin "With agentApprovalRequired on"; they still name the setting that would allow the change.

## What changed in API 1.14

- **Any kind of change can wait for a person**: `agentAskKinds`, on the service and on each profile, and the `change_proposed` answer. A station that leaves it blank behaves as before.
- **Changes are kept, listed, checked and can be put back**: `list_changes`, `revert_change`, the Activity tab, `agentChangeHistory`, and `expect` on a `write`.
- **A notice a station can route**: `agentAlarmClass` and `agentAttention`.
- Proposals may wait up to a week.
- **Changed:** an agent's own `write_file` and `write_px` keep the old content under `^bask/backups` unless the request says `backup: false`.
- **Changed:** `list_proposals` lists a week of decisions, not an hour, and a person sees proposals that are not point commands without a per-target check.
- The view gains the Activity tab, Check a change and a first-run note.
- A service dropped from the palette starts with `writesEnabled` off.

## Not covered yet

- One wait time for every kind of change, and one history size.
- A failed check does not put a change back by itself.
- A change made by a person is not listed or put back; this is the record of what agents did.
- Putting back a plan step that set a password or another hidden value fails, because the old value was never kept.
- A profile is found by Niagara user. Two agents that share one login share a profile.
- Agent details are what the client declares. Use a dedicated Niagara user per agent when the identity must be certain.
