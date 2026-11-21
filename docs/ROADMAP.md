# baskStream roadmap

Written 2026-11-20 against API 1.12, `bask` 0.8.0, SDK 0.1.0 and MCP server 1.2.0. Everything here is a proposal until it is built; nothing in this file describes shipped behaviour unless it says "today".

[ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) records the restructure that is already done (Phases 0 to 4) and stays the record of it. This file is what comes next.

## Aim

baskStream is the layer that tools, scripts and AI agents go through to see and change a Niagara station, with the station's own rules deciding what is allowed. The 67 operations cover the work. What is missing is in three places:

1. **Trust.** A change should be something a person can review, that lasts, and that can be put back.
2. **Meaning.** The station should be able to say what its equipment is, not only what its components are called.
3. **Reach.** It should be easy to install, sign in to, build on and prove.

## Principles

These hold for every item below.

- Niagara roles stay the hard boundary, and Niagara's audit history stays the record. baskStream adds to both and replaces neither.
- The wire protocol stays backward compatible. New behaviour is advertised in `capabilities` before a client relies on it.
- Every change has a preview. Nothing is applied that was not shown first.
- Anything inferred is marked as inferred, with the reason, and a person confirms it before it is written.
- New settings default to the safe side.
- The station module stays small. Work that can be done in the client (`bask`, the SDK) is done there, so a JACE carries as little as possible.
- No source, decompiled code or proprietary documentation from Tridium goes into this project or into AI prompts (see [LEGAL_AND_SAFETY.md](LEGAL_AND_SAFETY.md)).

## Order

