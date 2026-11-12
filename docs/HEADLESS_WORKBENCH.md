# Headless Workbench (API 1.10)

What an engineering client needs beyond points, tags and model plans: queries, the station's files, jobs and driver discovery. Together with [model editing](MODEL_EDITING_API.md) (create, wire, set any property, invoke any action), a client can take a station from empty to working without Workbench.

Everything runs as the session's Niagara user. Roles, categories and `allowedPathPatterns` still decide what that user can see and change. Changes need `writesEnabled`; anything that edits the model needs `modelEditsEnabled`. [Agent rules](AI_AGENTS.md) apply to the change operations here as they do elsewhere.

`capabilities.workbench` says what is available on this station for this session.

## Queries: `query`

One read-only query, as BQL or NEQL.

```json
{ "op": "query", "id": "1", "ord": "slot:/Drivers", "bql": "select slotPath, out.value, status from control:ControlPoint where status.fault" }
```

```json
{ "op": "query", "id": "2", "neql": "hs:ahu and hs:equip" }
```

| Field | Meaning |
| --- | --- |
| `bql` or `neql` | The query text, without the `bql:` / `neql:` prefix. Exactly one. Up to 4000 characters, no `\|`. |
| `ord` | Where the query starts. A slot ORD; default `slot:/`. |
| `limit` | Rows to return. Default 500, maximum 5000. |
| `timeoutMillis` | Default 10000, maximum 60000. |

Reply `query_result` with `result`:

- BQL: `columns` (`name`, `display`, `typeSpec`) and `rows`, each row a list of cells in column order. Strings, booleans and numbers come as themselves, times as epoch milliseconds, enums as their tag, and other values in Niagara's string encoding. A component in a cell comes as its slot ORD. Password-like columns are redacted.
- NEQL: `entities`, each `{ord, name, display, typeSpec}`.
- Both: `count`, `hidden` (rows the user may not see, dropped), `truncated`, and `stoppedBy` (`limit` or `timeout`) when truncated.

BQL is refused with `query_not_allowed` while `allowedPathPatterns` is narrowed, because a BQL column can walk from a row to components outside the policy. NEQL, `search` and `browse` work under any policy. A query Niagara rejects returns `bad_query` with its message.

## Station files: `list_files`, `read_file`, `write_file`, `delete_file`

The station file space, `^`: Px pages, nav files, images, HTML and so on. Paths look like `^px/Home.px` (a leading `file:` is accepted). Nothing else is reachable: not the protected station home (`^^`, which holds `config.bog` and the security folder), not the Niagara install, not absolute paths, and no `..`. Niagara's file permissions for the user apply on top.

| Operation | Fields | Reply |
| --- | --- | --- |
| `list_files` | `path` (default `^`) | `files_result`: `folder` with `entries` (`path`, `name`, `directory`, `size`, `modified`, `readonly`) |
| `read_file` | `path`; optional `encoding` (`text` or `base64`), `maxBytes` | `file_result`: `file` with `encoding` and `text` or `base64`. Without `encoding`, UTF-8 files come as text and anything else as base64. Up to 4 MiB. |
| `write_file` | `path`, and `text` or `base64`; optional `overwrite`, `createDirs` (default true), `dryRun` | `file_written`: `file` with `path`, `size`, `created` |
| `delete_file` | `path`; optional `recursive`, `dryRun` | `file_deleted`: `file` with `path` and the `deleted` paths |

- `write_file` refuses to replace an existing file (`file_exists`) unless `overwrite: true`.
- `delete_file` refuses a folder with contents unless `recursive: true`, and never deletes more than 500 entries in one request.
- A written file is limited by the service's `maxMessageBytes` (1 MiB by default), since it travels in one request.
- Writes and deletes are recorded in the station log and the audit history (`file_write`, `file_delete`).
- Errors: `forbidden_file`, `file_not_found`, `file_exists`, `file_too_large`, `file_failed`.

A Px page written this way is a file like any other; baskStream does not validate Px XML.

