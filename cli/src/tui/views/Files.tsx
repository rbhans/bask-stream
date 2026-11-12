import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaskStreamClient, FileContent, FileEntry } from "@basidekick/baskstream";
import { fmtTime } from "../../format.js";
import { useKeys, type Rect } from "../input.js";
import { Empty, Panel, Table, clip, fit, theme, useCursor, useUi, type Column } from "../ui.js";

export const fmtBytes = (n: number | undefined) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const parentPath = (p: string) => (p.lastIndexOf("/") <= 0 ? "^" : p.slice(0, p.lastIndexOf("/")));
const join = (folder: string, name: string) => (folder === "^" ? `^${name}` : `${folder}/${name}`);

export function FilesView(props: { client: BaskStreamClient; active: boolean; rect: Rect }) {
  const { client, active, rect } = props;
  const ui = useUi();
  const [folder, setFolder] = useState("^");
  const [listing, setListing] = useState<{ path: string; entries?: FileEntry[]; error?: string }>({ path: "^" });
  const [preview, setPreview] = useState<{ path: string; file?: FileContent; error?: string }>();
  const [focus, setFocus] = useState<"list" | "preview">("list");
  const [scroll, setScroll] = useState(0);
  const [n, setN] = useState(0);
  const supported = Boolean(client.capabilities.workbench);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    client.listFiles(folder).then(
      (reply) => !cancelled && setListing({ path: folder, entries: [...reply.entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) }),
      (error: Error) => !cancelled && setListing({ path: folder, error: error.message })
    );
    return () => {
      cancelled = true;
    };
  }, [folder, n, supported]);

  const entries = listing.path === folder ? listing.entries ?? [] : [];
  const wide = rect.width >= 96;
  const listWidth = wide ? Math.max(40, Math.floor(rect.width * 0.42)) : rect.width;
  const listHeight = wide ? rect.height : Math.max(6, Math.floor(rect.height * 0.45));
  const listSize = Math.max(1, listHeight - 3);
  const previewWidth = wide ? rect.width - listWidth : rect.width;
  const previewHeight = wide ? rect.height : rect.height - listHeight;
  const previewSize = Math.max(1, previewHeight - 2);

  const open = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.directory) setFolder(entry.path);
    else setFocus("preview");
  };
  const list = useCursor(entries.length, listSize, { active: active && focus === "list", region: { x: rect.x + 2, y: rect.y + 2, width: listWidth - 4, height: listSize }, onEnter: open });
  const selected = entries[list.cursor];
  useEffect(() => list.setCursor(0), [folder]);

  // Preview the selected file shortly after the cursor settles.
  useEffect(() => {
    setScroll(0);
    if (!selected || selected.directory || !active) return void setPreview(undefined);
    const target = selected.path;
    const timer = setTimeout(() => {
      client.readFile(target, { maxBytes: 262144 }).then(
        (file) => setPreview({ path: target, file }),
        (error: Error & { code?: string }) => setPreview({ path: target, error: error.code === "file_too_large" ? "Too large to preview. Press s to save a copy." : error.message })
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [selected?.path, active, n]);

  const lines = useMemo(() => (preview?.file?.encoding === "text" ? (preview.file.text ?? "").replace(/\r/g, "").split("\n") : []), [preview?.file]);

  const save = (entry: FileEntry) =>
    void ui.attempt("read", () => client.readFile(entry.path)).then((file) => {
      if (!file) return;
      const local = path.resolve(entry.name);
      try {
        writeFileSync(local, file.encoding === "text" ? Buffer.from(file.text ?? "", "utf8") : Buffer.from(file.base64 ?? "", "base64"));
        ui.toast(`Saved a copy to ${local}`, "good");
      } catch (e) {
        ui.toast(`Could not save: ${(e as Error).message}`, "bad");
      }
    });

  /** Opens the text in $VISUAL / $EDITOR and offers to write it back when it changed. */
  const edit = (target: string, original: string, isNew: boolean) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bask-edit-"));
    const temp = path.join(dir, target.split("/").pop() ?? "file.txt");
    let after = original;
    try {
      writeFileSync(temp, original);
      const [command, ...args] = (process.env.VISUAL || process.env.EDITOR || "vi").split(/\s+/);
      ui.suspend(() => void spawnSync(command, [...args, temp], { stdio: "inherit" }));
      after = readFileSync(temp, "utf8");
    } catch (e) {
      ui.toast(`Editor failed: ${(e as Error).message}`, "bad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (after === original && !isNew) return ui.toast("No changes to save.", "info");
    ui.confirm(`${isNew ? "Create" : "Save changes to"} ${target}? (${fmtBytes(Buffer.byteLength(after))})`, async () => {
      const done = await ui.attempt("write", () => client.writeFile(target, { text: after }, { overwrite: !isNew, createDirs: true }));
      if (!done) return;
      ui.toast(`${isNew ? "Created" : "Saved"} ${target}`, "good");
      setN((v) => v + 1);
    }, { title: "Station file" });
  };

  useKeys(
    (input, key) => {
      if (focus === "preview") {
        if (key.escape || key.leftArrow || input === "h") setFocus("list");
        else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
        else if (key.downArrow || input === "j") setScroll((s) => Math.min(Math.max(0, lines.length - previewSize), s + 1));
        else if (key.pageUp) setScroll((s) => Math.max(0, s - previewSize));
        else if (key.pageDown || input === " ") setScroll((s) => Math.min(Math.max(0, lines.length - previewSize), s + previewSize));
        if (input !== "e") return;
      }
      if (key.leftArrow || key.backspace || key.delete || input === "h") {
        if (folder !== "^") setFolder(parentPath(folder));
      } else if (key.rightArrow || input === "l") open(list.cursor);
      else if (input === "r") setN((v) => v + 1);
      else if (input === "y" && selected) ui.copy(selected.path, "path");
      else if (input === "s" && selected && !selected.directory) save(selected);
      else if (input === "e" && selected && !selected.directory) {
        if (!ui.canWrite("edit station files")) return;
        void ui.attempt("read", () => client.readFile(selected.path, { encoding: "text" })).then((file) => file && edit(selected.path, file.text ?? "", false));
      } else if (input === "n") {
        if (!ui.canWrite("create station files")) return;
        ui.prompt(`New file in ${folder}`, (name) => name.trim() && edit(join(folder, name.trim()), "", true), { hint: "a name such as notes.txt, or sub/folder/file.px" });
      } else if (input === "u") {
        if (!ui.canWrite("upload files")) return;
        ui.prompt(`Upload a local file into ${folder}`, (local) => {
          const source = path.resolve(local.trim().replace(/^~(?=\/)/, os.homedir()));
          let bytes: Buffer;
          try {
            bytes = readFileSync(source);
          } catch (e) {
            return ui.toast(`Cannot read ${source}: ${(e as Error).message}`, "bad");
          }
          const target = join(folder, path.basename(source));
          const exists = entries.some((entry) => entry.path === target);
          ui.confirm(`${exists ? "Replace" : "Upload"} ${target} with ${path.basename(source)} (${fmtBytes(bytes.length)})?`, async () => {
            const done = await ui.attempt("upload", () => client.writeFile(target, { base64: bytes.toString("base64") }, { overwrite: exists }));
            if (!done) return;
            ui.toast(`Uploaded ${target}`, "good");
            setN((v) => v + 1);
          }, { title: "Station file", danger: exists });
        }, { hint: "path on this computer" });
      } else if (input === "D" && selected) {
        if (!ui.canWrite("delete station files")) return;
        void ui.attempt("delete", () => client.deleteFile(selected.path, { recursive: selected.directory, dryRun: true })).then((dry) => {
          if (!dry) return;
          const doomed = (dry.deleted ?? []) as string[];
          ui.confirm(`Delete ${selected.path}${doomed.length > 1 ? ` and the ${doomed.length - 1} entries under it` : ""}? This cannot be undone.`, async () => {
            const done = await ui.attempt("delete", () => client.deleteFile(selected.path, { recursive: selected.directory }));
            if (!done) return;
            ui.toast(`Deleted ${selected.path}`, "good");
            setN((v) => v + 1);
          }, { title: "Delete file", danger: true, lines: doomed.slice(0, 8) });
        });
      }
    },
    { isActive: active && supported }
  );

  const inner = listWidth - 4;
  const [nameWidth, sizeWidth, timeWidth] = fit(inner, [{ min: 16, flex: 1 }, { min: 9 }, { min: inner >= 56 ? 16 : 0 }]);
  const columns: Column<FileEntry>[] = [
    { title: "name", width: nameWidth, cell: (e, i) => ({ text: `${e.directory ? "▸ " : "  "}${e.name}${e.directory ? "/" : ""}`, color: e.directory ? theme.accent : undefined, bold: i === list.cursor }) },
    { title: "size", width: sizeWidth, align: "right", cell: (e) => ({ text: e.directory ? "" : fmtBytes(e.size), color: theme.muted }) },
    { title: "modified", width: timeWidth, cell: (e) => ({ text: e.modified ? fmtTime(e.modified).slice(0, 16) : "", color: theme.muted }) }
  ];
  const previewing = preview && selected && preview.path === selected.path ? preview : undefined;
  const numberWidth = String(lines.length).length;

  if (!supported) {
    return (
      <Panel title="Files" width={rect.width} height={rect.height}>
        <Text color={theme.warn} wrap="wrap">Station files need baskStream API 1.10 on the station (this one reports {String(client.capabilities.apiVersion ?? "an older version")}).</Text>
      </Panel>
    );
  }

  return (
    <Box height={rect.height} flexDirection={wide ? "row" : "column"}>
      <Panel title={`Files · ${folder}`} meta={entries.length ? `${entries.length}` : undefined} width={listWidth} height={listHeight} focused={focus === "list"}>
        {listing.error ? (
          <Text color={theme.bad} wrap="wrap">{listing.error}</Text>
        ) : listing.path !== folder || !listing.entries ? (
          <Text color={theme.muted}>Reading {folder}…</Text>
        ) : entries.length === 0 ? (
          <Empty title="This folder is empty.">
            <Text color={theme.muted}>Press <Text color={theme.accent} bold>n</Text> for a new file, <Text color={theme.accent} bold>u</Text> to upload, or ← to go up.</Text>
          </Empty>
        ) : (
          <Table columns={columns} rows={entries} start={list.start} size={listSize} cursor={list.cursor} rowKey={(e) => e.path} focused={focus === "list"} />
        )}
      </Panel>
      <Panel title={selected && !selected.directory ? selected.name : "Preview"} meta={previewing?.file ? `${fmtBytes(previewing.file.size)}${lines.length ? ` · ${lines.length} lines` : ""}` : undefined} width={previewWidth} height={previewHeight} focused={focus === "preview"}>
        {!selected ? null : selected.directory ? (
          <Text color={theme.muted}>Folder. Press → or enter to open it.</Text>
        ) : previewing?.error ? (
          <Text color={theme.bad} wrap="wrap">{previewing.error}</Text>
        ) : !previewing?.file ? (
          <Text color={theme.faint}>…</Text>
        ) : previewing.file.encoding !== "text" ? (
          <Text color={theme.muted} wrap="wrap">Not a text file ({fmtBytes(previewing.file.size)}). Press s to save a copy to this computer.</Text>
        ) : (
          lines.slice(scroll, scroll + previewSize).map((line, i) => (
            <Text key={scroll + i} wrap="truncate-end">
              <Text color={theme.faint}>{String(scroll + i + 1).padStart(numberWidth)} </Text>
              <Text color={/^\s*<[!?]/.test(line) ? theme.muted : undefined}>{clip(line.replace(/\t/g, "  "), previewWidth - 5 - numberWidth)}</Text>
            </Text>
          ))
        )}
      </Panel>
    </Box>
  );
}
