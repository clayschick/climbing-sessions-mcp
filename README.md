# climbing-sessions-mcp Server

An MCP (Model Context Protocol) server that connects Claude to a Turso SQLite database containing climbing session data. Claude can query sessions, projects, and attempts in real time during coaching conversations, and log new sessions conversationally through a structured debrief flow.

---

## What is an MCP Server?

MCP is a standard protocol that lets Claude talk to external tools in a structured way. An MCP server tells Claude two things: **what tools exist** and **how to call them**. Claude handles the rest — deciding when to use a tool, what arguments to pass, and how to interpret the result.

Think of it as an API with a built-in README that Claude can read. The Cloudflare Worker is already a great API. The MCP server is that README plus a thin execution layer.

Every MCP server defines three things:

```
1. Tools      — what Claude can do        ("get recent sessions", "get grade stats")
2. Schema     — what each tool needs      (parameters, types, descriptions)
3. Handler    — what happens when called  (HTTP request to the Worker)
```

When Claude sees a question like *"how have my sessions been this week?"*, it looks at the tool list, picks `get_recent_sessions`, calls the handler with `limit: 5`, gets back JSON, and uses it to answer.

---

## Architecture

```
Claude Desktop / Claude.ai
        │
        │  JSON-RPC 2.0
        ▼
  MCP Server (this repo)
        │
        │  HTTP + Bearer token
        ▼
  Cloudflare Worker (climbing-db)
        │
        │  @libsql/client
        ▼
  Turso SQLite (climbing-sessions)
```

A full tool call flows like this:

1. Claude reads the coaching prompt and decides session data is needed
2. Claude calls `get_recent_sessions({ limit: 10 })` on the MCP server
3. MCP server calls `GET /sessions/recent?limit=10` on the Cloudflare Worker
4. Worker queries Turso with a SQL JOIN across sessions, attempts, and projects
5. JSON flows back up the chain
6. Claude uses the data to give specific, grounded coaching advice

---

## Transports

The server supports two transports, auto-detected at startup based on whether stdin is a TTY.

### stdio (Claude Desktop)

Claude Desktop spawns the server as a child process. Messages arrive on `stdin` as newline-delimited JSON and responses are written to `stdout` the same way. `stderr` is used for logging — Claude ignores it.

```js
const IS_STDIO = !process.stdin.isTTY;
```

When you run `node mcp-server.js` in a terminal, stdin is a TTY (your keyboard) — SSE mode starts. When Claude Desktop spawns it, stdin is a pipe — stdio mode starts. Same file, same tools, same handler, different I/O layer.

**Why stderr for logging in stdio mode:**
In stdio mode, stdout is the communication channel with Claude — every byte written there is read as a JSON-RPC message. Log output must go to stderr instead.

```js
// stdio mode — logs go to stderr, not console.log
process.stderr.write(`Climbing Journal MCP server (stdio) -- ${TOOLS.length} tools\n`);
```

### SSE (remote / Claude.ai)

When running standalone, the server starts an HTTP server using Server-Sent Events transport:

1. Claude opens a persistent `GET /sse` connection
2. Server sends an `endpoint` event telling Claude where to POST messages
3. Claude POSTs JSON-RPC messages to `/message?sessionId=xxx`
4. Server processes the message and sends the response back over the open SSE connection

```js
// Send the endpoint event — tells Claude where to POST messages
res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
```

The session ID is a UUID generated per connection. It maps incoming POST messages to the correct SSE response object when multiple sessions are open simultaneously.

---

## The JSON-RPC Protocol

