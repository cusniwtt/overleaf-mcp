# Overleaf CE MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript stdio MCP server so Antigravity (`agy`) and OpenCode can list, read, edit, create, and compile LaTeX files in a self-hosted Overleaf Community Edition instance (`http://localhost:12980`) over HTTP and Socket.IO v0.9.

**Architecture:** The server authenticates with Overleaf CE's web login (`GET /login` + `POST /login`) to obtain an `overleaf.sid` cookie and CSRF token, uses HTTP routes for project discovery, folder/doc creation, and compilation, and opens a custom Socket.IO v0.9 WebSocket client (`joinProject` → `joinDoc` → `applyOtUpdate`) for live OT-safe reads and edits. A serialized per-document service tracks last-read document versions to prevent silent browser clobbering and exposes 10 MCP tools over stdio.

**Tech Stack:** TypeScript, Node.js (>= 20), `@modelcontextprotocol/sdk`, `ws`, `zod`, `vitest`.

**Spec:** [2026-11-19-overleaf-ce-mcp-design.md](file:///home/cusniwtt/Documents/overleaf-mcp/docs/superpowers/specs/2026-11-19-overleaf-ce-mcp-design.md)

## Global Constraints

- Node.js `>= 20.0.0`, TypeScript ESM (`"type": "module"`), compiled to `dist/` with `bin` entrypoint `dist/index.js`.
- Default `OVERLEAF_URL` is `http://localhost:12980`; requires zero changes to `~/Documents/overleaf/compose.yml`.
- Must speak Socket.IO `0.9` wire protocol (`github:overleaf/socket.io#0.9.19-overleaf-12`), NOT Socket.IO `v3`/`v4`.
- `stdout` is strictly owned by MCP JSON-RPC frames; all logs go to `stderr`.
- Passwords, CSRF tokens, and `overleaf.sid` cookies must never appear in `stdout`, `stderr`, or MCP tool error messages.
- No Git Bridge, `git` CLI, `podman exec`, `mongo`, or `redis` runtime dependencies.

## Review Focus

- **Thai / non-ASCII UTF-8 round-trip:** Overleaf's `real-time` `joinDoc` encodes lines with `unescape(encodeURIComponent(text))` when `type !== 'history-ot'`; client must decode with `decodeURIComponent(escape(line))` and compute OT UTF-16 offsets on decoded strings without corrupting Thai characters (Task 3, Task 4).
- **Expired session / CSRF recovery:** An HTTP `401`/`403` or redirect to `/login` mid-session must trigger one automatic re-login and retry without leaking credentials in errors (Task 2).
- **Concurrent browser edit conflict:** If Overleaf's live `joinDoc` version `v` advances past the cached read `v` (or `expectedVersion`), `write_file`/`write_section` must reject with a conflict error instead of silently overwriting unless `force: true` (Task 6).
- **Nested-macro and duplicate LaTeX headings:** `\section{Use of \emph{X}}` must parse with balanced braces, and repeated headings like `\subsection{Evaluation}` must reject with matching `index` values when `sectionIndex` is omitted (Task 5).
- **Path traversal, binary files, and nested folders:** `../` paths and binary `file` entities must error cleanly on text operations, while `create_file` on `sections/ch1/intro.tex` must reuse existing folders and create only missing ones (Task 6).

---

### File Structure

- `package.json`, `tsconfig.json`, `.gitignore` — package metadata, TypeScript ESM build, `vitest` test script.
- `src/config.ts`, `src/errors.ts` — env config loader (`OVERLEAF_URL`, `OVERLEAF_EMAIL`, `OVERLEAF_PASSWORD`/`OVERLEAF_PASSWORD_FILE`, `OVERLEAF_DEFAULT_PROJECT`), `maskSecrets()`, typed errors.
- `src/overleaf/http-client.ts` — cookie jar, CSRF extraction, `/login`, `/user/projects`, `/project/:id/folder`, `/project/:id/doc`, `/project/:id/compile`, log fetch, single-retry re-auth.
- `src/overleaf/socket09-client.ts` — Socket.IO 0.9 wire codec + WebSocket client (`joinProject`, `joinDoc`, `applyOtUpdate`, `2::` / `serverPing` heartbeats, UTF-8 decoding).
- `src/overleaf/ot-diff.ts` — minimal UTF-16 OT diff generator (`{ p, d }`, `{ p, i }`).
- `src/latex/sections.ts` — brace-balanced section parser, section extractor, and heading-inclusive replacer.
- `src/overleaf/tree.ts` — `rootFolder` tree flattener, POSIX path normalizer, traversal guard.
- `src/overleaf/service.ts` — serialized queue, project resolution, stale-read version cache, all 10 tool operations.
- `src/server.ts`, `src/index.ts`, `README.md` — MCP stdio server, `zod` input validation, bin entrypoint, `agy` & OpenCode config docs.

---

### Task 1: Project Setup, Config Loader, and Secret Masking

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/errors.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `OverleafConfig`: `{ url: string; email: string; password: string; defaultProject?: string }`
  - `loadConfig(env?: NodeJS.ProcessEnv): Promise<OverleafConfig>`
  - `maskSecrets(text: string, secrets: string[]): string`
  - `OverleafMcpError extends Error` (`code: string`)

- [ ] **Step 1: Initialize `package.json`, `tsconfig.json`, `.gitignore`, and install dependencies**

Configure `package.json` (`"type": "module"`, `"bin": { "overleaf-ce-mcp": "./dist/index.js" }`, `"scripts": { "build": "tsc", "test": "vitest run", "start": "node dist/index.js" }`, `"engines": { "node": ">=20.0.0" }`), install `@modelcontextprotocol/sdk`, `ws`, `zod` and devDeps `typescript`, `@types/node`, `@types/ws`, `vitest`. Configure `tsconfig.json` targeting `ES2022` / `NodeNext` with `rootDir: "src"`, `outDir: "dist"`, `strict: true`.

- [ ] **Step 2: Write the failing tests in `tests/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { maskSecrets } from '../src/errors.js';

describe('loadConfig', () => {
  it('defaults OVERLEAF_URL to http://localhost:12980 and trims trailing slash', async () => {
    const cfg = await loadConfig({
      OVERLEAF_EMAIL: 'user@example.com',
      OVERLEAF_PASSWORD: 'secret-pass',
    });
    expect(cfg).toEqual({
      url: 'http://localhost:12980',
      email: 'user@example.com',
      password: 'secret-pass',
      defaultProject: undefined,
    });
  });

  it('reads password from OVERLEAF_PASSWORD_FILE and trims whitespace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ol-cfg-'));
    const pwFile = path.join(dir, 'pw.txt');
    await writeFile(pwFile, 'file-secret\n', 'utf8');
    const cfg = await loadConfig({
      OVERLEAF_URL: 'http://127.0.0.1:12980/',
      OVERLEAF_EMAIL: 'u@example.com',
      OVERLEAF_PASSWORD_FILE: pwFile,
      OVERLEAF_DEFAULT_PROJECT: 'My Paper',
    });
    expect(cfg.url).toBe('http://127.0.0.1:12980');
    expect(cfg.password).toBe('file-secret');
    expect(cfg.defaultProject).toBe('My Paper');
  });

  it('throws clear error when email or password is missing', async () => {
    await expect(loadConfig({})).rejects.toThrow(/OVERLEAF_EMAIL/);
    await expect(loadConfig({ OVERLEAF_EMAIL: 'u@example.com' })).rejects.toThrow(/OVERLEAF_PASSWORD/);
  });
});

describe('maskSecrets', () => {
  it('redacts secret strings and overleaf.sid cookie values', () => {
    const out = maskSecrets(
      'Auth failed for pw=supersecret overleaf.sid=s%3Aabc.xyz; csrf=tok123',
      ['supersecret', 'tok123']
    );
    expect(out).not.toContain('supersecret');
    expect(out).not.toContain('tok123');
    expect(out).not.toContain('s%3Aabc.xyz');
    expect(out).toContain('***');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (cannot find `../src/config.js` / `../src/errors.js`).

- [ ] **Step 4: Implement `src/errors.ts` and `src/config.ts`**

Implement `OverleafMcpError(message: string, code: string)` and `maskSecrets(text: string, secrets: string[]): string` (redacting each non-empty secret plus `overleaf\.sid=[^;\s]+` and `x-csrf-token:\s*\S+` case-insensitively). Implement `loadConfig(env = process.env)` validating `OVERLEAF_URL` (default `http://localhost:12980`, strip trailing slashes), `OVERLEAF_EMAIL`, and `OVERLEAF_PASSWORD` or `OVERLEAF_PASSWORD_FILE`.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS
Commit: `git add package.json package-lock.json tsconfig.json .gitignore src/errors.ts src/config.ts tests/config.test.ts && git commit -m "chore: scaffold project with config loader and secret masking"`

---

### Task 2: Overleaf HTTP Auth & Web Client

**Files:**
- Create: `src/overleaf/http-client.ts`
- Test: `tests/http-client.test.ts`

**Interfaces:**
- Consumes: `OverleafConfig`, `maskSecrets`, `OverleafMcpError`
- Produces:
  - `ProjectSummary`: `{ id: string; name: string; accessLevel: string }`
  - `CompileResult`: `{ status: string; outputFiles: Array<{ path: string; url: string; type: string; build?: string }>; logText?: string }`
  - `OverleafHttpClient`:
    - `constructor(config: OverleafConfig, fetchImpl?: typeof fetch)`
    - `ensureAuthenticated(): Promise<void>`
    - `getCookieHeader(): string`
    - `listProjects(): Promise<ProjectSummary[]>`
    - `createFolder(projectId: string, name: string, parentFolderId: string): Promise<{ _id: string; name: string }>`
    - `createDoc(projectId: string, name: string, parentFolderId: string): Promise<{ _id: string; name: string }>`
    - `compileProject(projectId: string, options?: { rootDocId?: string }): Promise<CompileResult>`

- [ ] **Step 1: Write the failing tests in `tests/http-client.test.ts`**

Mock `fetchImpl` (or spin up a local `node:http` test server) to test:
1. `login` flow: `GET /login` returns `Set-Cookie: overleaf.sid=sid1; Path=/; HttpOnly` and HTML `<input name="_csrf" type="hidden" value="csrf1">`; `POST /login` receives `_csrf=csrf1`, `email`, `password` and `Cookie: overleaf.sid=sid1`, sets `overleaf.sid=sid2`, and redirects `302` to `/project` (with `GET /project` returning `<meta name="ol-csrfToken" content="csrf2">` or updating CSRF).
2. `listProjects()`: calls `GET /user/projects`, maps `{ _id, name, accessLevel }` to `{ id, name, accessLevel }`.
3. **Review Focus — Expired session / CSRF recovery:** when `GET /user/projects` first returns `401` (or `302` Location `/login`), client clears session, performs `login()` once, retries, and returns projects; if login itself fails (`401`/`403`), throws `OverleafMcpError` with password and cookie masked.
4. `createFolder`, `createDoc`, and `compileProject`: send `x-csrf-token` header on POSTs; when `compileProject` returns `outputFiles` containing `{ type: 'log', url: '/project/p1/build/b1/output/output.log', path: 'output.log' }`, client fetches that log URL and populates `logText`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/http-client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/overleaf/http-client.ts`**

Implement `OverleafHttpClient` using Node `fetch` with `redirect: 'manual'` during login and auth checks so redirects to `/login` are caught instead of returning login HTML as `200 OK`. Parse `set-cookie` headers via `headers.getSetCookie()` (Node 20+) into a cookie map, extract `_csrf` from `<input ... name="_csrf" ... value="...">` or `<meta name="ol-csrfToken" content="...">` (handling attribute order either way), deduplicate concurrent logins with an in-flight `loginPromise`, retry once on `401`/`403`/redirect-to-`/login`, and redact secrets with `maskSecrets`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/http-client.test.ts`
Expected: PASS
Commit: `git add src/overleaf/http-client.ts tests/http-client.test.ts && git commit -m "feat: add Overleaf HTTP client with CSRF and session recovery"`

---

### Task 3: Socket.IO v0.9 Real-Time Client

**Files:**
- Create: `src/overleaf/socket09-client.ts`
- Test: `tests/socket09-client.test.ts`

**Interfaces:**
- Consumes: `OverleafConfig`, `OverleafHttpClient` (`ensureAuthenticated()`, `getCookieHeader()`)
- Produces:
  - `decodeSocket09Packet(raw: string): Socket09Packet`
  - `encodeSocket09Event(name: string, args: unknown[], id?: number): string`
  - `JoinedDoc`: `{ content: string; version: number; docType: string }`
  - `OverleafProjectConnection` / `OverleafRealtimeClient`:
    - `constructor(config: OverleafConfig, httpClient: OverleafHttpClient, options?: { WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch })`
    - `joinProject(projectId: string): Promise<OverleafProjectPayload>` (opens/reuses project-scoped Socket.IO 0.9 connection with `?projectId=<projectId>` and resolves from `joinProjectResponse`)
    - `joinDoc(projectId: string, docId: string): Promise<JoinedDoc>`
    - `applyOtUpdate(projectId: string, docId: string, update: { v: number; op: OtOp[] }): Promise<void>`
    - `close(projectId?: string): void`

- [ ] **Step 1: Write the failing tests in `tests/socket09-client.test.ts`**

Test against an in-process `http` + `ws` `WebSocketServer` emulating Overleaf's Socket.IO 0.9 wire protocol:
1. Handshake `GET /socket.io/1/?projectId=p1&t=...` sends `Cookie` header and receives `sid123:60:60:websocket,xhr-polling`, then connects WebSocket to `/socket.io/1/websocket/sid123?projectId=p1` with `Cookie`; server pushes `1::` followed by `5:::{"name":"joinProjectResponse","args":[{"publicId":"P.1","project":{...},"permissionsLevel":"owner","protocolVersion":2}]}` and `joinProject('p1')` resolves `project`.
2. Replies to `2::` with `2::`, and rejects cleanly if server emits `connectionRejected`.
3. **Review Focus — Thai / non-ASCII UTF-8 round-trip:** `joinDoc('p1', 'd1')` sends `5:1+::{"name":"joinDoc","args":["d1",-1,{"encodeRanges":false}]}`; server replies with `6:::1+[null,["\\section{บทนำ}","สวัสดีครับ"],7,[],{},"standard",{"canSkipLeaveDoc":true}]` encoded via `unescape(encodeURIComponent(s))` — verify `JoinedDoc.content` decodes cleanly to `"\\section{บทนำ}\nสวัสดีครับ"` and `version === 7`. Also test `docType === 'history-ot'` does NOT double-decode UTF-8.
4. `applyOtUpdate('p1', 'd1', { v: 7, op })` sends `5:2+::{"name":"applyOtUpdate","args":["d1",{"doc":"d1","v":7,"op":[...]}]}` and rejects with `OverleafMcpError` when ack returns `[err]` or `otUpdateError` fires.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/socket09-client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/overleaf/socket09-client.ts`**

Implement `Socket09Codec` (`0::`, `1::`, `2::`, `5:id+::json`, `6:::id+json`) and `OverleafRealtimeClient` maintaining per-`projectId` WebSocket connections (because Overleaf's `real-time` `Router.js` requires `?projectId=<objectId>` on the handshake query string and auto-emits `joinProjectResponse` on connect). Handle `2::` heartbeats, per-ack promise timeout (15s), automatic reconnect if socket drops between calls, `connectionRejected` / `reconnectGracefully`, and `decodeURIComponent(escape(line))` decoding for non-`history-ot` `joinDoc` payloads.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/socket09-client.test.ts`
Expected: PASS
Commit: `git add src/overleaf/socket09-client.ts tests/socket09-client.test.ts && git commit -m "feat: add Socket.IO 0.9 real-time client for Overleaf CE"`

---

### Task 4: OT Diffing Engine

**Files:**
- Create: `src/overleaf/ot-diff.ts`
- Test: `tests/ot-diff.test.ts`

**Interfaces:**
- Produces:
  - `OtOp`: `{ p: number; d: string } | { p: number; i: string }`
  - `computeOtOps(fromText: string, toText: string): OtOp[]`
  - `applyOtOpsLocally(text: string, ops: OtOp[]): string`

- [ ] **Step 1: Write the failing tests in `tests/ot-diff.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeOtOps, applyOtOpsLocally } from '../src/overleaf/ot-diff.js';

describe('computeOtOps', () => {
  it('returns empty array when texts are identical', () => {
    expect(computeOtOps('hello', 'hello')).toEqual([]);
  });

  it('computes minimal delete+insert ops around common prefix and suffix', () => {
    const from = '\\section{Intro}\nOld sentence.\n\\end{document}';
    const to = '\\section{Intro}\nNew improved sentence.\n\\end{document}';
    const ops = computeOtOps(from, to);
    expect(applyOtOpsLocally(from, ops)).toBe(to);
    expect(ops.length).toBeLessThanOrEqual(2);
  });

  it('preserves UTF-16 code-unit offsets for Thai text and emoji', () => {
    const from = 'หัวข้อ: ทดสอบ 🚀 จบ';
    const to = 'หัวข้อ: แก้ไข 🚀 จบ';
    const ops = computeOtOps(from, to);
    expect(applyOtOpsLocally(from, ops)).toBe(to);
  });

  it('handles empty-to-nonempty and nonempty-to-empty', () => {
    expect(applyOtOpsLocally('', computeOtOps('', 'abc'))).toBe('abc');
    expect(applyOtOpsLocally('abc', computeOtOps('abc', ''))).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ot-diff.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/overleaf/ot-diff.ts`**

Compute common UTF-16 prefix `prefixLen` and non-overlapping common suffix `suffixLen`. Emit `{ p: prefixLen, d: fromMid }` if `fromMid.length > 0`, followed by `{ p: prefixLen, i: toMid }` if `toMid.length > 0` (note: in Overleaf ShareJS sequential `op` arrays, `{ p, i }` runs after `{ p, d }` at the same offset `prefixLen`). Implement `applyOtOpsLocally` for test verification.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/ot-diff.test.ts`
Expected: PASS
Commit: `git add src/overleaf/ot-diff.ts tests/ot-diff.test.ts && git commit -m "feat: add UTF-16 OT diff generator"`

---

### Task 5: LaTeX Brace-Balanced Section Parser & Replacer

**Files:**
- Create: `src/latex/sections.ts`
- Test: `tests/sections.test.ts`

**Interfaces:**
- Produces:
  - `LatexSection`: `{ type: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection'; title: string; index: number }`
  - `parseSections(content: string): LatexSection[]`
  - `extractSectionContent(content: string, sectionTitle: string, sectionIndex?: number): string`
  - `replaceSectionContent(content: string, sectionTitle: string, newContent: string, sectionIndex?: number): string`

- [ ] **Step 1: Write the failing tests in `tests/sections.test.ts`**

Test:
1. **Review Focus — Nested braces & short titles:** `\\section[Short]{Use of \\emph{X} and $a^{2}$}` parses `title === 'Use of \\emph{X} and $a^{2}$'`, plus starred `\\section*{Acknowledgments}`.
2. **Heading-inclusive round-trip:** `extractSectionContent(doc, 'Intro')` returns from `\\section{Intro}` through just before the next equal/higher heading (or `\\end{document}` / EOF), including nested subsections; `replaceSectionContent(doc, 'Intro', updated)` replaces that exact span so `extractSectionContent(replaceSectionContent(...), 'Intro')` round-trips cleanly.
3. **Review Focus — Ambiguous duplicate titles:** When `\\subsection{Evaluation}` appears under two sections, omitting `sectionIndex` throws `OverleafMcpError` listing both `index` values; passing `sectionIndex` targets the exact occurrence.
4. Unknown `sectionTitle` or invalid `sectionIndex` throws `OverleafMcpError`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sections.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/latex/sections.ts`**

Implement brace-balanced scanner for `\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection` (with optional `*` and optional `[short]`), tracking `index` (UTF-16 offset of `\`) and heading hierarchy levels (`part: -1`, `chapter: 0`, `section: 1`, `subsection: 2`, `subsubsection: 3`) to find section end bounds (`next` with `level <= targetLevel`, or `lastIndexOf('\\end{document}')`, or `content.length`). Match `title.trim() === sectionTitle.trim()`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/sections.test.ts`
Expected: PASS
Commit: `git add src/latex/sections.ts tests/sections.test.ts && git commit -m "feat: add brace-balanced LaTeX section parser and replacer"`

---

### Task 6: Project Tree Resolver & Document Service

**Files:**
- Create: `src/overleaf/tree.ts`, `src/overleaf/service.ts`
- Test: `tests/service.test.ts`

**Interfaces:**
- Consumes: `OverleafHttpClient`, `OverleafRealtimeClient`, `computeOtOps`, `parseSections`, `extractSectionContent`, `replaceSectionContent`
- Produces:
  - `ProjectEntity`: `{ id: string; path: string; type: 'doc' | 'file'; name: string; parentFolderId: string }`
  - `flattenProjectTree(rootFolder: OverleafFolderNode): { entities: ProjectEntity[]; foldersByPath: Map<string, string>; rootFolderId: string }`
  - `normalizeProjectPath(filePath: string): string`
  - `OverleafService`:
    - `listProjects(): Promise<ProjectSummary[]>`
    - `listFiles(input?: { project?: string; extension?: string }): Promise<{ projectId: string; projectName: string; rootDocPath?: string; files: ProjectEntity[] }>`
    - `statusSummary(input?: { project?: string }): Promise<{ projectId: string; projectName: string; totalFiles: number; mainFile?: string; sections: LatexSection[] }>`
    - `readFile(input: { filePath: string; project?: string }): Promise<{ filePath: string; content: string; version: number }>`
    - `getSections(input: { filePath: string; project?: string }): Promise<LatexSection[]>`
    - `getSectionContent(input: { filePath: string; sectionTitle: string; sectionIndex?: number; project?: string }): Promise<{ filePath: string; content: string; version: number }>`
    - `writeFile(input: { filePath: string; content: string; project?: string; expectedVersion?: number; force?: boolean }): Promise<{ filePath: string; fromVersion: number; toVersion: number }>`
    - `writeSection(input: { filePath: string; sectionTitle: string; newContent: string; sectionIndex?: number; project?: string; expectedVersion?: number; force?: boolean }): Promise<{ filePath: string; fromVersion: number; toVersion: number }>`
    - `createFile(input: { filePath: string; content?: string; project?: string }): Promise<{ filePath: string; docId: string; createdFolders: string[] }>`
    - `compileProject(input?: { project?: string; rootDocPath?: string }): Promise<{ status: string; errors: string[]; logExcerpt: string }>`

- [ ] **Step 1: Write the failing tests in `tests/service.test.ts`**

Test with mocked `httpClient` and `realtimeClient`:
1. Project resolution: resolves by `projectId`, by case-insensitive `name`, falls back to `defaultProject`, errors with available project names/IDs when omitted without default or ambiguous.
2. **Review Focus — Path traversal & binary file rejection:** `normalizeProjectPath('../etc/passwd')` and `/abs/path.tex` throw `OverleafMcpError`; `readFile({ filePath: 'fig.png' })` on a `file` entity throws a clear "binary file" error.
3. **Review Focus — Stale-read conflict guard:** `readFile` records `v = 5`; if next `joinDoc` before `writeFile` returns `v = 6` (concurrent browser edit), `writeFile` rejects with conflict error; with `force: true` or when `v === 5`, it submits `applyOtUpdate` and updates cached `v` to `6`. Also test `expectedVersion` override.
4. **Review Focus — Nested `create_file` folder reuse:** Creating `sections/ch1/intro.tex` when `sections/` already exists creates only `ch1` inside `sections._id`, then creates `intro.tex`, and writes `content` via `applyOtUpdate` if non-empty.
5. `compileProject`: resolves optional `rootDocPath` to `rootDocId`, calls `httpClient.compileProject`, extracts `! ...` LaTeX error lines and tail of `logText`.
6. Serialized queue: two concurrent `writeFile` calls on the same `(projectId, docId)` execute sequentially rather than racing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/overleaf/tree.ts` and `src/overleaf/service.ts`**

Implement `flattenProjectTree`, `normalizeProjectPath` (reject leading `/`, empty segments, `.` or `..`), and `OverleafService` with per-`projectId:docId` promise-chain queue, `lastReadVersion` map, `rootDoc_id` detection (`statusSummary` / `compileProject`), and log diagnostic parser (extract lines matching `/^!/` with 3 context lines plus tail of `.log`).

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/service.test.ts`
Expected: PASS
Commit: `git add src/overleaf/tree.ts src/overleaf/service.ts tests/service.test.ts && git commit -m "feat: add Overleaf project tree resolver and document service"`

---

### Task 7: MCP Stdio Server, CLI Entrypoint, and Client Docs

**Files:**
- Create: `src/server.ts`, `src/index.ts`, `README.md`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `maskSecrets`, `OverleafHttpClient`, `OverleafRealtimeClient`, `OverleafService`
- Produces:
  - `createMcpServer(service: OverleafService, secretsToMask?: string[]): Server`
  - Compiled CLI binary `dist/index.js` (`#!/usr/bin/env node`)

- [ ] **Step 1: Write the failing tests in `tests/server.test.ts`**

Use `@modelcontextprotocol/sdk/inMemory.js` (`InMemoryTransport`) + `Client` (or call server handlers) to verify:
1. `listTools()` exposes all 10 tools (`list_projects`, `list_files`, `status_summary`, `read_file`, `get_sections`, `get_section_content`, `write_file`, `write_section`, `create_file`, `compile_project`) with expected schemas.
2. Calling `read_file`, `write_section`, `create_file`, `compile_project` delegates to `OverleafService` with validated `zod` args and returns JSON/text tool results.
3. Errors thrown by `OverleafService` return `{ isError: true, content: [{ type: 'text', text: ... }] }` with secrets masked.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server.ts`, `src/index.ts`, and `README.md`**

- `src/server.ts`: Register `ListToolsRequestSchema` and `CallToolRequestSchema` using `zod` validation for all 10 tools, documenting the heading-inclusive `write_section` contract and stale-read `force` flag in tool descriptions.
- `src/index.ts`: `#!/usr/bin/env node`, load config, wire `OverleafHttpClient` → `OverleafRealtimeClient` → `OverleafService` → `createMcpServer`, connect `StdioServerTransport`, log startup only to `console.error`, handle `SIGINT`/`SIGTERM` cleanly by closing WebSocket.
- `README.md`: Document setup, env vars (`OVERLEAF_URL`, `OVERLEAF_EMAIL`, `OVERLEAF_PASSWORD` / `OVERLEAF_PASSWORD_FILE`, `OVERLEAF_DEFAULT_PROJECT`), build steps, and exact MCP config snippets for **Antigravity (`agy`)** and **OpenCode**.

- [ ] **Step 4: Run full build, full unit test suite, and stdio smoke check**

Run:
- `npm run build` → Expected: exit 0, `dist/index.js` generated.
- `npm test` → Expected: all test files PASS.
- `OVERLEAF_EMAIL=test@example.com OVERLEAF_PASSWORD=dummy node -e '/* spawn dist/index.js and send MCP initialize + tools/list */'` → Expected: JSON-RPC `initialize` response and 10 tools listed on stdout, no stray non-JSON text on stdout.

- [ ] **Step 5: Commit**

Commit: `git add src/server.ts src/index.ts README.md tests/server.test.ts && git commit -m "feat: add MCP stdio server, CLI entrypoint, and client setup docs"`
