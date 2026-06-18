/**
 * Stateful side of the Claude Code collector: backfill scanning and live
 * watching. Depends on the store; the parsing logic lives in claude-code.ts
 * (pure, store-free) so it can be tested in isolation.
 */

import { watch, statSync, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { ImpactStore } from "../store/db.js";
import {
  parseClaudeCodeText,
  parseClaudeCodeLine,
  listSessionFiles,
  defaultProjectsDir,
  type KeyedEvent,
} from "./claude-code.js";

export interface ScanResult {
  files: number;
  eventsFound: number;
  eventsAdded: number;
}

/** Backfill: scan every session file under `dir`, recording new events. */
export function scanDir(store: ImpactStore, dir: string = defaultProjectsDir()): ScanResult {
  const files = listSessionFiles(dir);
  let found = 0;
  let added = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileUtf8(f);
    } catch {
      continue;
    }
    for (const ke of parseClaudeCodeText(text)) {
      found++;
      if (store.insertOnce(ke.key, ke.event)) added++;
    }
  }
  return { files: files.length, eventsFound: found, eventsAdded: added };
}

function readFileUtf8(path: string): string {
  const size = statSync(path).size;
  return readRange(path, 0, size);
}

/** Read bytes [start, end) of a file as UTF-8. */
function readRange(path: string, start: number, end: number): string {
  const len = end - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Watches a Claude Code projects directory and records usage from new assistant
 * entries as they're written. Backfills on start, then tails appended bytes
 * (tracking a per-file offset, so big files aren't re-read).
 */
export class ClaudeCodeWatcher {
  private store: ImpactStore;
  private dir: string;
  private offsets = new Map<string, number>();
  private leftovers = new Map<string, string>();
  private watcher?: FSWatcher;
  private onEvent?: (e: KeyedEvent) => void;

  constructor(store: ImpactStore, dir: string = defaultProjectsDir(), onEvent?: (e: KeyedEvent) => void) {
    this.store = store;
    this.dir = dir;
    this.onEvent = onEvent;
  }

  /** Backfill, then begin watching. Returns the backfill result. */
  start(): ScanResult {
    const result = scanDir(this.store, this.dir);
    // Seed offsets at current sizes so we only read content appended from now.
    for (const f of listSessionFiles(this.dir)) {
      try {
        this.offsets.set(f, statSync(f).size);
      } catch {
        /* ignore */
      }
    }
    this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const path = join(this.dir, filename.toString());
      if (path.endsWith(".jsonl")) this.processTail(path);
    });
    return result;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Read only the bytes appended since we last saw this file. */
  private processTail(path: string): void {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // file removed/renamed
    }
    let offset = this.offsets.get(path) ?? 0;
    if (size < offset) offset = 0; // truncated/rotated — re-read from start

    if (size === offset) return;
    const chunk = readRange(path, offset, size);
    this.offsets.set(path, size);

    const buffered = (this.leftovers.get(path) ?? "") + chunk;
    const lines = buffered.split(/\r?\n/);
    // The last element may be a partial line still being written.
    this.leftovers.set(path, lines.pop() ?? "");

    for (const line of lines) {
      const ke = parseClaudeCodeLine(line);
      if (ke && this.store.insertOnce(ke.key, ke.event)) this.onEvent?.(ke);
    }
  }
}