MCP uses [JSON-RPC 2.0](https://www.jsonrpc.org/specification). Every message has this shape:

```js
// Claude → MCP server
{
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "get_recent_sessions",
    arguments: { limit: 5 }
  }
}

// MCP server → Claude
{
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [{ type: "text", text: "..." }]
  }
}
```

This server handles four methods:

| Method | What it does |
|---|---|
| `initialize` | Claude connects — server declares its name and capabilities |
| `tools/list` | Claude asks what tools exist — server returns tool definitions |
| `tools/call` | Claude calls a tool — server executes and returns results |
| `ping` | Keepalive check |

---

## Tool Definitions

Tool definitions are the heart of the MCP server. Each tool has three parts:

- **`name`** — snake_case identifier Claude uses internally
- **`description`** — plain English explaining what the tool does and *when Claude should use it*. This is the most important field — Claude reads it to decide which tool to pick.
- **`inputSchema`** — JSON Schema describing parameters, types, and valid enum values

```js
{
  name: "get_recent_sessions",
  description: `Returns the athlete's most recent climbing sessions including
    date, location type, objective, Oura readiness score, physical flags,
    effort rating, focus quality, volume by grade, key takeaway, and next
    session focus notes. Call this at the start of any coaching conversation,
    before giving session-specific advice, when asked about recent training,
    or when looking for patterns across sessions.`,
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of sessions to return. Defaults to 10, max 20.",
      },
    },
    required: [],
  },
}
```

Notice the description says *"call this at the start of any coaching conversation"* — that language maps directly to the coaching rules in the system prompt. The MCP server and the coaching prompt are designed to reinforce each other.

### Enum constraints on write tools

Select fields on write tools use JSON Schema `enum` to constrain valid values. This ensures Claude only offers valid options during the session debrief and prevents bad data from reaching the database.

```js
{
  name: "create_session",
  inputSchema: {
    properties: {
      location_type: {
        type: "string",
        enum: ["Indoor", "Outdoor"],
        description: "Indoor or Outdoor"
      },
      objective: {
        type: "string",
        enum: ["Technique", "Power", "Power Endurance", "Endurance",
               "Project", "Flash", "Social", "Assessment"],
        description: "Why the athlete climbed today"
      },
      effort: {
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        description: "Effort rating 1-10"
      },
      // ...
    }
  }
}
```

---

## Tools Reference

### Read tools

| Tool | Worker endpoint | Description |
|---|---|---|
| `get_recent_sessions` | `GET /sessions/recent` | Last N sessions with key coaching signals |
| `get_session_detail` | `GET /sessions/:id` | Full session + all linked attempts and projects |
| `get_flagged_sessions` | `GET /sessions/flagged` | Sessions with physical flags logged |
| `get_low_readiness_sessions` | `GET /sessions/low-readiness` | Sessions below Oura readiness threshold |
| `get_grade_stats` | `GET /stats/grades` | Grade distribution with send rate |
| `get_hold_type_stats` | `GET /stats/hold-types` | Hold type frequency with send rate |
| `get_wall_angle_stats` | `GET /stats/wall-angles` | Wall angle frequency |
| `get_load_trend` | `GET /stats/load-trend` | Effort/focus/readiness trend for overtraining detection |
| `get_project_attempts` | `GET /projects/:id/attempts` | All attempts on a specific project |
| `get_projects` | `GET /projects` | All projects with attempt counts |

### Write tools

Used during post-session logging. Claude collects data conversationally, presents a full summary for confirmation, then inserts in order.

| Tool | Worker endpoint | Insert order |
|---|---|---|
| `create_project` | `POST /projects` | 1st — must exist before attempts |
| `create_session` | `POST /sessions` | 2nd — must exist before attempts |
| `create_attempt` | `POST /attempts` | 3rd — links session + project |

Write tools return `{ id }` of the newly inserted record, which is used as the foreign key in subsequent inserts.

---

## How Write Tools Work

Read tools pass a path string to `buildWorkerRequest`. Write tools pass a `[method, path, body]` tuple:

```js
function buildWorkerRequest(toolName, args) {
  switch (toolName) {
    // Read tool — returns a path string
    case "get_recent_sessions":
      return `/sessions/recent?limit=${a.limit ?? 10}`;

    // Write tool — returns [method, path, body]
    case "create_session":
      return ["POST", `/sessions`, args];
  }
}
```

`callWorker` handles both formats:

```js
async function callWorker(pathOrTuple) {
  const [method, path, body] = Array.isArray(pathOrTuple)
    ? pathOrTuple
    : ["GET", pathOrTuple, undefined];

  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${WORKER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return res.json();
}
```

---

## Setup

### Prerequisites

- Node.js 18+
- A running [Cloudflare Worker](../worker/) with the climbing-journal API
- A Turso database with the climbing-sessions schema

### Install

```bash
npm install
```

### Environment variables

| Variable | Description |
|---|---|
| `WORKER_URL` | Your Cloudflare Worker URL, e.g. `https://climbing-db.your-subdomain.workers.dev` |
| `WORKER_TOKEN` | The `API_SECRET` you set on the Worker |
| `PORT` | Port for SSE mode (default: `3000`) |

### Run locally (SSE mode)

```bash
WORKER_URL=https://climbing-db.your-subdomain.workers.dev \
WORKER_TOKEN=your_api_secret \
node mcp-server.js
```

Verify it's running:

```bash
curl http://localhost:3000/health
# → { "status": "ok", "tools": 13 }
```

---

## Connecting to Claude Desktop (stdio mode)

Claude Desktop spawns the server as a child process using the `command` + `args` config format. Find or create your config file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "climbing-journal": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/mcp-server.js"],
      "env": {
        "WORKER_URL": "https://climbing-db.your-subdomain.workers.dev",
        "WORKER_TOKEN": "your_api_secret"
      }
    }
  }
}
```

Two things to get right:

- **Use the absolute path** to `mcp-server.js` — `~/` won't work
- **Use the full path to node** — Claude Desktop runs in a limited environment that may not have your shell's PATH. Find it with `which node`

Fully quit and relaunch Claude Desktop after saving (`Cmd+Q` on Mac — a regular window close doesn't restart the process). The server appears as a connected connector in the app. The hammer icon appears in the chat input bar once a conversation is open.

---

## Connecting to Claude.ai (SSE mode)

Claude.ai Projects support remote MCP servers over HTTPS. Deploy the server (see Deployment below), then add the SSE URL to your Project's MCP settings:

```
https://your-deployed-host.com/sse
```

---

## Deployment

The server needs to run as a **persistent process** — serverless platforms won't work because Claude holds the SSE connection open for the duration of a conversation.

### Fly.io (recommended)

Best balance of simplicity, free tier, and warm uptime.

```bash
# Install flyctl
brew install flyctl

