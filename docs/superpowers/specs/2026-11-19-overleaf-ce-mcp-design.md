# Overleaf Community Edition MCP Server Design

**Date:** 2026-11-19
**Target Workspace:** `/home/cusniwtt/Documents/overleaf-mcp`
**Target Overleaf Instance:** Self-hosted Overleaf Community Edition (`sharelatex/sharelatex:custom`) running via Podman Compose at `http://localhost:12980`

---

## 1. Intent & Why

The user runs a self-hosted Overleaf Community Edition (CE) instance locally with Podman Compose (`~/Documents/overleaf/compose.yml`, exposed on `http://localhost:12980`) and wants AI coding harnesses—specifically Antigravity (`agy`) and OpenCode—to read and edit LaTeX files in Overleaf projects directly from conversation. After edits finish, the user expects to refresh Overleaf (or see updates) cleanly without manual copy-pasting.

Existing Git-based Overleaf MCP servers (such as `mjyoo2/OverleafMCP`) cannot work here because Overleaf CE does not include `git-bridge`. Meanwhile, editing the `mongo` container directly would miss active un-flushed edits in `redis` (`document-updater`) and risk silently being overwritten by an open Overleaf browser session.

Therefore, this server integrates directly with Overleaf CE's own Web HTTP + Real-time Socket.IO APIs as a logged-in Overleaf user, requiring **zero modifications** to `~/Documents/overleaf/compose.yml` or the running containers.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Provide a local **stdio MCP server** compatible with both Antigravity (`agy`) and OpenCode.
- Connect to self-hosted Overleaf CE over HTTP + WebSocket (`http://localhost:12980` by default, configurable via `OVERLEAF_URL`).
- Authenticate with Overleaf account credentials (`OVERLEAF_EMAIL` + `OVERLEAF_PASSWORD` or `OVERLEAF_PASSWORD_FILE`) and automatically recover from expired sessions/CSRF tokens.
- Support project and file discovery:
  - List Overleaf projects (`list_projects`).
  - List files in a project with full folder-relative paths and optional extension filtering (`list_files`).
  - Summarize project structure (`status_summary`).
- Support reading and LaTeX-aware inspection:
  - Read full text files (`.tex`, `.bib`, `.cls`, `.sty`, etc.) (`read_file`).
  - Parse LaTeX section hierarchy (`get_sections`) and extract a named section (`get_section_content`) using brace-balanced parsing.
- Support safe editing and file creation:
  - Replace an entire text document via Overleaf Operational Transformation (OT) updates (`write_file`).
  - Replace a targeted LaTeX section via OT updates (`write_section`), leaving the rest of the file untouched.
  - Create new text documents (and parent folders if needed) inside a project (`create_file`).
- Support compilation verification:
  - Trigger a remote compile in Overleaf CE (`compile_project`) and return compile status plus error/warning diagnostics extracted from the build log.

### Non-Goals
- Git Bridge (`git.overleaf.com` / `git` CLI) integration.
- Direct database or cache manipulation (`mongo`, `redis`, `podman exec`) at runtime.
- Binary asset editing or upload/download (`png`, `pdf` content streaming) in v1—binary files should appear in `list_files` metadata, while `read_file`/`write_file` operate on UTF-8 text documents only.
- Multi-user OAuth / hosted SaaS multi-tenancy; this is a single-user local MCP server.

### Anti-Goals
- **Silent data loss / browser clobbering:** Never overwrite an active Overleaf document by bypassing OT versioning.
- **Credential leakage:** Never print passwords, CSRF tokens, or `overleaf.sid` cookies to `stdout`, `stderr`, or MCP tool error payloads.
- **Corrupting MCP stdio:** `stdout` is strictly reserved for MCP JSON-RPC frames; all diagnostics must go to `stderr`.

---

## 3. Verified Platform Constraints (from Running Overleaf CE)

Inspection of the running `sharelatex` container (`~/Documents/overleaf/compose.yml`) established the following facts:

