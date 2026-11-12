// Where graphics are kept: on the station, in its file space, one JSON file each. They stay with
// the station (its backups and copies carry them), every bask on that station shows the same ones,
// and each save or delete is in the station's audit history like any other file change.
import type { BaskStreamClient, Json } from "@basidekick/baskstream";

export const GRAPHICS_FOLDER = "^bask/graphics";

export interface GraphicEntry {
  name: string;
  path: string;
  modified?: number;
  size?: number;
}

/** A file name for a graphic: lower-case letters, digits and dashes. */
export function graphicName(text: string): string {
  const name = text.replace(/\.json$/i, "").replace(/^.*[\\/]/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error(`"${text}" does not make a graphic name: use letters and digits.`);
  return name;
}

export const graphicPath = (name: string) => `${GRAPHICS_FOLDER}/${graphicName(name)}.json`;

/** The graphics saved on the station, by name. None when the folder has never been written. */
export async function listGraphics(client: BaskStreamClient): Promise<GraphicEntry[]> {
  try {
    const folder = await client.listFiles(GRAPHICS_FOLDER);
    return folder.entries
      .filter((entry) => !entry.directory && /\.json$/i.test(entry.name))
      .map((entry) => ({ name: entry.name.replace(/\.json$/i, ""), path: entry.path, modified: entry.modified ?? undefined, size: entry.size ?? undefined }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as { code?: string }).code === "file_not_found") return [];
    throw error;
  }
}

/** A saved graphic as it was written: parsed JSON, not yet checked. */
export async function loadGraphic(client: BaskStreamClient, name: string): Promise<unknown> {
  const file = await client.readFile(graphicPath(name), { encoding: "text" });
  try {
    return JSON.parse(file.text ?? "");
  } catch (error) {
    throw new Error(`${graphicPath(name)} is not valid JSON: ${(error as Error).message}`);
  }
}

export async function saveGraphic(client: BaskStreamClient, name: string, doc: unknown, options: { reason?: string } = {}): Promise<Json> {
  return client.writeFile(graphicPath(name), { text: `${JSON.stringify(doc, null, 2)}\n` }, { overwrite: true, createDirs: true, ...options });
}

export async function deleteGraphic(client: BaskStreamClient, name: string, options: { reason?: string } = {}): Promise<Json> {
  return client.deleteFile(graphicPath(name), options);
}
