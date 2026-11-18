# Graphics (API 1.12)

Operations for building and checking a station's Px graphics: read a Px as data, check it, write it, see which of many components its bindings resolve on, attach it as a view, check nav files, and take an inventory of the station's graphics with a punch list.

Everything runs as the session's Niagara user, and `allowedPathPatterns` applies to every component these operations reach. `capabilities.px` says what is available.

## How references are checked

A Px refers to other things in five ways, and every reply that lists references uses these `kind`s:

| kind | What it is | Example |
| --- | --- | --- |
| `binding` | A binding's `ord` (ValueBinding, BoundLabelBinding, ActionBinding and so on) | `<ValueBinding ord="slot:points/ZoneTemp"/>` |
| `ordProperty` | An ORD kept in a widget property: an `Ord` value, or a `String` property named like `valueOrd` or `point1Ord` (web widgets) | `<Ord name="valueOrd" value="station:\|slot:/AHU1/SAT"/>` |
| `link` | A widget's `hyperlink` | `hyperlink="file:^px/Floor2.px"` |
| `file` | Any other property naming a file or module resource, such as an image or logo | `image="module://icons/x16/home.png"` |
| `include` | A PxInclude's `ord` | `<PxInclude ord="file:^px/header.px"/>` |
| `view` | A web widget's JavaScript view, `view:Module:Name` | `js="view:QAGcharts:LineChartWidget"` |

`binding` and `ordProperty` are the data a widget shows; the others are files and pages.

An ORD is **relative** when it starts with a slot path without a leading slash (`slot:points/ZoneTemp`): it resolves from the component the view is attached to, so it can only be checked against a component. Every other ORD is absolute.

Only ORDs whose queries are all local to the station are resolved: `station:`, `local:`, `slot:`, `h:`, `service:`, `file:^...` and `module://`. A trailing `view:` query is ignored. BQL, history, remote (`ip:`, `fox:`) and other ORDs are reported as `not_checked`; they are never run. A resolved component outside `allowedPathPatterns`, or one the user may not read, is `forbidden`.

Each checked reference ends in one `status`: `ok`, `missing`, `forbidden`, `invalid` (not an ORD), `relative` (needs a component), or `not_checked`.

## `read_px`

```json
{ "op": "read_px", "id": "r1", "path": "^px/VAV.px", "tree": true }
```

Reply `px_result` with `px`:

- `path`, `version`, `media`, `imports` (module names in order), `elements` (count), `types` (`typeSpec` → count; an element that resolved to no type is counted under its own name).
- `references`: `{kind, ord, widget, property?, element, line}`. `widget` is a path of element names, `Type[name]` for named elements and `Type#n` for the nth unnamed one of its type, e.g. `/ScrollPane#1/CanvasPane[content]/Label#3`.
- `problems`: `{severity, code, message, line?}` (see the codes under `validate_px`), with `errors` and `warnings` counts and `truncated` when the file had more than 50,000 elements or 5,000 references.
- `tree` (with `tree: true`): the whole file as `{element, typeSpec?, attributes, line, children, text?}`, starting from the `px` element. It is a lossless copy of the XML, so a client can change ORDs or properties and hand it straight to `write_px`.

## `validate_px`

Send `path` (a Px on the station), `text` (Px XML) or `tree` (as `read_px` returns it). Reply `px_validation` with `validation`: the same fields as `read_px` without `tree`, plus `valid` (no errors).

Errors (`valid` is false):

- `xml_invalid` (not well-formed), `not_px` (root is not `<px>`), `content_missing`, `content_root` (`<content>` must hold exactly one widget), `misplaced_element`.
- `unknown_type`: an element is not a type in any imported module. This is how a widget from a module the station does not have shows up.
- `module_missing`: an imported module, or the module of a web widget's `view:`, is not installed on this station.
- `include_missing`: a PxInclude points at a file that is not there.
- `px_too_deep`: elements nested more than 64 deep.

Warnings: `px_version_missing`, `unknown_media`, `no_imports`, `px_too_large`, and `reference_missing` / `reference_forbidden` / `reference_invalid` for absolute bindings, links and files that do not resolve.

Relative bindings are not checked here, since they depend on the component; use `check_px_bindings`.

## `write_px`

```json
{ "op": "write_px", "id": "w1", "path": "^px/VAV.px", "text": "<?xml ...", "overwrite": true, "reason": "Template v2" }
```

