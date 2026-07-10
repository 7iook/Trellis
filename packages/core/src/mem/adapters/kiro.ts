/**
 * Persisted Kiro session reader.
 *
 * Kiro writes two distinct on-disk formats under `~/.kiro/sessions/`:
 *
 *   GUI: `<workspace-hash>/sess_<id>/messages.jsonl` + sibling `session.json`
 *        Events are `{ id, payload: { type, ... } }`. `payload.type` is one of
 *        user / assistant / tool_call / tool_result / turn_* / session_*.
 *        Assistants carry `operationType` — "Reasoning" is chain-of-thought
 *        noise (with a base64 `reasoningSignature`), "Say" is the real reply.
 *
 *   CLI: `cli/<id>.jsonl` + sibling `cli/<id>.json`
 *        Events are `{ kind, version, data | content | ... }`. `kind` is
 *        Prompt / AssistantMessage / ToolResults / Compaction. Assistant
 *        content blocks are `{ kind: "thinking" | "text", data }`; thinking
 *        blocks carry a base64 `signature` and are dropped.
 *
 * Metadata (title / cwd / created / updated) comes from the sibling JSON file,
 * never from the dialogue stream. Both formats are read-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { stripInjectionTags, isBootstrapTurn } from "../dialogue.js";
import { inRangeOverlap, sameProject } from "../filter.js";
import { readJsonFile, readJsonl } from "../internal/jsonl.js";
import { KIRO_SESSIONS, walkDir } from "../internal/paths.js";
import { searchInDialogue } from "../search.js";
import type {
  DialogueRole,
  DialogueTurn,
  MemFilter,
  MemSessionInfo,
  SearchHit,
  TaskPyEvent,
} from "../types.js";

// ---------- loose external shapes ----------

/** GUI `messages.jsonl` event. */
interface KiroGuiEvent {
  payload?: {
    type?: string;
    operationType?: string;
    content?: unknown;
  };
}

/** GUI sibling `session.json`. */
interface KiroGuiMeta {
  id?: string;
  title?: string;
  workspacePaths?: unknown;
  createdAt?: string;
  lastModifiedAt?: string;
}

/** CLI `<id>.jsonl` event. Envelope is `{ kind, version, data }`; the message
 * body (message_id / content / summary) lives inside `data`. */
interface KiroCliBlock {
  kind?: string;
  data?: unknown;
}
interface KiroCliEvent {
  kind?: string;
  data?: {
    content?: KiroCliBlock[];
    summary?: string;
  };
}

/** CLI sibling `<id>.json`. */
interface KiroCliMeta {
  session_id?: string;
  title?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
}

type KiroLayout = "gui" | "cli";

/** Carry the resolved layout + metadata file through to extract without a
 * second stat pass. Encoded into MemSessionInfo.filePath's directory. */
function guiMetaPath(messagesFile: string): string {
  return path.join(path.dirname(messagesFile), "session.json");
}
function cliMetaPath(jsonlFile: string): string {
  return jsonlFile.replace(/\.jsonl$/, ".json");
}

function layoutOf(s: MemSessionInfo): KiroLayout {
  // CLI sessions live directly under `.../sessions/cli/<id>.jsonl`; GUI live
  // under `.../sessions/<hash>/sess_<id>/messages.jsonl`.
  return path.basename(s.filePath) === "messages.jsonl" ? "gui" : "cli";
}

