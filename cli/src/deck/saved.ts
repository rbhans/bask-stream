// What a person has settled about a site's map, kept on this computer and never written to the
// station: what feeds what (confirmed or corrected), and which reading each kind of unit shows.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { MODEL_FORMAT, type ModelReview } from "../model.js";

export interface SavedSite {
  review?: ModelReview;
  /** For a kind of equipment (or one unit, by ORD): the name of the point its tile shows. */
  tiles: Record<string, string>;
}

const fileFor = (host: string) => path.join(configDir(), "sites", `${host.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

export function loadSaved(host: string): SavedSite {
  try {
    const doc = JSON.parse(fs.readFileSync(fileFor(host), "utf8")) as Partial<SavedSite>;
    return { review: doc.review?.format === MODEL_FORMAT ? doc.review : undefined, tiles: doc.tiles ?? {} };
  } catch {
    return { tiles: {} };
  }
}

export function saveSite(host: string, saved: SavedSite): string {
  const file = fileFor(host);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return file;
}