Validates first, exactly as `validate_px` does, and refuses a Px with errors (`px_invalid`, with the first few in the message); warnings do not block it. Then it writes the file as `write_file` would (`overwrite`, `createDirs`, `dryRun`, `reason`), backing up a file it replaces (see below). Send the Px as `text` or `tree`. Reply `px_written` with `file` (as `write_file`'s reply, with `backup` when a copy was kept) and `validation`.

For agents, `write_px` is a file change: `agentDirectFiles` decides where they may write while approval is required.

### Backups

`write_file` and `write_px` copy a file they replace to `^bask/backups/<yyyyMMdd-HHmmss-SSS>/<path>` before writing, and name the copy in `backup`. This is on by default for `.px`, `.nav` and image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.bmp`) and off for others; `backup: true` or `false` decides for one request. When the copy cannot be made, the file is not replaced. baskStream does not delete old backups; remove them with `delete_file` when they are no longer wanted. `graphics_inventory` skips the backups folder.

### Records

Graphics and their files change many times while a project is built, so by default baskStream does not record that work. The service's `auditFilesAndViews` property (default off) decides:

| | `auditFilesAndViews` off (default) | `auditFilesAndViews` on |
| --- | --- | --- |
| Writing or deleting any station file (`write_px`, `write_file`, `delete_file`) | not recorded | `file_write` / `file_delete` in the audit history and the station log |
| Adding, repointing or removing a Px view (`attach_px_view`) | not recorded | Niagara's record of the slot change, in the user's name as for Workbench, and a `px_view_…` line in the station log |
| Anything an AI agent session does | its `Agent` record (see [AI_AGENTS.md](AI_AGENTS.md)) | the same |

Niagara records a component change when the change carries the user; with the setting off, `attach_px_view` checks the user's admin write on the component first and then makes the change without the user attached, so Niagara leaves no record. `capabilities.px.audited` and `capabilities.workbench.files.audited` report the setting.

## `check_px_bindings`

The point-mapping check: one Px against many components.

```json
{ "op": "check_px_bindings", "id": "c1", "path": "^px/VAV.px",
  "match": { "under": "slot:/Drivers/BacnetNetwork", "name": "VAV*" }, "suggest": true }
```

Which components (one of these, or several together):

- `targets`: slot ORDs, at most 500.
- `match`: `{under, name, type, depth}`. Every component under `under` (default the whole station) whose name or display name matches `name` (`*` wildcard, any case) and whose type is `type` or a subtype, down to `depth` levels (default 12). At most 500.
- `views: true`: every component that has a view of this Px (under `match.under` if given).

`relativeTo`: the slot ORD of the component a Px was drawn for, when its bindings are absolute (`station:|slot:/.../VAV_01/points/ZoneTemp`). ORDs under that component are then checked as relative to each target (`slot:points/ZoneTemp`), which turns a page drawn for one unit into a template check. The reply's `note` says so when a Px has only absolute bindings and no `relativeTo`.

Reply `px_bindings_result` with `check`:

- `summary`: `targets`, `bindings`, `relativeBindings`, `absoluteBindings`, `brokenAbsolute`, `okTargets`, `deviatingTargets`.
- `bindings`: one per distinct data ORD, in file order: `{index, ord, checked?, kind, relative, widgets (first 5), widgetCount}`. Relative ones add `resolvedOn`, `missingOn`, `forbiddenOn` and `types` (`typeSpec` → targets). Absolute ones add `status`, `reason?` and `typeSpec?`, checked once.
- `targets`: `{ord, name, resolved, missing, mismatched, ok, cells?}`. `missing` lists `{binding, ord, status, reason?, suggestions?}`. `mismatched` lists bindings that resolved to a different type than on most targets: `{binding, ord, typeSpec, expected}`. `cells` (with `cells: true`) is the status of every binding on that target, in `bindings` order, which makes the full matrix.
- `deviating`: the ORDs of targets that are not `ok`.
- `targetErrors`: targets that could not be used (`invalid_point`, `forbidden_point`), `truncated` when a limit or the time limit (`timeoutMillis`, default 30 s) was reached, and `pxErrors`.

### Suggestions

With `suggest: true`, each missing binding gets up to three `suggestions`: components under that target that could be the one wanted, best first.

```json
{ "ord": "slot:/Drivers/Net/VAV_07/points/Zone_Temp", "relative": "slot:points/Zone_Temp",
  "name": "Zone Temp", "typeSpec": "control:NumericPoint", "units": "°F", "score": 0.84,
  "why": ["name 0.79", "same type", "units °F"] }
```

The score weighs the name (60%), the type (25%) and the place under the target (15%), compared with where the binding resolved on the other targets. Names are split into words and common BAS abbreviations are spelled out first (`SAT` is supply air temp, `ZN_T` is zone temp, `Space`, `Zone` and `Room` count as one word, `Discharge` as `Supply`), and names whose numbers differ score lower. A component another binding on the same target already uses scores lower and says so. `relative` is the ORD to put in the Px.

These are for a person or an agent to review. Nothing is changed.

## `attach_px_view`

```json
{ "op": "attach_px_view", "id": "a1", "path": "^px/VAV.px", "match": { "under": "slot:/Drivers/BacnetNetwork", "name": "VAV*" },
  "view": "Graphic", "default": true, "reason": "VAV template" }
```

Adds a Px view (a `baja:PxView` slot with `pxFile` set, and `media` taken from the Px) to each component, chosen as for `check_px_bindings`.

- `view`: the slot name, default the file's name without `.px`. A component that already has a view of that name pointing elsewhere has it repointed (`updated`); a slot of that name that is not a Px view is left alone (`conflict`, code `view_conflict`). Without `view`, a component that already has a view of this Px is `unchanged`.
- `default` (default true): make it the component's default view, which is the first Px view in its slot order.
- `remove: true`: remove the views of this Px instead (only the one named `view`, when given).
- `dryRun: true`: report what would happen.

Each component needs admin write, as Workbench requires for adding views. Changes are recorded only with `auditFilesAndViews` on (see [Records](#records)). Reply `px_views_result` with `views`: `{path, view, remove, default, dryRun?, summary, results, truncated}`; `summary` counts each `action` (`added`, `updated`, `unchanged`, `removed`, `conflict`, `failed`), and each result is `{ord, action, view?, views?, default?, defaultSet?, code?, message?}`.

For agents, attaching a view is a model edit: `agentDirectModelEdits` decides whether they may do it directly while approval is required.

## `check_nav`

Send `path` (a nav file, such as `^nav/Main.nav`) or `text` (to check before writing it with `write_file`). Reply `nav_result` with `nav`:

- `nodes`: every `<node>`, depth first: `{path, name, ord, icon?, depth, line, status, reason?}`. `path` joins the node names (`Home/Floor 2/VAV-201`); a node without an ORD is a `folder`.
- `dead`: nodes whose ORD does not resolve. `problems` and `valid` cover the file itself.
- `users` (with `path`): the users this session may see whose nav file this is.

## `graphics_inventory`

```json
{ "op": "graphics_inventory", "id": "g1", "checkBindings": true }
```

Reads every `.px` and `.nav` file in the station file space (up to 2,000 files and 500 Px files), and every Px view on a component under `under` (default the whole station, up to `maxComponents`, default 100,000). Reply `graphics_inventory_result` with `inventory`:

- `summary`: counts of `pxFiles`, `navFiles`, `images`, `views`, `componentsVisited`, `errors`, `warnings`, `orphanPx`, `missingViews`, `unusedFiles`, and `brokenBindings` with `checkBindings`.
- `punchList`: `{severity, kind, where, target?, message}`, errors first.

| kind | severity | Meaning |
| --- | --- | --- |
| `view_missing_file` | error | A view on a component points at a Px that is not there. |
| `dead_include` | error | A PxInclude points at a file that is not there. |
| `nav_dead` | error | A nav node's ORD does not resolve. |
| `px_invalid` / `nav_invalid` | error | A Px or nav file has errors (`validate_px`, `check_nav`). |
| `broken_binding` | error | With `checkBindings`: a binding does not resolve on the component its view is on, or an absolute binding does not resolve at all. |
| `dead_link` | warning | A hyperlink, file or ORD property points at something that is not there. |
| `missing_view` | warning | Most components of a type under one parent have a view of a Px, and this one does not. |
| `user_nav_missing` | warning | A user's nav file is not there. |
| `px_unreadable` / `nav_unreadable` | warning | A file could not be read. |
| `orphan_px` | info | A Px is not a view anywhere, not included and not linked from any Px or nav file. |
| `unused_files` | info | Images no Px or nav file shows; the paths are in `unusedFiles`. |

- `pxFiles`: `{path, size, modified, attachedTo [{ord, view, default}], includes, includedBy, linkedFrom, bindings, relativeBindings, errors, imports}`.
- `navFiles`: `{path, nodes, dead, users}`. `views`: `{ord, view, pxFile, default, file}`. `users`: `{user, navFile}` for the users this session may see.
- `truncated` when a limit or the time limit (`timeoutMillis`, default 30 s) was reached.

Images that a Px builds its ORD for at run time, and pages reached only through component hyperlinks or home ORDs, count as unused or orphaned here; treat those two kinds as a list to look at, not to delete.

## Seeing a page

These operations check a page as data. To see it as a person does, with live values, a client opens it in a web browser with its own session; the station serves it like any other page, and nothing here is needed for that.

- The TypeScript SDK's `snapshot()` does it in headless Chrome, Chromium or Edge and returns PNG pictures with the page's title, HTTP status, failed requests and console errors ([sdk/README.md](../sdk/README.md#seeing-a-page)).
- The baskStream MCP extension (1.2.0 and later) gives AI agents the same as `px_snapshot`.
- A useful loop for an agent: `write_px`, then a snapshot, look, fix.
- It is the browser's rendering, through the user's web profile; Workbench can draw a page differently. Only what fits in the window is pictured.
