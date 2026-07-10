# AI Session Parsing — Instructions for AI Agents

> **Audience: AI agents.** This document tells you how to read another AI CLI
> session's history as clean, compact, resumable context. Output is optimized
> for machine reading, not human formatting.

## What this does

`trellis mem` reads the persisted session history of AI coding CLIs
(**Claude Code, Codex CLI, Kiro, Pi**), strips the noise (reasoning-signature
blobs, tool-call dumps, system-reminder / task-notification injections,
bootstrap preambles), and emits the cleaned user↔assistant dialogue as
Markdown (for reading) or JSON (for further tooling).

Typical cleaned output is **1–4% of the raw session file size** while keeping
the actual conversation.

## Prerequisites

Run from the built repo (or an install of `@mindfoldhq/trellis`):

```bash
# from a checkout — build core AND cli once (cli/bin points at dist/):
pnpm -C packages/core build
pnpm -C packages/cli build
node packages/cli/bin/trellis.js mem <subcommand> ...
# or, if installed globally:
trellis mem <subcommand> ...
```

> `--json` output is written to **stdout** only; all notices/warnings go to
> **stderr**, so `trellis mem extract <id> --json > out.json` yields clean JSON.

All commands below use `trellis mem`; substitute the local invocation if not
installed globally.

## The 5 subcommands

| Subcommand | Purpose |
|---|---|
| `list` | list sessions (id, title, cwd, timestamps) |
| `search <keyword>` | find sessions whose dialogue matches a keyword |
| `context <session-id>` | top-N matching turns + surrounding context (token-budgeted) |
| `extract <session-id>` | dump the full cleaned dialogue |
| `projects` | list project cwds with session counts (discover what to scope to) |

## Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--platform claude\|codex\|kiro\|pi\|all` | all | source CLI (default `all`) |
| `--session-id <id>` | — | not a flag; pass the id as a positional arg to `context`/`extract` (prefix match allowed) |
| `--cwd <path>` | list/search/context/extract | scope to a project dir (default: current cwd) |
| `--global` | list/search | ignore cwd scoping, search everywhere |
| `--since YYYY-MM-DD` / `--until YYYY-MM-DD` | list/search | time window |
| `--limit N` | list/search | cap results (default 50) |
| `--grep KW` | extract/context | filter/anchor turns by keyword (multi-token AND) |
| `--phase brainstorm\|implement\|all` | extract | slice by Trellis task boundaries (default `all`) |
| `--full` | extract/context | **preserve pre-compaction history** (see below) |
| `--turns N` | context | number of hit turns to surface (default 3) |
| `--around N` | context | turns of context around each hit (default 1) |
| `--max-chars N` | context | total char budget (default 6000, ~1500 tokens) |
| `--json` | all | emit JSON instead of Markdown |

### The `--full` flag (important for long sessions)

By default, a session that was **compacted** (the CLI summarized its own
history to save context) is rendered at its *last compaction state* — early
turns are represented only by the summary. A long session compacted many times
therefore shows very few assistant turns.

`--full` instead preserves **all pre-compaction turns**. Use it when you need
the complete work history, not just the latest summarized state. Trade-off:
much larger output.

- Default (compact state): smallest, good for "what's the current state?"
- `--full`: complete history, good for "what was actually done/tried?"

## Session storage locations (for reference)

| Platform | Path pattern |
|---|---|
| Claude Code | `~/.claude/projects/<sanitized-cwd>/<id>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` |
| Kiro (GUI) | `~/.kiro/sessions/<hash>/sess_<id>/messages.jsonl` (+ `session.json`) |
| Kiro (CLI) | `~/.kiro/sessions/cli/<id>.jsonl` (+ `<id>.json`) |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl` |

You do not need these paths to use the tool — `list`/`search` discover
sessions for you. They are documented for debugging only.

## Recommended workflow for an AI agent

You usually start knowing *what* you want, not the session id. Chain the
subcommands:

1. **Find the session.** If you know roughly when / what project:
   ```bash
   trellis mem list --global --since 2026-07-01
   ```
   Or by content:
   ```bash
   trellis mem search "review cashback bug" --global
   ```
   Both print session ids + titles. Pick the id.

2. **Peek before dumping.** Get just the relevant turns:
   ```bash
   trellis mem context 019f2d88 --grep "cashback" --turns 5
   ```

3. **Full read when needed.** Dump the whole cleaned dialogue:
   ```bash
   trellis mem extract 019f2d88 --json
   ```
   Add `--full` if the session was compacted and you need everything:
   ```bash
   trellis mem extract 019f2d88 --full --json
   ```

You can pass an **id prefix** (e.g. `019f2d88`) — the tool resolves it to the
full id, so you don't need to copy the whole UUID.

## Common invocations

```bash
# newest 20 sessions across all CLIs, any project
trellis mem list --global --limit 20