1. **Web Exposure:** Overleaf nginx listens on `http://localhost:12980` (mapped `12980:80`).
2. **Real-Time Socket.IO Version:** `/overleaf/services/real-time/package.json` uses `github:overleaf/socket.io#0.9.19-overleaf-12` (**Socket.IO v0.9 wire protocol**). Modern `socket.io-client` (v3/v4) **cannot** connect to it. The client must implement Socket.IO v0.9 handshake (`GET /socket.io/1/?t=...`) and WebSocket framing (`ws://.../socket.io/1/websocket/<sid>` with the `overleaf.sid` cookie), handle `2::` heartbeats and `serverPing` messages, and use `5:::` event packets with acks.
3. **Web HTTP Routes (verified in `/overleaf/services/web/app/src/router.mjs` & `EditorRouter.mjs`):**
   - `GET /login` → returns `overleaf.sid` cookie and HTML containing `_csrf` token.
   - `POST /login` → accepts `_csrf`, `email`, `password` to authenticate the session cookie.
   - `GET /user/projects` → lists projects as JSON.
   - `GET /project/:Project_id/entities` → returns the project's folder/doc/file entity tree.
   - `GET /Project/:Project_id/doc/:Doc_id/download` → downloads document text (useful fallback, though `joinDoc` over Socket.IO returns authoritative live text + version `v`).
   - `POST /project/:Project_id/doc` → creates a new doc (`{ name, parent_folder_id }`, requires `x-csrf-token`).
   - `POST /project/:Project_id/folder` → creates a folder (`{ name, parent_folder_id }`, requires `x-csrf-token`).
   - `POST /project/:Project_id/compile` → triggers project compilation (requires `x-csrf-token`) and returns build status and `outputFiles` (including `.log` and `.pdf` paths).
4. **Real-Time Events (verified in `/overleaf/services/real-time/app/js/Router.js` & `WebsocketController.js`):**
   - `joinProject` → joins the project context for the socket connection (must be called before `joinDoc` / `applyOtUpdate`).
   - `joinDoc(docId, fromVersion, options)` → returns current document lines and version `v`.
   - `applyOtUpdate(docId, update)` → validates `update` via strict Zod schema: `{ v, op, doc?, lastV?, ... }` where `op` is a non-empty array of `{ i: string, p: number }` (insert) and/or `{ d: string, p: number }` (delete) at UTF-16 offset `p` in `lines.join('\n')`.

---

## 4. Architecture & Design Decisions

### Decisions Made (Including Our Calls for Review)

1. **Language & Runtime (Our Call):** **TypeScript on Node.js (>= 20)** using `@modelcontextprotocol/sdk`, `ws`, and `zod`. Built to `dist/` with a `bin` entrypoint so both `agy` and `opencode` can invoke it directly over stdio (`node /path/to/dist/index.js`).
2. **Protocol Strategy (Confirmed):** Use **Overleaf HTTP + Socket.IO 0.9 WebSocket** (`joinProject` → `joinDoc` → `applyOtUpdate`) rather than container database access.
   - Reads (`read_file`, `get_sections`, `get_section_content`) use `joinDoc` (with `joinProject` session cached or re-established per project) so the AI always sees the freshest state including live browser edits in `redis`.
   - Writes (`write_file`, `write_section`) compute OT operations against the latest snapshot `v` from `joinDoc` and submit via `applyOtUpdate`.
