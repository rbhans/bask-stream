# Checkout: `bask test`

Point-to-point and functional checkout is the same four moves over and over: command an output, watch the feedback prove it, write down what happened, release the command. `bask test` does that from a plain document and gives back the checkout report.

The document is markdown. A technician can read it, write it and keep it with the job; no AI is needed to make one or to run one.

```bash
bask test ahu.md                         # rehearsal: looks, lists what it would command, commands nothing
bask test ahu.md --allow-writes --yes    # the run
```

## A checkout document

```markdown
# AHU-2 functional test
equipment: slot:/Drivers/BacnetNetwork/AHU_02/points

Unit in Auto at the starter before this is run.

## Supply fan starts on command
- set SupplyFanCmd on
- expect SupplyFanStatus is on within 30s

## Fan speed follows command
- for 25, 50, 75, 100:
  - set SupplyFanSpeed {value}
  - expect SupplyFanSpeedFbk within 3 of {value} within 60s

## Cooling valve closes fully
- note SupplyAirTemp
- set CoolingValve 0
- wait 2m
- expect SupplyAirTemp rises at least 2 within 5m
```

Each `##` heading is a step. The list lines under it are what to do, in order. Everything else is text, and is carried into the report as written.

Two complete examples are in [`cli/examples/checkout`](../cli/examples/checkout): `ahu.md` and `vav.md`.

## Writing one

### The top of the document

| Line | Meaning |
| --- | --- |
| `# Title` | The title of the test and of its report. Without one, the file's name is used. |
| `equipment: <ORD>` | Where the points are. Point names on the lines after it are looked for under this ORD. It can appear again, anywhere, to move on to another piece of equipment. |
| `station: <name>` | Optional, above the first step. The station this document is for. On any other station nothing is commanded. |

### Lines

| Line | What it does |
| --- | --- |
| `set <point> <value>` | Commands the point to the value, as an operator override. `set <point> <value> for 10m` asks the station to let go after ten minutes. |
| `release <point>` | Lets the point go (auto). Rarely needed: every step releases what it overrode when it ends. |
| `expect <point> <check>` | Reads the point once and checks it. |
| `expect <point> <check> within 30s` | Keeps reading until the check is true or the time runs out. |
| `wait 2m` | Waits. |
| `note <point>` | Writes down what the point reads now. It goes in the report's notes. |
| `for 25, 50, 75:` | Repeats the lines indented under it, once per value, putting the value wherever `{value}` is written. |

### Checks

| Check | True when the reading |
| --- | --- |
| `is on`, `is 55`, `is Occupied` | is that value. A number matches at the precision the point shows: `is 55` is true of a reading shown as 55.0. |
| `is not off` | is anything else. |
| `above 50` | is more than 50. |
| `below 50` | is less than 50. |
| `within 3 of 50` | is between 47 and 53. |
| `rises at least 2` | is 2 or more above where it started. |
| `falls at least 2` | is 2 or more below where it started. |

Where a rise or fall starts: the last `note` of that point in the same step, or, with no note, the reading when the check begins. Put the `note` before the command, as in the cooling valve step above; otherwise a `wait` in between hides part of the change.

`on`, `true` and `active` mean the same; so do `off`, `false` and `inactive`. They also match a number (off is 0) and a point's own words: `is Running` is true of a status that shows "Running".

### How lines may be written

The grammar is small, and forgiving about the rest:

- Capitals do not matter in `set`, `expect` and the other words. They do matter in point names.
- A list line may start with `-`, `*`, `+` or a number (`1.`), and may carry a tick box (`- [ ]`).
- `set SupplyFanSpeed to 50` and `set SupplyFanSpeed = 50` are the same as `set SupplyFanSpeed 50`.
- A unit after a number is allowed and ignored: `50 %`, `50%`, `600 cfm`, `2 °F`. bask compares numbers; it does not convert units. Only one word is taken as a unit.
- A length of time is a number and `ms`, `s`, `m` or `h`, with or without a space, or spelled out: `30s`, `2 m`, `90 sec`, `5 minutes`, `1.5h`.
- A value with a space in it goes in quotes: `set Mode "Morning warm-up"`.
- A point name may be a path under the equipment (`VAV_101/points/ZoneTemp`) or a full ORD (`slot:/Drivers/...`), which ignores the `equipment:` line.
- Code ticks and bold marks around a name, and a full stop at the end of a line, are ignored.

### What is an error

The whole document is read before anything else happens. A line that cannot be read stops everything, and every such line is listed with its line number:

```
ahu.md:9: Cannot read "open the damper". A step line starts with set, release, expect, wait, note or for.
ahu.md:14: "30" needs a unit of time: write 30s, 30m or 30h.
```

These are errors too, because each would otherwise be skipped without a word:

- a list line inside a step that is not one of the lines above. Write remarks as plain text, without the dash;
- a line that reads as a step line but has no dash in front;
- a step line above the first `##` heading;
- a step with nothing to do, and a `for` with nothing indented under it;
- `{value}` outside a `for`, and a `for` inside a `for`.

A list above the first step that is not made of step lines (what to bring, what to check first) is text.

## Rehearsal

Without `--allow-writes --yes`, `bask test` is a rehearsal. It commands nothing. It:

- reads every point the document names. A name that is not on the station, or that this login may not read, is an error with its line number;
- asks the station whether each point a `set` or `release` names is writable, and whether this login may override and release it;
- checks each value against the kind of point: a number for a numeric point, on or off for a boolean one;
- checks that a point compared with `above`, `below`, `within` or a rise or fall reads as a number;
- lists exactly what a run would command, in order, with what each point reads now and how long each override would be held;
- warns about what is worth knowing first: a point that is already overridden (the test would replace that override, and release the point afterwards), a point whose override cannot time out, a login whose commands wait for approval.