## Jobs: `list_jobs`, `read_job`, `cancel_job`

| Operation | Fields | Reply |
| --- | --- | --- |
| `list_jobs` | none | `jobs_result`: `jobs`, each `{job, name, display, typeSpec, state, complete, progress, startTime, endTime}` |
| `read_job` | `job` (its slot ORD); optional `offset`, `limit` | `job_result`: `job` with the summary, `log`, and `results` |
| `cancel_job` | `job` | `job_result`: the job's summary |

`state` is `running`, `canceling`, `canceled`, `success`, `failed` or `unknown`. `log` holds the last 200 log items (`kind`, `timestamp`, `message`, `details`).

`results` is what the job left on itself as slots: discovered devices or points, for example. Each is `{slot, typeSpec, values}`, with `values` in plain form. `resultCount` and `nextOffset` page through them (200 per page by default, up to 1000).

To start a job that is not discovery (a station save, a backup, a driver's own job), invoke its action in a model plan. The action's return value is the job's ORD; follow it with `read_job`.

## Discovery: `discover`, `add_discovered`

`discover` starts the driver's own discovery job. BACnet is built in.

```json
{ "op": "discover", "id": "3", "ord": "slot:/Drivers/BacnetNetwork" }
```

| `ord` is | Discovers | Optional fields |
| --- | --- | --- |
| a BACnet network | devices (Who-Is) | `lowLimit`, `highLimit`: device instance range |
| a BACnet device, or its `points` container | that device's objects | |

Reply `discovery_started` with `discovery`: `{job, kind, driver, target}`. Poll `read_job` until `complete`; its `results` are the discovered devices or points.

`add_discovered` turns chosen results into a model plan:

```json
{ "op": "add_discovered", "id": "4", "job": "slot:/Services/JobService/BacnetDiscoverPointsJob",
  "items": [ { "slot": "analogInput_3" }, { "slot": "analogValue_7", "name": "ZoneSetpoint", "writable": true } ] }
```

| Field | Meaning |
| --- | --- |
| `job` | The discovery job. |
| `items` | 1 to 100 results. Each has `slot` (from `read_job`), and optionally `name`, `parent`, `collision` (`fail` or `suffix`), `properties` (typed values that override the built ones), and for points `writable` and `typeSpec`. |
| `parent` | Where to add. For points it defaults to the job's device's points container; for devices it is required (the network or a device folder). |

The reply is a `model_result` plan preview, like `create_components`, plus `items` saying what each change was built from. Nothing is added until `apply_model_changes`.

- A device becomes a `bacnet:BacnetDevice` with the discovered address and device object id.
- A point becomes a control point with a BACnet proxy extension for the object's present value. Analog objects become numeric points, binary boolean and multi-state enum; outputs and values are writable points, inputs read-only ones. The point's facets (units, precision, range, state text) are read from the device, the way the Point Manager does it; `facetsLearned` says whether that worked.

Other drivers return `discovery_unsupported` from `discover`. Their discovery can still be driven by invoking the driver's discovery action in a model plan and reading the job; adding the results is then ordinary `create` changes.

## Users, roles and categories

Model plans leave the services that decide who can reach the station to Workbench (see [Protected objects](MODEL_EDITING_API.md#protected-objects)). `securityEditsEnabled` on the service (default off) opens three of them to model plans: the User, Role and Category services. Authentication, Fox, Web, platform, audit and program services stay closed, and so does the baskStream service itself.

- It needs `modelEditsEnabled` as well, and the user still needs Niagara admin write on the service being edited.
- It never applies to AI agent sessions or agent users.
- A password is set with `{"typeSpec": "baja:Password", "plain": "..."}` in place of `encoded`. Niagara hashes it. Passwords are redacted in previews, results and logs. `plain` works for any password property, such as a driver's credentials.

## Not covered

- **Platform work:** installing modules, commissioning, licenses and station copies go through the platform daemon, which a station module cannot reach.
- **Program objects:** `program:` components cannot be created or edited remotely.
- **Px validation and rendering.**