# Kiro sessions for the current project only
trellis mem list --platform kiro

# search Codex sessions in one project
trellis mem search "websocket handshake" --platform codex --cwd /path/to/repo

# extract as Markdown (default) for direct reading
trellis mem extract c938d87d

# extract as JSON for tooling
trellis mem extract c938d87d --json

# full history of a heavily-compacted session
trellis mem extract 019f2d88 --full --json
```

## JSON output shape (`extract --json`)

```jsonc
{
  "session": {
    "platform": "kiro",         // claude | codex | kiro | pi
    "id": "f9bc1c29-...",
    "title": "为何未触发 好评返现",
    "cwd": "E:\\ecom-copilot",
    "created": "2026-07-06T11:44:37.412Z",
    "updated": "2026-07-07T16:29:37.416Z",
    "filePath": "C:\\Users\\..\\f9bc1c29-....jsonl"
  },
  "phase": "all",
  "total_turns": 152,
  "turns": [
    { "role": "user",      "text": "..." },
    { "role": "assistant", "text": "..." }
  ],
  "warnings": []
}
```

`turns` is the cleaned dialogue in order. Roles are only `user` / `assistant`.
Compaction markers appear as a `user` turn beginning with `[compact summary]`.
The `list` / `search` JSON shapes contain the same `session` metadata objects.

## Error handling & exit codes

| Situation | Behavior |
|---|---|
| session id not found | `error: session not found: <id>` on stderr, exit code 2 |
| unknown `--platform` value | `error: unknown platform: <x>`, exit 2 |
| bad `--since` / `--until` date | `error: bad --since: <x>`, exit 2 |
| `--grep` with empty value | `error: --grep requires non-empty value`, exit 2 |
| session file exists but has no parseable dialogue | succeeds, `turns: []` (empty), exit 0 |
| corrupt / partial JSONL lines | silently skipped; the rest of the session still parses |
| session store dir does not exist for a platform | that platform contributes 0 sessions (no error) |
| OpenCode platform | reader temporarily disabled in this build; a notice is printed, other platforms unaffected |

When you get exit code 2, re-read the stderr line — it names the exact bad
argument. When you get `turns: []`, the session had no user/assistant content
worth keeping (e.g. an aborted turn); try `--full`, or pick another session.

## Notes on quality / what gets removed

The cleaner drops, per turn:

- reasoning / thinking blocks and their base64 signatures
- tool-call and tool-result payloads
- `<system-reminder>`, `<task-notification>`, `<usage>`, `<local-command-caveat>`,
  `<turn_aborted>`, and similar harness-injected blocks
- AGENTS.md / large `<INSTRUCTIONS>` bootstrap preambles

It keeps the actual user prompts and assistant replies. If you ever see
harness noise leaking into `turns`, that's a cleaner gap worth reporting.

## Extending to a new CLI

Each platform is an adapter under
`packages/core/src/mem/adapters/<platform>.ts` exposing
`listSessions` / `extractDialogue` / `search`. To add a CLI: copy the closest
existing adapter, wire it into `sessions.ts` (the 4 switch statements),
`types.ts` (`MemSourceKind`), `internal/paths.ts` (the store root), and the CLI
`VALID_PLATFORMS` list. See `packages/core/src/mem/adapters/kiro.ts` for a
two-format (GUI + CLI) example.