With an error in the list, a run does not start. Warnings do not stop one.

## A run

With `--allow-writes --yes`, bask first does everything the rehearsal does, and commands nothing if that finds an error. Then, for each step in turn:

1. **Each `set` is an operator override with a time limit.** The limit is 15 minutes, or longer when the step's own waits add up to more (those waits plus two minutes), or what `for` says on the line. It is there for one reason: if bask stops for any cause before the step ends (the laptop sleeps, the network drops), the station lets go of the point by itself.
2. **Each `expect … within` watches the point** until the check is true or the time runs out. bask subscribes to the points for the length of the run, so the station keeps polling them, and also reads the point every second. It records how long the check took and the readings it saw.
3. **A reading that proves nothing never passes a check.** A point that is down, stale, in fault, null or disabled shows an old value or none; the report says so beside the reading: `72.4 °F (down)`.
4. **When the step ends, every point it overrode is released**, last one first. This happens whether the step passed, failed, hit an error or was stopped with Ctrl-C.

How a step ends:

| Result | When | What happens next |
| --- | --- | --- |
| Pass | Every line went through and every check was true. | The next step runs. |
| Fail | A check was not true (in time). The step stops there; its remaining lines are not run. The report says what was expected and what was read. | The next step runs. |
| Error | The station refused a command, or did not answer one. The step stops there. | The run stops. With `--keep-going` the next step runs. |
| Stopped | Ctrl-C, or the station kept a command for a person to approve. | The run stops. |

A release that does not go through is the one thing that must not be missed. It is reported at the very end, on its own, with the point's full ORD, why the release failed, and the time at which the station will let go by itself. A release that fails because the connection dropped is sent again, three more times over ten seconds, before it is reported.

Every command carries a reason, which the station keeps in its audit history: the document's title and the step's name, or what `--reason` gives.

The exit code is 0 when every step passed and nothing is left overridden, 2 when the station kept a command for a person to approve, and 1 otherwise.

### AI agents

The station's rules for AI agents apply to a checkout as to any other command (see [AI_AGENTS.md](AI_AGENTS.md)).

- **Where an agent's point commands wait for approval**, the first `set` comes back as a proposal. The run stops there and says so. Nothing was commanded, so there is nothing to release. Approving that proposal later makes that one command by itself, not the rest of the test: reject it unless that is wanted. The rehearsal warns about this beforehand.
- **Where an agent's point commands are refused**, the rehearsal reports it as an error and a run does not start.
- **Where they are allowed**, the station's limit on changes per minute still holds. bask waits for its turn between commands instead of being refused part way; a release waits too, and is never skipped.
- A command outside an agent's value limits is refused by the station. That is an error for the step, like any refusal.

## The report

The report is plain markdown, written to be handed to a customer:

- the title, the station, who ran it, when, how long it took, and the result in one line;
- the text from the top of the document;
- a table with a row per step: pass or fail, what was commanded, what was seen, how long it took, and a small trend of the readings while it waited;
- each step line by line, with the document's own text for that step, what each command read back, and each check's result and trend;
- the notes: every value written down with `note`;
- **Left overridden**: either that nothing is, or each point that still is, by ORD.

## Try it on a simulated building

The simulated Riverside building has an air handler made for this. `AHU_OR`'s fan status follows its speed command a moment later, and its supply air follows its setpoint. `AHU_Patient`'s fan status reads On whatever the fan is told: the kind of fault a checkout is there to find.

```bash
bask demo --site riverside --serve                                              # the building, in one terminal
bask -p demo-riverside test cli/examples/checkout/ahu.md                        # rehearsal
bask -p demo-riverside test cli/examples/checkout/ahu.md --allow-writes --yes   # every step passes
```

To see a step fail, point the document at the other unit: change `AHU_OR` to `AHU_Patient` on its `equipment:` line (and `62` to `56` in the last step, that unit's normal supply air). The first step then fails after its 30 seconds, with "expected to be off, read On".

`vav.md` is written for a VAV box, and its names match `VAV_101` on the simulated Northgate building, so it rehearses there. That building has no airflow that answers a damper, so a run there fails its airflow checks.

## For programs

`cli/src/checkout.ts` is the whole of it, and a screen or another tool can use it directly:

| Function | Use |
| --- | --- |
| `parseCheckout(text, from)` | The document as data. Throws `CheckoutParseError`, whose `problems` are `{ line, message }`. |
| `rehearseCheckout(client, checkout)` | A `Rehearsal`: `commands` (what a run would send, in order), `problems`, and `ok`. |
| `runCheckout(client, checkout, options)` | A `CheckoutResult`. Options: `reason`, `keepGoing`, `signal` (abort it to stop: the step in hand still releases), `onEvent`, `pollMs`. |
| `checkoutReport(result)` | The markdown report. |
| `checkoutText(resultOrRehearsal)` | What the terminal prints. |
| `checkoutExitCode(resultOrRehearsal)` | 0, 1 or 2, as above. |

`onEvent` is called with plain data as the run goes: `step-started`, `line-started`, `reading` (each reading of a check that is waiting, with the readings so far as numbers for a trend), `line-finished` and `step-finished`. `step` and `line` in an event are positions in the document's steps and in a step's lines.

## What it does not do

- It does not put back an override that was on a point before the test. It replaces it, and releases the point when the step ends. The rehearsal names such points first.
- It commands at the operator override level only. A point held by an emergency override, or by a higher priority, takes the command without changing; the report says which level is in control.
- It does not convert units, and it does not know what a good value is. The document says what to expect.
- A failed check does not stop the steps after it. Order the steps so that each can stand alone, or put what belongs together in one step.
- It does not change the fallback value of a point (`set` in the protocol's sense), schedules, or anything but the points named.
