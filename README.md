# Overleaf Community Edition MCP Server

A local stdio Model Context Protocol (MCP) server for **self-hosted Overleaf Community Edition** (for example via Podman/Docker Compose at `http://localhost:12980`). It connects directly over Overleaf's HTTP web routes and Socket.IO v0.9 real-time OT protocol—requiring **no Git Bridge** and **no changes** to your Overleaf containers.

## Features

- **Project & file discovery:** `list_projects`, `list_files`, `status_summary`
- **Reading & LaTeX structure:** `read_file`, `get_sections`, `get_section_content` (brace-balanced heading parser, UTF-8/Thai safe)
- **Live OT editing & file creation:** `write_file`, `write_section` (with stale-read conflict protection), `create_file`
- **Remote compile check:** `compile_project` (returns status plus `.log` error diagnostics)

## Build

```bash
npm install
npm run build
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `OVERLEAF_URL` | No | `http://localhost:12980` | Base URL of your Overleaf CE instance |
| `OVERLEAF_EMAIL` | Yes | — | Login email for your Overleaf CE account |
| `OVERLEAF_PASSWORD` | Yes* | — | Login password (*or use `OVERLEAF_PASSWORD_FILE`) |
| `OVERLEAF_PASSWORD_FILE` | Yes* | — | Path to a file containing your password (recommended) |
| `OVERLEAF_DEFAULT_PROJECT` | No | — | Default project ID or exact name when `project` is omitted |

## Client Setup

### Antigravity (`agy`)

Add to your Antigravity MCP config (`~/.gemini/antigravity/mcp_config.json` or workspace MCP settings):

```json
{
  "mcpServers": {
    "overleaf-ce": {
      "command": "node",
      "args": ["/home/cusniwtt/Documents/overleaf-mcp/dist/index.js"],
      "env": {
        "OVERLEAF_URL": "http://localhost:12980",
        "OVERLEAF_EMAIL": "you@example.com",
        "OVERLEAF_PASSWORD_FILE": "/home/cusniwtt/.config/overleaf-mcp/password.txt"
      }
    }
  }
}
```

### OpenCode

Add to your OpenCode config (`~/.config/opencode/opencode.json` or project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "overleaf-ce": {
      "type": "local",
      "command": ["node", "/home/cusniwtt/Documents/overleaf-mcp/dist/index.js"],
      "environment": {
        "OVERLEAF_URL": "http://localhost:12980",
        "OVERLEAF_EMAIL": "you@example.com",
        "OVERLEAF_PASSWORD_FILE": "/home/cusniwtt/.config/overleaf-mcp/password.txt"
      }
    }
  }
}
```

*(You can replace `OVERLEAF_PASSWORD_FILE` with `OVERLEAF_PASSWORD` if you prefer inline env vars, and optionally add `OVERLEAF_DEFAULT_PROJECT`.)*

## Section Editing & Safety Notes

- `get_section_content` returns the full section including its `\section{...}` heading line; `write_section` expects `newContent` to include that heading line.
- When multiple headings share a title (e.g., `\subsection{Evaluation}`), pass `sectionIndex` from `get_sections`.
- Before writing, the server checks Overleaf's live document version `v` against your last read. If the document was edited in the browser in between, the write is rejected unless `force: true` is passed.

## Development

```bash
npm test
npm run build
```