function firstWorkspacePath(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

// ---------- list ----------

export function kiroListSessions(f: MemFilter): MemSessionInfo[] {
  if (!fs.existsSync(KIRO_SESSIONS)) return [];
  const out: MemSessionInfo[] = [];
  const cliDir = path.join(KIRO_SESSIONS, "cli");

  for (const file of walkDir(KIRO_SESSIONS)) {
    let layout: KiroLayout;
    let id: string;
    let metaFile: string;

    if (path.basename(file) === "messages.jsonl") {
      layout = "gui";
      // parent dir name is `sess_<id>`; strip the prefix for the public id.
      const parent = path.basename(path.dirname(file));
      id = parent.startsWith("sess_") ? parent.slice("sess_".length) : parent;
      metaFile = guiMetaPath(file);
    } else if (
      file.endsWith(".jsonl") &&
      path.dirname(file) === cliDir
    ) {
      layout = "cli";
      id = path.basename(file, ".jsonl");
      metaFile = cliMetaPath(file);
    } else {
      continue;
    }

    let title: string | undefined;
    let cwd: string | undefined;
    let created: string | undefined;
    let updatedFromMeta: string | undefined;

    if (layout === "gui") {
      const meta = readJsonFile<KiroGuiMeta>(metaFile);
      title = meta?.title;
      cwd = firstWorkspacePath(meta?.workspacePaths);
      created = meta?.createdAt;
      updatedFromMeta = meta?.lastModifiedAt;
    } else {
      const meta = readJsonFile<KiroCliMeta>(metaFile);
      title = meta?.title;
      cwd = meta?.cwd;
      created = meta?.created_at;
      updatedFromMeta = meta?.updated_at;
    }

    if (f.cwd && !sameProject(cwd, f.cwd)) continue;

    const updated =
      updatedFromMeta ??
      (() => {
        try {
          return fs.statSync(file).mtime.toISOString();
        } catch {
          return undefined;
        }
      })();

    if (!inRangeOverlap(created, updated, f)) continue;

    out.push({ platform: "kiro", id, title, cwd, created, updated, filePath: file });
  }
  return out;
}

// ---------- extract ----------

/** Push a cleaned turn from a raw string, dropping empties + bootstrap turns. */
function pushTextTurn(
  turns: DialogueTurn[],
  role: DialogueRole,
  raw: string,
): void {
  const cleaned = stripInjectionTags(raw);
  if (cleaned && !isBootstrapTurn(cleaned, raw.length)) {
    turns.push({ role, text: cleaned });
  }
}

function extractGui(file: string): DialogueTurn[] {
  // user: payload.type=="user", content is a string.
  // assistant: payload.type=="assistant" AND operationType=="Say" — "Reasoning"
  //   (chain-of-thought + base64 reasoningSignature) and everything else drop.
  //   tool_call / tool_result / turn_* / session_* / usage_* are noise.
  const turns: DialogueTurn[] = [];
  readJsonl<KiroGuiEvent>(file, (obj) => {
    const p = obj.payload;
    if (!p) return;
    if (p.type === "user") {
      if (typeof p.content === "string") pushTextTurn(turns, "user", p.content);
    } else if (p.type === "assistant" && p.operationType === "Say") {
      if (typeof p.content === "string")
        pushTextTurn(turns, "assistant", p.content);
    }
  });
  return turns;
}

/** Join the `text`-kind blocks of a CLI content array. `thinking` blocks
 * (whose `data` is an object carrying a base64 `signature`) are dropped. */
function cliBlocksToText(blocks: KiroCliBlock[] | undefined): string {
  const parts: string[] = [];
  for (const b of blocks ?? []) {
    if (b.kind !== "text") continue;
    if (typeof b.data === "string") parts.push(b.data);
  }
  return parts.join("\n\n");
}

function extractCli(file: string, full: boolean): DialogueTurn[] {
  // Prompt         -> user   (content[].kind=="text")
  // AssistantMessage -> assistant (content[].kind=="text"; thinking dropped)
  // ToolResults    -> dropped
  // Compaction     -> collapse prior turns into one [compact summary] turn
  //                   (unless `full`: keep the summary as a marker turn and
  //                   preserve all pre-compaction history)
  let turns: DialogueTurn[] = [];
  readJsonl<KiroCliEvent>(file, (obj) => {
    const d = obj.data;
    switch (obj.kind) {
      case "Compaction": {
        const summary =
          typeof d?.summary === "string" ? stripInjectionTags(d.summary) : "";
        if (full) {
          if (summary)
            turns.push({ role: "user", text: `[compact summary]\n${summary}` });
        } else {
          turns = summary
            ? [{ role: "user", text: `[compact summary]\n${summary}` }]
            : [];
        }
        return;
      }
      case "Prompt": {
        const raw = cliBlocksToText(d?.content);
        if (raw) pushTextTurn(turns, "user", raw);
        return;
      }
      case "AssistantMessage": {
        const raw = cliBlocksToText(d?.content);
        if (raw) pushTextTurn(turns, "assistant", raw);
        return;
      }
      default:
        return;
    }
  });
  return turns;
}

export function kiroExtractDialogue(
  s: MemSessionInfo,
  opts?: { full?: boolean },
): DialogueTurn[] {
  return layoutOf(s) === "gui"
    ? extractGui(s.filePath)
    : extractCli(s.filePath, opts?.full === true);
}

export function kiroSearch(s: MemSessionInfo, kw: string): SearchHit {
  return searchInDialogue(kiroExtractDialogue(s), kw);
}

/** Kiro has no `task.py create|start` phase boundary in its dialogue stream,
 * so events are always empty — phase slicing degrades to "all turns". */
export function collectKiroTurnsAndEvents(s: MemSessionInfo): {
  turns: DialogueTurn[];
  events: TaskPyEvent[];
} {
  return { turns: kiroExtractDialogue(s), events: [] };
}
