// What an agent (or a person) reads before building logic through bask: how a plan file is
// written, the common kitControl blocks with their real slot names, and how to check the result.

/** kitControl's everyday blocks: type, the status inputs, and plain settings. Slot names are from the 4.15 kitControl-rt.jar. */
const BLOCKS: [string, string, string][] = [
  ["kitControl:Add, Multiply, Average, Minimum, Maximum", "inA, inB, inC, inD", ""],
  ["kitControl:Subtract, Divide", "inA, inB", ""],
  ["kitControl:GreaterThan, GreaterThanEqual, LessThan, LessThanEqual, Equal, NotEqual", "inA, inB", ""],
  ["kitControl:And, Or", "inA, inB, inC, inD", ""],
  ["kitControl:Not", "in", ""],
  ["kitControl:NumericSwitch", "inSwitch, inTrue, inFalse", ""],
  ["kitControl:Reset", "inA, inputLowLimit, inputHighLimit, outputLowLimit, outputHighLimit", ""],
  ["kitControl:LoopPoint", "controlledVariable, setpoint, loopEnable", "loopAction, proportionalConstant, integralConstant, derivativeConstant, bias, maximumOutput, minimumOutput"],
  ["kitControl:Tstat", "cv, sp, diff", "action"],
  ["kitControl:NumericConst, BooleanConst", "", "out (set out/value)"]
];

export function logicGuide(): string {
  return `# Building logic through bask

Logic is components joined by links: a block's \`out\` linked to another block's input, and in the
end to a writable point's \`in10\`. You build it with a plan file, check it as a wire sheet in text,
and the person watches it in their Logic view.

## Steps
1. See what is there: \`bask logic print <folder ord>\` draws a folder's blocks and links with live values, then lists every link and each block's settings. \`bask browse\` and \`bask search\` find the points to wire to.
2. Write the changes to a JSON file (below).
3. \`bask plan logic.json\` checks the file against the station and lists what it would do. Nothing changes yet.
4. \`bask plan logic.json --apply --allow-writes -y --reason "<why>"\` makes the changes, and opens the result in the person's Logic view.
5. \`bask logic print <folder ord>\` again: every slot shows what it reads now. A \`null\` on an input means nothing is feeding it.

To build "the same as" something that exists, print that folder first: the drawing gives the blocks and the wiring, and the settings list under it gives the numbers. Change the names and the points, keep the rest.

## The file
This one makes a zone's setpoint follow a schedule: 72 while occupied, 78 otherwise.
\`\`\`json
{ "changes": [
  { "action": "create", "parent": "slot:/Logic", "name": "VAV_101", "typeSpec": "baja:Folder", "ref": "folder" },
  { "action": "create", "parent": "@folder", "name": "Occupied", "typeSpec": "kitControl:NumericConst", "ref": "occupied",
    "properties": { "out/value": { "typeSpec": "baja:Double", "encoded": "72" } } },
  { "action": "create", "parent": "@folder", "name": "Setback", "typeSpec": "kitControl:NumericConst", "ref": "setback",
    "properties": { "out/value": { "typeSpec": "baja:Double", "encoded": "78" } } },
  { "action": "create", "parent": "@folder", "name": "Setpoint", "typeSpec": "kitControl:NumericSwitch", "ref": "switch" },
  { "action": "create_link", "source": "slot:/Schedules/OfficeHours", "sourceSlot": "out", "target": "@switch", "targetSlot": "inSwitch" },
  { "action": "create_link", "source": "@occupied", "sourceSlot": "out", "target": "@switch", "targetSlot": "inTrue" },
  { "action": "create_link", "source": "@setback", "sourceSlot": "out", "target": "@switch", "targetSlot": "inFalse" },
  { "action": "create_link", "source": "@switch", "sourceSlot": "out", "target": "slot:/Drivers/BacnetNetwork/VAV_101/points/ZoneSetpoint", "targetSlot": "in10" }
] }
\`\`\`
- **create** makes a component: \`parent\`, \`name\`, \`typeSpec\`, and optionally \`properties\`. Give it a \`ref\`, and later changes in the same file name it as \`"@ref"\`: that is the only way to point at something the file itself makes, as a parent or as an end of a link.
- **create_link** joins \`source\`.\`sourceSlot\` (nearly always \`out\`) to \`target\`.\`targetSlot\`.
- **update** changes \`properties\` on an existing component (\`ord\`). **delete_link** takes the target's \`ord\` and the link's \`slot\` name (from \`bask call describe_component\`). **delete** takes an \`ord\`. **rename** takes \`ord\` and \`name\`.
- Up to 100 changes in a file.

## Setting values
- A property value is always typed: \`{ "typeSpec": "baja:Double", "encoded": "8" }\`, \`{ "typeSpec": "baja:Boolean", "encoded": "true" }\`.
- **A plain setting** takes its name: \`"proportionalConstant": { "typeSpec": "baja:Double", "encoded": "8" }\`.
- **An input** (the middle column below) is a status value. To give it a fixed number instead of a link, set the number inside it with the path \`"inputLowLimit/value"\`. Where a link would read better, link a \`kitControl:NumericConst\` to it instead: the constant shows on the sheet.
- **Units and decimals** are the block's \`facets\`. Copy them as the station shows them on a block that has the ones you want.
- For anything not shown here, use the type and encoding the station itself reports: \`bask call describe_component '{"ord":"<a block like it>"}'\` for one that exists, or \`bask call describe_component_types '{"typeSpec":"kitControl:Reset"}'\` for a type's slots.

## Blocks you will use most
| type | inputs: a link feeds them, or set \`name/value\` | plain settings |
| --- | --- | --- |
${BLOCKS.map(([type, ins, settings]) => `| ${type} | ${ins} | ${settings} |`).join("\n")}

Every block has an \`out\`. A writable point takes a link on \`in1\` to \`in16\`; \`in10\` is the usual one for logic, below an operator's override at 8.

## Keep in mind
- Commanding a point is not logic. Use \`bask write\` for that; a plan that sets a point's \`in\` slots or \`fallback\`, or invokes \`override\`, is refused (\`agent_use_write\`). Linking a block's \`out\` to a point's \`in10\` is logic, and allowed.
- The station decides whether an agent may apply plans at all (\`bask status\`: "may do by itself"). If it may not, the refusal names the setting; tell the person.
- Read back what you built, settings included. A value that does not make sense on the sheet is the thing to fix before saying it is done.
`;
}
