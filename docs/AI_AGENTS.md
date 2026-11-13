# AI agents (API 1.8; direct kinds of work since 1.11)

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
| 3 | Adjust the other `agent…` settings | Turn approval off, change limits, add value ranges. |

Recommended setup: give each agent its own Niagara user (for example `ai-claude`) with a role covering only what it should touch, and list it in `agentUsers`.

## In a bask workspace

`bask workspace --agent-user ai-claude` starts the station panes on your own login and the AI agent's pane on that Niagara user. bask asks for the agent user's password once, saves that login and uses it from then on; plain `bask workspace` is enough afterwards. As it starts it reports which user the agent is signed in as and whether the station lists that user in `agentUsers`. See [the CLI's workspace section](../cli/README.md#workspace).

## Settings

All are properties on **BASkStreamService**, grouped under `agent…` in the property sheet.

| Property | Default | Meaning |
| --- | --- | --- |
| `agentUsers` | blank | Niagara logins that are agents, comma separated. |
| `agentApprovalRequired` | true | Agent point writes become **proposals** a person approves. Every other kind of agent change is refused unless its `agentDirect…` setting below is on. Off: agents change things directly, within the limits below. |
| `agentDirectFiles` | blank | With approval required: station file paths an agent may still write and delete, comma separated, `*` matching anything. `^bask/*` covers the graphics bask keeps in the station. Blank = none. |
| `agentDirectDiscovery` | false | With approval required: agents may still start BACnet discovery, cancel a job, and add the devices and points discovery found. |
| `agentDirectModelEdits` | false | With approval required: agents may still apply any model plan: create, change, link, rename, move and delete components, and invoke actions. This is the broad one (see below). |
| `agentDirectTags` | false | With approval required: agents may still write tags and relations. |
| `agentDirectSchedules` | false | With approval required: agents may still change schedules. |
| `agentDirectAlarms` | false | With approval required: agents may still acknowledge and clear alarms. |
| `agentRequireReason` | true | Every agent change or proposal must include a `reason`. |
| `agentMaxChangesPerMinute` | 10 | Changes and proposals per agent user per minute. `0` = no limit. |
| `agentAllowEmergency` | false | Allow emergency (priority level 1) commands. Normal agent commands use level 8 or the fallback. |
| `agentBound1` … `agentBound4` | blank | Value ranges for agent writes: an ORD pattern and `min..max`, e.g. `slot:/Drivers/*/ZoneSP 68..76`. `*` matches anything; either end may be left out (`..80`). The first matching rule applies. |
| `agentProposalMinutes` | 15 | How long a proposal waits for a person before it expires. |
| `pendingProposals` | read-only | One line per waiting proposal: id, change, point, agent and reason. |

A point's own `min`/`max` facets always limit agent writes too.

## What an agent may do by itself

While `agentApprovalRequired` is on, every change an agent can ask for is one of these kinds, and each kind has its own switch:

| Kind of work | Operations | Allowed directly when |
| --- | --- | --- |
| Commanding a point | `write` | never: it becomes a proposal |
| Station files, such as graphics | `write_file`, `delete_file` | the path is under one listed in `agentDirectFiles` |
| Discovery | `discover`, `cancel_job`, applying a plan that `add_discovered` built | `agentDirectDiscovery` |
| Building and changing the station (programming) | `apply_model_changes` for any plan | `agentDirectModelEdits` |
| Tags and relations | `write_tags`, `write_relations` | `agentDirectTags` |
| Schedules | `write_schedule` | `agentDirectSchedules` |
| Alarms | `ack_alarm(s)`, `clear_alarm(s)` | `agentDirectAlarms` |
| Deciding a proposal | `approve_proposal`, `reject_proposal` | never: a person decides |

- A refused change comes back as `approval_required`, with a message that names the setting that would allow it, and it is recorded as `refused`.
- Direct changes still need a reason, count against `agentMaxChangesPerMinute`, and are limited by the agent's Niagara role. Each leaves a `completed` record.
- `agentDirectModelEdits` reaches whatever the Niagara role allows in the station tree, which includes the things the narrower switches cover (a plan can add a tag slot or edit a schedule's properties). Leave it off and use the narrower ones unless the agent is meant to build.
- **Commanding a point always goes through `write`.** An agent's model plan may not invoke `set`, `override`, `auto` (or the emergency and boolean forms) on a writable point, nor set its `in1`…`in16` inputs or `fallback`; that is refused with `agent_use_write`, whether approval is on or off. Linking logic into a point's input is programming and is allowed with model edits.
- `capabilities.agents.direct` reports what agents may do directly right now: `pointWrites`, `files` (the path patterns), `discovery`, `modelEdits`, `tags`, `schedules`, `alarms`.

For an agent that draws graphics and brings equipment in through bask, a typical setting is `agentDirectFiles = ^bask/*` and `agentDirectDiscovery = true`, with `agentMaxChangesPerMinute` raised for discovery (each job and each batch of up to 100 additions is one change).

## Approving proposals

A person (any user not listed in `agentUsers`, in a session that hasn't declared itself an agent) can decide a proposal in three places:

- **Workbench:** read `pendingProposals` on the service, then right-click the service → **Actions → Approve Proposal** (or **Reject Proposal**) and enter the id, e.g. `P7`.
- **bask:** `bask proposals`, `bask approve P7`, `bask reject P7`, or the dashboard's **6 Proposals** view.
- **The API:** `approve_proposal` / `reject_proposal`.

Approving runs the write **with the approver's Niagara permissions**, so the approver needs invoke permission on the point, and Niagara's audit history shows the approver making the change. Proposals live in memory: they expire after `agentProposalMinutes` and do not survive a station restart.

## What gets recorded

Every agent action adds an audit record with operation **`Agent`** to the station's audit history (Workbench: the station's Audit History, filtered by operation). Its fields:

- **user:** the Niagara user who acted (the approver, for approvals)
- **target / slot:** the point (or ORD) and the action, e.g. `override`
- **value:** `outcome=…; agentUser=…; agent=…; model=…; for=…; change=…; reason=…`

Outcomes are `proposed P7`, `approved P7 by ben`, `rejected P7 by ben`, `expired P7`, `written`, `completed` (other direct changes) and `refused` (with a `code`). Because the record sits next to Niagara's own record of the change (same user, target and time), retention, export to a Supervisor and history queries all work as for any audit history. `read_agent_log` returns these records as structured fields.

## Protocol

```json
{ "op": "declare_actor", "id": "1", "name": "Claude Code", "model": "claude-opus-5-5", "onBehalfOf": "ben" }
```

Reply `actor_declared` with `agents`: the rules that now apply (`isAgent`, `approvalRequired`, `reasonRequired`, `maxChangesPerMinute`, `allowEmergency`, `bounds`, `proposalMinutes`, `pendingProposals`). `capabilities.agents` carries the same block. Send `kind: "person"` for a person; a listed agent user stays an agent either way. The name, model and `onBehalfOf` are claims recorded alongside the Niagara user; the login stays the identity.

An agent's `write` takes a request-level `reason`. Each point is checked (permissions, action, emergency, facets and bound rules), then:

```json
{ "point": "slot:/Drivers/.../ZoneSP", "ok": true, "outcome": "proposed",
  "proposal": { "id": "P7", "status": "pending", "description": "override 72 for 30 min", "reason": "Room 204 is too cold", "expiresAt": 1790000900000 } }
```

With approval off the entry is a normal write result with `outcome: "written"`. Refused points have `ok: false` and a `code`.

| Operation | Use |
| --- | --- |
| `declare_actor` | Say who is behind the session. |
| `list_proposals` | Proposals this session may see (`status` filter): an agent sees its own, a person those on points they can read. |
| `approve_proposal` | `{ "proposal": "P7" }` runs the write as the approver. People only. |
| `reject_proposal` | `{ "proposal": "P7", "note": "…" }`. People only. |
| `read_agent_log` | `Agent` records, newest first (`since`, `limit`). Needs read permission on the audit history. |

`proposal_cov` notices tell each session about proposals it may see as they are created and decided, so an agent learns the outcome without polling.

Errors: `reason_required`, `approval_required`, `agent_rate_limited`, `agent_priority_blocked`, `agent_value_out_of_bounds`, `agent_cannot_approve`, `proposal_not_found`, `proposal_closed`.

## Not covered yet

- Only point writes can be proposed. While approval is on, agents can still preview model plans and dry-run schedule edits and alarm actions, but applying them needs a person.
- Agent details are what the client declares. Use a dedicated Niagara user per agent when the identity must be certain.