3. **Configuration & Secrets (Our Call):**
   - Environment variables:
     - `OVERLEAF_URL` (optional, defaults to `http://localhost:12980`)
     - `OVERLEAF_EMAIL` (required)
     - `OVERLEAF_PASSWORD` or `OVERLEAF_PASSWORD_FILE` (one required; `OVERLEAF_PASSWORD_FILE` recommended so plaintext passwords aren't stored in MCP client JSON configs)
     - `OVERLEAF_DEFAULT_PROJECT` (optional project ID or exact project name so single-paper workflows don't need `project` passed on every tool call)
4. **Project & File Addressing (Our Call):**
   - Every project-scoped tool accepts an optional `project` parameter (accepting either Overleaf `projectId` or project name; defaults to `OVERLEAF_DEFAULT_PROJECT` if set, or errors with the available project list if ambiguous/omitted).
   - File paths are POSIX-style paths relative to the project root (e.g., `main.tex`, `sections/intro.tex`), resolved deterministically against `/project/:Project_id/entities`. Path traversal (`..`) or unknown paths produce clear errors.
5. **Concurrency, Stale-Read Protection & Session Lifecycle (Our Call):**
   - Maintain a serialized per-project/per-doc async queue inside the MCP server so parallel tool calls from an AI harness don't race on Socket.IO state or OT versions.
   - **Stale-read protection (Our Call):** Cache the last-read document version `v` per `(projectId, docId)` whenever `read_file`, `get_sections`, `get_section_content`, or a successful write completes. On `write_file` / `write_section`, compare the live `joinDoc` version against `expectedVersion` (if supplied) or the cached last-read `v`; if Overleaf's live `v` advanced in the meantime (e.g., due to a concurrent browser edit), **reject the write** with an explicit conflict error instructing the AI to re-read first (unless `force: true` is explicitly passed). If `applyOtUpdate` still encounters a version race mid-flight, re-check against the same policy rather than blindly overwriting.
   - Cache the authenticated session cookie and CSRF token in memory; if an HTTP call returns `401`/`403` or redirects to `/login`, or a Socket.IO connection rejects auth, clear the session, re-login once, and retry.
   - Mask passwords, CSRF tokens, and `overleaf.sid` cookie values in any logged or returned error string.
6. **LaTeX Section Editing Contract (Our Call):**
   - Reuse the brace-balanced section-parsing approach (`\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`, starred variants, `[short]{long}` titles) so `get_sections`, `get_section_content`, and `write_section` handle nested macros like `\section{Use of \emph{X}}` cleanly.
   - **Heading inclusion (Our Call):** `get_section_content` returns the full section slice **including its `\section{...}` heading line** through just before the next section of equal or higher level (or `\end{document}` / EOF). Correspondingly, `write_section`'s `newContent` replaces from the start of that heading line and **must include the heading line** (explicitly documented in the tool schema), giving an exact `get_section_content` ↔ `write_section` round-trip.
   - **Duplicate titles & matching (Our Call):** `sectionTitle` matches raw LaTeX title text inside `{...}` (trimmed of leading/trailing whitespace). `get_sections` returns `{ type, title, index }` where `index` is the 0-based UTF-16 character offset in the file. Both `get_section_content` and `write_section` accept an optional `sectionIndex` (or `occurrence`) parameter; if `sectionTitle` matches multiple headings and no `sectionIndex` is given, the server rejects with an ambiguity error listing each matching heading's `type` and `index`.

### Tool Surface (v1)

| Tool | Inputs | Behavior |
|---|---|---|
| `list_projects` | *(none)* | Lists accessible Overleaf projects (`id`, `name`, `lastUpdated`, `accessLevel`). |
| `list_files` | `project?`, `extension?` | Lists project entities with POSIX paths, types (`doc` vs `file`), and IDs. |
| `status_summary` | `project?` | Returns file counts, detected root/main `.tex` file, and its section outline. |
| `read_file` | `filePath`, `project?` | Reads UTF-8 content of a `doc` entity (rejects binary `file` entities clearly) and records its live version `v`. |
| `get_sections` | `filePath`, `project?` | Lists parsed section headings (`type`, `title`, `index`). |
| `get_section_content` | `filePath`, `sectionTitle`, `sectionIndex?`, `project?` | Returns full content (including heading line) of the named/indexed section and records live version `v`. |
| `write_file` | `filePath`, `content`, `project?`, `expectedVersion?`, `force?` | Verifies no stale read against live `joinDoc` `v`, computes OT diff, and pushes via `applyOtUpdate`. |
| `write_section` | `filePath`, `sectionTitle`, `newContent`, `sectionIndex?`, `project?`, `expectedVersion?`, `force?` | Verifies no stale read, replaces the target section (including heading line), and pushes OT diff via `applyOtUpdate`. |
| `create_file` | `filePath`, `content?`, `project?` | Creates missing parent folders + doc via HTTP API, then populates `content` via OT update if non-empty. |
| `compile_project` | `project?`, `rootDocPath?` | Triggers `POST /project/:id/compile`, returns status and compiler log excerpt/errors. |

---

## 5. What's Left to the Builder

The builder has full discretion over:
1. **Internal module structure** (e.g., splitting `auth/http-client`, `realtime/socket09-client`, `realtime/ot-diff`, `latex/sections`, `mcp/server`).
2. **Exact Socket.IO 0.9 packet codec** (`0::`, `1::`, `2::`, `3:::`, `5:::id+` ack correlation) and heartbeat/reconnect timings.
3. **OT diffing algorithm** (e.g., prefix/suffix trim + diff or `fast-diff` producing `{ p, d }` / `{ p, i }` ops with UTF-16 string indices, plus a bounded retry loop if `v` changes mid-flight).
4. **Exact login/CSRF/compile payload details** verified against the live `http://localhost:12980` instance (for example, how `_csrf` appears in `/login` HTML and `/Project/:id` or `/user/projects` responses, and how `CompileController.compile` formats `outputFiles` URLs for `.log`).
5. **Test strategy**: unit tests for Socket.IO 0.9 framing, OT diffing, entity-tree path resolution, and LaTeX section parsing, plus a smoke verification script against the local Overleaf instance.
6. **Documentation**: `README.md` with setup instructions and ready-to-use MCP config snippets for Antigravity (`agy`) and OpenCode.