# Authenticate
flyctl auth login

# Deploy from the repo directory
flyctl launch
flyctl secrets set WORKER_URL=https://climbing-db.your-subdomain.workers.dev
flyctl secrets set WORKER_TOKEN=your_api_secret
flyctl deploy
```

### Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway variables set WORKER_URL=https://climbing-db.your-subdomain.workers.dev
railway variables set WORKER_TOKEN=your_api_secret
railway up
```

### Render

Similar to Railway. Note that Render's free tier spins down after inactivity, which causes a cold start delay on first connection. Upgrade to a paid instance type to keep it warm.

### DigitalOcean / VPS

For full control. Run with [PM2](https://pm2.keymetrics.io/) to keep the process alive:

```bash
npm install -g pm2
WORKER_URL=... WORKER_TOKEN=... pm2 start mcp-server.js --name climbing-journal
pm2 save
pm2 startup
```

---

## Session Logging Flow

When you tell the coach you just finished a session, it shifts into logging mode and collects data conversationally — one topic at a time. The flow:

1. Date, location, conditions
2. Objective and plan
3. Pre-session state: Oura readiness, confidence, physical flags
4. Warmup quality
5. Problems attempted: grade, wall type, angle, hold types, results, RPE, beta
6. Duration and volume by grade
7. Effort and focus quality
8. Mental notes, session notes, key takeaway, next session focus

Before writing anything, Claude presents a full summary and waits for confirmation. Insert order after confirmation:

```
create_project  (for each new problem — collect returned id)
      ↓
create_session  (collect returned id)
      ↓
create_attempt  (one per attempt, using session_id and project_id)
```

After all inserts succeed, the coach offers one coaching observation based on what was just logged.

---

## Related

- [`worker.js`](https://github.com/clayschick/climbing-sessions-api/blob/51149e0c8e587827d61203a572ef5834ca6ffe43/src/index.js) — Cloudflare Worker API layer
- [`schema.sql`](../db/) — Turso database schema
- [`migrate.js`](../db/) — Airtable → Turso migration script
- [`climbing_coach_prompt.docx`](../prompt/) — Claude coaching system prompt