| Stage | What | Why here |
| --- | --- | --- |
| A | [Foundations](#a-foundations): keys, the two size limits, releases, secure defaults | Everything later depends on staying signed in and on being installable |
| B | [The service view](#b-the-service-view) and the [agent rules once-over](#c-agent-rules-once-over) | The settings are already too many for the property sheet, and stage D adds more |
| D | [Change sets](#d-change-sets) | The core of the trust gap |
| E | [Station check](#e-station-check-and-station-as-text) (read-only), then export, diff and apply | The read-only check is the easiest way onto a cautious owner's station |
| F | [Meaning layer](#f-meaning-layer) | Makes E, G and every outside app more useful |
| G | [Empty station to commissioned](#g-empty-station-to-commissioned) | The showcase, once D to F hold |
| H | [Test bench for agents](#h-test-bench-for-agents) | Can start small beside any stage |
| N | [Niagara 5](#n-niagara-5) | A spike early, the port when 5 is generally available |

B and C are one piece of work: the once-over decides what the view shows.

---

## A. Foundations

### A1. Keys instead of web sessions

**Today.** A client signs in with Niagara's web login and keeps the session cookies. On the test station a session left idle was gone in 15 to 25 minutes. An agent cannot type a password, so `bask workspace` runs a keep-alive every four minutes and scripts read a password from the environment.

**Proposed.** A *client* is a child component of the service (`baskStream:Client`). Each one has:

| Slot | Meaning |
| --- | --- |
| `user` | The Niagara user it acts as. Roles and categories of that user still apply |
| `kind` | `person`, `app` or `agent` |
| `keyHash` | A hash of its key. The key is shown once, when it is made |
| `enabled`, `expires` | Turn it off, or let it lapse on a date |
| `pathPatterns` | Narrower than the service's `allowedPathPatterns`, never wider |
| `writes`, `modelEdits` | May only turn off what the service allows |
| `lastUsed`, `lastAddress` | Read-only, for the view |

- A key is sent in the `Authorization` header on the WebSocket upgrade. `requireAuthorizationHeader` then makes sense as a default for new installs.
- Making, revoking and rotating a key are actions on the client, done in Workbench or the service view. The API cannot make a key for itself.
- An agent's client replaces listing its login in `agentUsers`; `agentUsers` keeps working.
- This is "per-integration client profiles" from Phase 6 of the architecture plan.

**Looked into (2026-11-21, against the N4.15.3.28 install; nothing here is proven on a station yet).**

- Every request to the service passes Niagara's web login before the module sees it. The public web API has no way for a servlet to opt out, so a key the module checks for itself cannot replace the login.
- The module does not need the password once Niagara has authenticated someone: it already builds its permission context from the user Niagara hands it.
- Niagara has its own way to sign in without a password: the install ships a client-certificate authentication module (`clientCertAuth`, with `rt`, `ux` and `wb` parts). A user set to that scheme signs in with a certificate.

So the supported answer is a certificate, and it is Niagara's, not baskStream's. Give each agent or app its own Niagara user on the client-certificate scheme. The "key" is the certificate and its private key. It is revoked by disabling the user or the certificate, and a client can sign in again by itself whenever its session lapses, so the 15 to 25 minute expiry stops mattering.

What that changes in this section:

- `keyHash` and the make, rotate and revoke actions go away; Niagara's user and certificate tools do that work.
- A `baskStream:Client` is then only a per-user set of rules (C3): the user it applies to, its kind, and its narrower paths and rules.
- The SDK and `bask` need to present a client certificate at login (`bask login --cert`), and the MCP server needs to take one.

To prove before building: set a test user to the client-certificate scheme on the Demo station, and check that a program (not a browser) can complete the web login with a certificate and then open `/stream`. If that fails, the fallback is unchanged: a session the client renews itself, with the password kept in the operating system's keychain instead of the environment.

**Done when:** an agent runs for a day on a key with no password in its environment, a revoked key is refused within one revalidation interval, and a client with a narrower path sees nothing outside it.

### A2. The two size limits

**Second row fixed in the source on 2026-11-21.** The cause was Bun, which the released `bask` is built with: once anything has written to `process.stdout`, its `console.log` drops what does not fit the pipe buffer. Output now goes through `process.stdout.write` under Bun. A 1 MB result arrives whole through a pipe in tests under Node and Bun. The installed binary keeps the limit until it is rebuilt (`npm run compile` in `cli/`).

**First row fixed in the source on 2026-11-21 (API 1.13 build).** The cause was in the module's own MessagePack decoder, which refused any string or binary value over 64 KiB; the request then failed before its id was read, so no reply could be matched to it. Values are now limited only by `maxMessageBytes`. On the Demo station an 887 KB file uploaded and read back the same. A request over `maxMessageBytes` closes the connection, and the SDK now refuses one before sending it, with `message_too_large`. Chunked upload is not built: with the cap working, raising `maxMessageBytes` covers larger files.

| Limit | Seen | Done when |
| --- | --- | --- |
| A request over about 64 KB gets no reply, so a file over 48 KB will not upload, although `maxMessageBytes` is 1 MiB | API 1.12, `bask` 0.6.0 and 0.8.0 | A 900 KB file uploads and reads back the same, and a request over the cap gets an error instead of silence |
| `bask` output through a pipe stops at 65,536 bytes | `bask` 0.6.0 and 0.8.0 | A 1 MB `-o json` result arrives whole through a pipe |

For files larger than one message, add chunked upload (`begin`, `append`, `commit`) so images and large pages no longer need a file share. **Built in API 1.14** (`begin_upload`, `append_upload`, `commit_upload`, up to 16 MiB; the SDK's `putFile` and `bask put` use it). On the Demo station a 2.6 MB file went up in pieces and read back the same.

### A3. Releases

- Module: a versioned, signed jar on a GitHub release with `SHA256SUMS`, and `vendorVersion` bumped each time. Stop tracking the jar at the repository root.
- SDK: publish `@basidekick/baskstream` to npm.
- MCP server: publish the package and list it in the MCP registries; keep the `.mcpb` on the release.
- A Python client with the same surface as the SDK's read side plus writes, generated from the spec where possible. The current Python tools are read-only and out of date.
- A docs site built from `docs/`, with a five-minute start on `bask demo`.
- Remove `integrations/grafana/` and its mentions. **Done 2026-11-21.**

### A4. Secure defaults

- `writesEnabled` defaults to `false` on a newly added service. Existing services keep their value. **Done in API 1.14 through the palette**: the slot's default stays `true`, so a station that has the service is not changed, and the palette's entry sets it to `false`. A service made any other way (a model plan, a copied station) still starts with it on. Seen in Workbench's palette.
- A new service with no clients and no `agentUsers` shows a setup state in the view, not a running one. **Done in API 1.14**: the Status tab opens with "Start here" while changes are off and no agent user or profile is listed.

### A5. Evidence

Publish, and keep current, a table of what has been run where:

| Target | Measure |
| --- | --- |
| A JACE-8000 and a JACE-9000 | Heap and CPU at rest and with 5 clients on 500 subscriptions; a week's soak |
| A Supervisor of 100,000 points or more | Browse, search, query and inventory times; alarm stream under a burst |
| Versions | 4.10 (the stated floor) to 4.15 |
| Security | An outside review of the transport, the authorizer and the agent rules, with the findings and fixes published |

Also clear the "not yet checked on a station" notes still open in the development notes, one by one.

### A6. One install, many stations (a test, not a commitment)

Today the module treats only its own station as local. Find out whether a Supervisor install can usefully reach its JACEs through the Niagara Network, what the permissions look like, and what it costs. Write up the answer before deciding anything.

---

## B. The service view

### The problem

`BASkStreamService` has 42 slots of its own in one flat list, every one flagged for the summary: master switches, transport limits, security, agent rules, counters and a text line of pending proposals. The agent rules are the hardest part to read there:

- Six `agentDirect…` switches only mean something while `agentApprovalRequired` is on.
- Four `agentBound` slots each hold a small language (`slot:/Drivers/*/ZoneSP 68..76`).
- `agentUsers` and `agentDirectFiles` are comma-separated text.
- A proposal is approved by reading a text slot, then typing its id into an action.

Stages A and D add clients, per-kind rules and a change history, which will not fit a property sheet at all.

### What to build

**Built 2026-11-21 (API 1.13), narrower than first written.** The view is a settings view: the service's own properties, grouped and explained, set in the same slots as the property sheet. It talks to the station with BajaScript only and adds nothing to the `rt` part but two new settings. Clients, the change history and "Check a change" are left for the stages that add them. What follows is the original outline, with what was built marked.

An HTML5 view on the service, as the default view, in a new `baskStream-ux` module part. The property sheet stays available as it is.

- It opens in a browser and in Workbench, like any HTML5 view.
- The module becomes `runtimeProfiles="rt,ux"`. The `rt` part gains nothing but the view's registration; a JACE that never opens the view pays nothing.
- Registration follows the workspace's web UI rules: a JavaScript view is its own agent type that implements `BIJavaScript`, registered on `baskStream:BaskStreamService` with `@AgentOn` and `@NiagaraSingleton`, returning its module ORD from `getJsInfo`. Match how the nearest existing bajaux view in the JENEsys workspace declares itself before writing it.

### Tabs

Built: **Status**, **Access**, **AI agents** (with "Check a change" since API 1.14), **Approvals**, **Activity** (API 1.14: every agent change, with Put back), **Limits** and **Security** (the last two are "Advanced" below, split). A service with nothing set up says what to do first. Not built: Clients (stage A1).

| Tab | Shows | Does |
| --- | --- | --- |
| **Overview** | Running or not, API version, address of `/stream`, connections, subscriptions, request and error counts, and a line for anything that needs attention (writes on with no agent rules, a file pattern that is ignored, proposals waiting) | Nothing; it links to the tab that fixes each line |
| **Access** | The master switches as three plain questions: *May anything change the station? May it be built and rewired? May users and roles be edited?* Then `allowedPathPatterns` and `allowedOrigins` as lists | Edit, with a sentence under each saying what it turns on |
| **Clients** | Each client (stage A1): who it acts as, kind, last used, expiry | Add, make a key, rotate, revoke |
| **AI agents** | The rules grid (below), value limits as a table, and "Check a change" | Edit; test a rule before relying on it |
| **Approvals** | Waiting change sets: who, what, why, the difference, when it expires | Approve or reject, with a note |
| **Activity** | The `Agent` records, newest first, filtered by agent, outcome and time | Read; revert a change set (stage D) |
| **Advanced** | Transport limits, timings, header and origin hardening, audit settings | Edit; each has its default beside it |

### The AI agents tab

One row per kind of work, one choice per row. This replaces reading seven booleans together.

| Kind of work | Refuse | Ask a person | Allow |
| --- | :---: | :---: | :---: |
| Commanding points | ○ | ● | ○ |
| Station files (paths: `^bask/*`) | ○ | ○ | ● |
| Discovery | ● | ○ | ○ |
| Building and changing the station | ● | ○ | ○ |
| Tags and relations | ● | ○ | ○ |
| Schedules | ● | ○ | ○ |
| Alarms | ● | ○ | ○ |

- Until stage D, "Ask a person" is offered only for commanding points, because that is all a proposal can hold today. The other rows offer Refuse and Allow, and the view says why.
- Choosing Allow for "Building and changing the station" shows which other rows it then covers.
- Under the grid: reason required, changes per minute, emergency commands, how long an approval waits.
- **Value limits** is a table of pattern, minimum and maximum, with a count of the points each row matches now. A pattern that matches nothing is flagged.
- **Check a change**: pick an agent, a kind of work and a target, and the view says what the station would do and which rule decides. It uses the same code as the real check (see C8).

### How the view talks to the station

**Decided: option 2's shape, without new actions.** A settings view only needs the slots and the two existing actions (`approveProposal`, `rejectProposal`), so it uses BajaScript alone. Option 1 comes back into question when the Activity tab is built.

Found while testing: the view opens in Workbench, where it is the first entry under the service's Views. It does not open in a web browser at the service's own address, because Niagara sends a browser request for a web servlet component to the servlet's path (`/stream`). Reaching it from a browser would need the view registered on something other than the service.

The two options as first written:

| | Settings | Proposals, activity, the rule check |
| --- | --- | --- |
| **1. BajaScript plus `/stream`** (preferred) | BajaScript on the service's slots | The view opens `/stream` itself, same origin, with the user's session, and calls `list_proposals`, `approve_proposal`, `read_agent_log` and `capabilities` |
| **2. BajaScript only** | The same | New actions on the service that return structured values |

Option 1 reuses the operations and their permission checks and adds nothing to the `rt` part. It needs a MessagePack codec in the view's bundle. Option 2 needs no codec but duplicates each operation as an action.

### Done when

Checked on the Demo station on 2026-11-21 through the view's own script in a browser session: every tab loads, a save is read back on a fresh connection, a proposal is approved and another rejected from the Approvals tab, and a file path without `^` is refused. Still to do by a person: open it from Workbench's Views menu, and try the first item below with someone who has not seen the property sheet.

- A person who has never seen the property sheet can set up an agent that draws graphics and commands nothing, without reading the docs.
- A proposal can be approved from the view in two clicks.
- With only the service on a station and nothing configured, the view loads and says what to do first.
- Every setting changed in the view shows the same value in the property sheet, and the other way round.

---

## C. Agent rules once-over

What the read of `BaskStreamAgents`, the service's slots and [AI_AGENTS.md](AI_AGENTS.md) turned up, and what to do about each. The view (B) fixes how the rules read; these are changes to the rules themselves.

**Done in API 1.13 (2026-11-21):** C1, C3, C4, C5, C6, C7, C8, C12, C11's Approvals tab, C10's warning in the view, and the restart half of C9. **Done in API 1.14:** C2 (any kind can wait: `agentAskKinds`), the rest of C9 (a week), C11's alarm (`agentAlarmClass`), and "Check a change" in the view for C8.

- **C3, C6, C7 and C12 are agent profiles** (`baskStream:AgentProfile` under the service, see [AI_AGENTS.md](AI_AGENTS.md#profiles-different-rules-for-different-agents)). Each profile lists Niagara users and carries its own copy of every rule, its own rate and emergency setting, an optional end time, an on switch, and an optional narrower reach. A profile replaces the default rules for its users; it is not held to be narrower than them, because the master switches and Niagara roles are already the ceiling. They are found by Niagara user, not by key (see A1).
- **C8** is the `explain_change` operation. The view does not have a "Check a change" box yet.
- **C9:** waiting proposals are stored in a hidden slot and come back after a restart, if the station was saved after they were made. Proposals still expire (a day at most).

The first round, earlier the same day: C1, C4, C5 and C11's Approvals tab, and C10's warning in the view. C1 was done more simply than proposed: point commands got a three-way mode (`agentPointWrites`), and the six `agentDirect…` switches kept their names and now always decide their own kind, so each is refuse or allow. They become three-way when stage D makes other kinds proposable. C4 is one multi-line setting (`agentBounds`) with a table in the view, plus `agentUnlistedPoints`, in place of child components. Open: C2 (only point commands can wait for a person), the rest of C9 (proposals longer than a day), and C11's alarm.

| # | Before 1.13 | Problem | Proposed |
| --- | --- | --- | --- |
| C1 | `agentApprovalRequired` off makes every kind of work direct. The six `agentDirect…` switches are then ignored | One switch silently overrides six. The name says "approval", the effect is "no limits on kind" | One mode per kind of work: `refuse`, `ask` or `allow`. The old slots map onto it (approval off = every kind `allow`) and keep working |
| C2 | Only point writes can be proposed. Every other kind is all or nothing | "Ask a person" is the mode most owners would choose for schedules and model changes, and it does not exist | Stage D |
| C3 | One set of rules for every agent | An agent that draws graphics and one that tunes setpoints need different rules, and today share the wider of the two | Rules live on the agent's client (A1). The service's rules are the default a client starts from, and a client may only be narrower |
| C4 | Four `agentBound` slots; the first matching rule applies; a point no rule matches has no limit beyond its own facets | Four is arbitrary, the order is invisible, and "no rule" means "anything" | Bounds as child components, any number, shown in order. Add a setting for points no rule matches: `allow` (today), `ask`, or `refuse` |
| C5 | A file pattern in `agentDirectFiles` that does not start with `^` is ignored without a word | A typo leaves the agent refused, or the owner believing a path is covered | Reject it when it is set, and show it in the view's attention list |
| C6 | `agentMaxChangesPerMinute` is one number for every kind, and proposals count too | Discovery over a building needs it raised, which also raises it for point commands | A rate per kind, with the single number as the default |
| C7 | `agentDirectModelEdits` reaches what the narrower switches cover (a plan can add a tag or edit a schedule's properties) | Easy to turn on for one job and forget what else it opened | Allow a mode to carry an end time ("allow until Friday 17:00"), after which it falls back. The field notes already say "turn it on for the build and off afterwards" |
| C8 | The only way to learn what a rule does is to try the change | Refusals are recorded, so testing fills the log, and nothing explains which rule decided | A read-only `explain_change` operation: given an actor, an operation and a target, return the outcome and the rule that gave it. One function serves it and the real check |
| C9 | Proposals live in memory, wait 15 minutes by default, and are lost on a restart | An approval asked for at night is gone by morning | Stage D |
| C10 | A session that is not a listed agent user follows the agent rules only if it declares itself | By design, and correct, but an owner can believe an unlisted login is covered | The view's attention list says so when writes are on and no agent is listed or keyed. Keep recommending one Niagara user per agent |
| C11 | Approving is typing `P7` into an action | Error-prone, and invisible unless someone is looking at the service | The Approvals tab (B), and a notice a station can route: an alarm in a chosen alarm class when a change set is waiting |
| C12 | Emergency commands are one switch for every agent | Fine as a default | Keep it, and move it under the client with the rest (C3) |

**Not changing:** an agent can never approve its own change; a plan can never command a writable point (`agent_use_write`); `securityEditsEnabled` never applies to agents; a refused change names what would allow it.

**Compatibility, as built.** The `agentDirect…` slots keep their names. `agentApprovalRequired` and `agentBound1`…`4` stay on the service, hidden. A station saved with approval off is given the equivalent per-kind settings when the service starts, so its agents may do what they could before; a rule in an old bound slot moves to `agentBounds`. `capabilities.agents` gains `pointWrites` and `unlistedPoints`; `approvalRequired` now means only that point commands become proposals.

---

## D. Change sets

**Today.** A point write can become a proposal a person approves. A model plan has a preview, a hash and an apply, but only the person who made it can apply it, and nothing can be put back. File writes keep a backup under `^bask/backups`.

**Proposed.** One object for every kind of change: a *change set*.

| Part | Meaning |
| --- | --- |
| `id`, `kind` | `C12`; points, plan, schedule, files, tags or alarms |
| `who`, `agent`, `reason` | The Niagara user, what it declared, and why |
| `changes` | The normalized difference, as the plan preview already produces it |
| `before` | The values, slots or file copies the change replaces, taken at apply time |
| `state` | `waiting`, `approved`, `rejected`, `expired`, `applied`, `partial`, `reverted` |
| `check` | What to look at afterwards, and what was found |

**Built 2026-11-21 (API 1.14): D1, D2, D3, D5, the default and stated check of D4, and C11's alarm.** See [AI_AGENTS.md](AI_AGENTS.md#any-kind-of-change-can-wait-for-a-person). It was built on the proposal that already existed instead of as a second object, so ids stay `P7` and `list_proposals`, `approve_proposal` and `reject_proposal` keep working; `list_changes` and `revert_change` are new. Checked on the Demo station: a file, a schedule, tags, a model plan and a point command each waited, were approved by a person, listed, and put back; a waiting change was approved after a kill and start, and a change made before it was put back after it.

- **How the two problems below were settled.** A change that waits is answered as an error (`change_proposed`) carrying the proposal, so a client from before 1.14 cannot take it for done; the SDK, `bask` and the MCP server each turn it into "proposed". A plan is kept as the changes the agent sent and the differences its preview showed, and on approval it is previewed again as the approver and applied only if it would do the same.
- **Where they are kept (decision 5):** in a hidden slot on the service, with the station. A waiting change holds its request, 256 KB at most; a decided one holds only how to put it back, 64 KB at most.
- **Not built:** a wait time per kind (one setting, up to a week); a check that puts the change back by itself; undo for a deleted file, a removed relation, an alarm action, discovery, and a plan's delete and invoke steps (each is said to be irreversible before approval); a change made by a person is not listed; `bask apply` and `bask model write` still apply directly as the person running them. D6 is written: [AGENT_REQUIREMENTS.md](AGENT_REQUIREMENTS.md). baskStream meets it except where it depends on setup: line 1 holds only when each agent is given its own Niagara user, and line 20 only for a service added from the palette.

As first found (API 1.13), two things shaped it:

- **The reply.** A point command already answers with `outcome: "proposed"`. Every other operation answers in its own shape (`file_written`, `tags_result`…), so "this is waiting for a person" needs one answer every client understands, in the SDK, `bask` and the MCP server as well as the module. That is a protocol change, not a setting.
- **Running it later, as someone else.** An approved change has to run with the approver's permissions. File, tag, schedule and alarm requests are self-contained and can be kept and replayed. A model plan is not: it lives in the session that previewed it and expires, so approving one means keeping the plan itself.

A workable first step: a setting naming the kinds that wait instead of being refused (files, tags, schedules, alarms), with model plans and discovery left as refuse or allow until plans can be kept.

### D1. Any kind of work can wait for a person

- The `ask` mode (C1) on any row turns that kind of change into a waiting change set instead of a refusal.
- A waiting plan is the stored plan. Approving it applies exactly that plan, with the approver's Niagara permissions, as proposals do now.
- `list_proposals`, `approve_proposal` and `reject_proposal` keep working and return change sets of kind `points`. New names (`list_changes`, `decide_change`) cover every kind.

### D2. They last

- Waiting and decided change sets are kept on the station, so they survive a restart. Where they are kept (slots under the service, or a file under the protected station home) is to be settled against what an `rt` module may write.
- The wait is set per kind, up to days.
- The ledger is bounded, oldest decided first, and the bound is a setting.

### D3. They can be put back

- At apply time, record what each step replaces. From that, build the reverse plan: a create becomes a delete, an update restores the old values, a rename and a move go back, a link is removed or restored, a file comes back from its backup.
- `revert_change` previews the reverse plan against the station as it is now, and refuses a step whose target has changed since. A revert is itself a change set, with its own reason and record.
- What cannot be reversed is said up front: an invoked action, a delete of something that held state the module cannot read back, anything a driver did as a result. The preview marks those steps `irreversible` before the change is applied, so the approver sees it.

### D4. They are checked afterwards

- A point write names what it expects ("zone temperature rises within 20 minutes"), or takes a default (the value took, and the point is not in fault).
- The station checks once the time is up and records the result on the change set. A failed check raises the same notice as a waiting approval. It does not revert by itself unless the change set asked for that and the rule allows it.

### D5. Where a person sees them

The Approvals and Activity tabs (B), `bask` (`bask changes`, `bask approve`, `bask revert`), the dashboard's AI Activity view, and an alarm in a chosen class when something is waiting.

### D6. A requirement an owner can use

Write the rules up as one page, free of product names: each agent has its own identity; every change carries a reason; commands wait for a person or stay inside stated limits; every change is recorded and can be put back. An owner can put that in a controls standard, and baskStream is one thing that meets it.

**Done when:** an agent's schedule change waits overnight through a station restart, is approved in the morning from the view, is applied, and is reverted a day later in one step with both recorded in the audit history.

---

## E. Station check and station as text

**Built 2026-11-21 in `bask` (not yet in a released binary): all of E1 to E5 on the client side.** `bask check` (every check in the table below), `bask export`, `bask diff` (files, branches, and two saved stations in one run), `bask apply` (preview by default, `--yes` to apply, `--prune` to delete), templates (`bask apply --template … --each units.csv`), `bask fleet check` and `bask fleet diff --against`. See the [CLI README](../cli/README.md).

- Tested on the simulated buildings: planted faults found, two exports byte-identical, and an export applied to an empty folder gives no difference when exported again. The first three (`check`, `export`, `diff` as they were) were also run read-only on the Demo station: a 3,471-component branch exported to 1 MB twice with no difference. **`apply`, templates, the fleet commands and the four later checks have not been run on a real station.**
- The four later checks use read operations the module already has: the audit history for how long a point has been overridden, `describe_history` for histories that stopped (one request a point), a query and the alarm database for alarm classes nothing uses, and `read_schedule` for exceptions in the past. Their limits are in the README.
- `apply` makes its changes as model plans, with tags and relations after them through `write_tags` and `write_relations`. It does not apply them as change sets, because D is not built: there is no waiting for a person and no one-step undo. `program:` objects, protected services and platform settings are reported and never applied.
- Not done: the "done when" below on a second real station with a 5,000-component branch. A template is JSON only.

### E1. Station check (read-only)

`bask check` gives a punch list for the whole station, the way `bask px qa` does for graphics. It needs no write permission.

| Group | Examples |
| --- | --- |
| Points | In fault, down or stale; overridden for longer than a set time; no units; out of range of their own facets |
| Histories and alarms | Points of a kind that usually has a history or an alarm extension and this one does not; histories that stopped; alarm classes nothing uses |
| Names | Breaks from the pattern most siblings follow |
| Devices | Down, duplicate addresses, devices with no points |
| Schedules | Never referenced; no events; exceptions in the past |
| Graphics | The existing `px qa` list |
| Security posture | Only what the user may read: default-looking accounts are reported as "review", never tested |

- Rules are data: a rule file names a query, a test and a severity, so an integrator can carry their own standard. A starter set ships with `bask`.
- Output is a table, JSON, or a page a person can hand to an owner. Exit code 1 on errors, so it runs on a schedule.
- It is built in the client from `query`, `browse` and `describe_component`. Add an operation to the module only where a check is too slow that way.

### E2. Export

`bask export <ord>` writes a branch as text: components, types, properties that differ from their defaults, links, tags and relations. Stable order, no handles, no timestamps, secrets left out, so two exports of an unchanged station are identical.

### E3. Diff

`bask diff <a> <b>` compares two exports, two stations, or a station and an export. Output is the same normalized difference a plan preview uses.

### E4. Apply

`bask apply <file>` turns the difference between a file and the station into plans, previews them, and applies them as change sets (D). Limits are stated: `program:` objects, protected services and platform settings are reported as differences and never applied.

### E5. Templates and fleets

- A template is an export with named gaps (device name, address, point prefix). `bask apply --template ahu.yaml --each units.csv` stamps it out.
- `bask fleet check` and `bask fleet diff --against standard/` run E1 and E3 across saved stations and show where each one departs.

**Done when:** an export of a 5,000-component branch applied to an empty folder on a second station gives no difference on re-export, and a check of the demo buildings finds the faults planted in them.

---

## F. Meaning layer

**Built 2026-11-21 in `bask`: steps 1, 2 and 3, the Haystack and Brick exports in step 4, and step 5.** `bask model infer` proposes equipment, point roles and what serves what (from links, names and folder shape, each marked as inferred); `bask model write` writes the confirmed entries as Haystack tags and relations (preview by default, `--yes` to write, an unconfirmed entry never written); `bask model export --format haystack|brick`.

- The `resolve` operation is built in the module (API 1.14), with `bask resolve`, the SDK's `resolve()` and the MCP server's `resolve_point`. It scores points under a piece of equipment by tags and by name, and was checked on the Demo station on a test folder only. Not built: bindings by role in Px templates, and E1's history check by role. Tags are written directly as the person running `bask model write`, not as a change that waits. Brick is an export only; nothing is written in a Brick dictionary. The review is a file; there is no dashboard view of it.
- On the simulated buildings every device's kind is recovered with tags stripped. On the Demo station, which has almost no real equipment, it took a lone point for a piece of equipment and its proxy extension for the point. That is fixed and tested on a simulated copy of the case (a control point is never equipment; a proxy extension is never a point), but **the fix, the tag writing and what serves what have not been run on a real station**, and it needs a run on a real job's station before its confidence figures mean much.
- What serves what proposes nothing where two units fit equally: on Northgate (two air handlers, eight boxes, no link or name between them) it proposes only the plant.
- The name matcher is in two places, `cli/src/names.ts` and the module's `BaskStreamGraphicsResolver`, and they have to be kept alike.

**Today.** `browse` and `describe` return evidence (types, driver ancestry, extensions, tags, relations) and leave grouping into equipment to each app. The name matcher behind `check_px_bindings` already splits names into words and expands common BAS abbreviations.

**Proposed.**

1. **Infer.** `bask model infer [--under ord]` proposes equipment (which components are an air handler, a VAV box, a plant), each point's role (supply air temperature, cooling valve command), and what serves what. Each proposal has a confidence and a reason ("name 0.79, same type, units °F, 31 siblings agree"). It reads names, types, units, facets, folder shape, links and any tags already there.
2. **Review.** The result is a file a person edits and a dashboard view that lists the uncertain ones first. Nothing is written yet.
3. **Write.** Confirmed entries are written as standard tags and relations (Haystack, and Brick where the station has that dictionary) with `write_tags` and `write_relations`, as a change set.
4. **Use.**
   - `resolve`: a new read operation that takes an equipment and a role and returns the point, so a client asks for the supply air temperature of AHU-1 without an ORD.
   - Px templates and `bask graphic` files may bind by role.
   - E1's "points of a kind that usually has a history" uses roles instead of names.
   - `bask model export --format haystack|brick` writes the model for other tools.
5. **Mark what was inferred.** A tag written from an unconfirmed guess is never written. A confirmed one carries who confirmed it in the change set, not in the tag.

**Done when:** on a station of 30 or more untagged VAV boxes with mixed naming, a person reaches a fully tagged station in under an hour, and a query by tag returns the same points as a hand-made list.

---

## G. Empty station to commissioned

The Eastgate demo, on real hardware, with a list at the end that proves it.

| Step | Today | To add |
| --- | --- | --- |
| Bring devices and points in | BACnet discovery with learned facets | Discovery for the other drivers in common use, starting with whichever the next real job needs; a naming pass at add time |
| Histories and alarms | By hand, through model plans | Rules: "every zone temperature gets a 15-minute history and a high and low alarm in this class", applied by role (F) |
| Schedules | Read and write weekly entries | Create from a template; link points to them |
| Logic | Plans, and `bask logic guide` with common kitControl blocks | A library of standard sequences as templates (E5), each with a check that reads the sheet back |
| Graphics | Px validate, bindings, attach, inventory, snapshot; `bask graphic` in the terminal | The coordinate-free graphic format compiled to Px and to SVG, so one small file gives a terminal drawing, a web page and a native Px view. Snapshot comparison between runs |
| Tags | `write_tags` | F |
| Proof | `px qa` | E1 over the whole station, as the job's definition of done |

**Done when:** a real controller network of 40 or more devices goes from an empty station to one that passes `bask check`, with the hours and the count of human corrections written down.

---

## H. Test bench for agents

**Built 2026-11-21 in `bask`: `bask record` (with `--scramble`), `bask replay` to load a recorded site, and `bask eval --agent <command>` with the four tasks.** See the [CLI README](../cli/README.md). A scripted agent gets the same score twice. Not done: a run with a real model (so "run unattended" is shown with a script, not an agent), a run of `record` on a real station, use on `bask agent-brief` and the guides, and published results. A recording holds structure, values, alarms, schedules, tags and a day of numeric histories; it does not hold links, logic, files or the audit history.

- **Record.** `bask record` turns a real station (structure, a day of values, alarms, histories) into a demo site file, with names optionally scrambled, so work can be tried away from the building.
- **Tasks.** A set of jobs on the demo sites with a scored end state: bring Eastgate up, draw Harbor, find the planted fault at Northgate, copy AHU-1's reset to AHU-2. The score reads the simulated station, not the agent's account of it.
- **Run.** `bask eval --agent <command>` runs the set and reports time, commands used, refused changes and the score.
- Use it first on `bask agent-brief` and the guides: a change to a guide is kept if the score does not fall. Publish results per model once the set is stable.

**Done when:** the four tasks in the CLI's "Four things to show" run unattended and give the same score twice.

---

## N. Niagara 5

- **Known from the project's own notes:** Niagara 5 has one module per project with JPMS and no runtime-profile parts, and the web tier moves to Jakarta Servlet. Publicly reported: Java 25, which has no Security Manager, and required module signing.
- **What it means here:** the transport (`BaskStreamJettyTransport`, `BaskStreamJettyWebSocketConnection`) is the piece to replace, and it is already the only place Jetty and servlet types appear. `module-permissions.xml` and the notes about edits running under baskStream's own Java permissions need re-reading once there is no Security Manager. The `rt`/`ux` split in B becomes one module.
- **Spike (early):** build the module against the installed early-access SDK using the migration skill's dossier, and write down what breaks. No release.
- **Port (at general availability):** a second build from one source tree where possible, the same protocol, and the same contract tests.
- Niagara 4.15 is reported as supported through 2028, so 4 stays the main target until then.

---

## Left out on purpose

- Data exporters and adapters (Influx, MQTT, Node-RED, dashboards). Others do this, and it is not where baskStream is different. A plain JSON mode beside MessagePack is the one exception worth considering, because it lowers the bar for a developer with `curl`.
- Platform work (installing modules, licences, station copies) and `program:` objects. A station module cannot reach the first and should not carry the second.

## Decisions needed

0. A4: **done through the palette** (API 1.14). The slot's default could not change, because a station saves only the values that differ from a default and every station with writes on would have lost them. The palette's entry sets `writesEnabled` to `false` instead.
1. A1: **looked into.** The supported way is Niagara's own client-certificate sign-in, one Niagara user per agent or app. To prove on the Demo station before building.
2. B: **decided and built.** BajaScript only.
3. C1: **decided and built** in one release (API 1.13), with a carry-over for stations that had approval off.
4. C4: what should a point with no matching bound do by default on a new install? It is `allow`, which is what stations did before. `ask` would be the safer default, and could be set the same way as A4, in the palette.
5. D2: **decided and built.** In a hidden slot on the service, saved with the station.
6. A4: see 0.
7. G: which driver after BACnet.
