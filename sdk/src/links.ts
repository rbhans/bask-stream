// A new link is a slot on its target, and the station wants a name for it. Nobody cares what a link is
// called, so one without a name gets Workbench's own ("Link", then Link2, Link3… where that is taken).
import type { Json } from "./core.js";

export const namedLinks = (changes: Json[]): Json[] =>
  changes.map((change) => (change && change.action === "create_link" && !change.name ? { ...change, name: "Link", collision: "suffix" } : change));
