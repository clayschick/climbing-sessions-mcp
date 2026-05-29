/**
 * mcp-server.js
 * MCP server -- Climbing Journal
 *
 * Wraps the Cloudflare Worker API as Claude-callable tools.
 * Supports two transports -- auto-detected at startup:
 *
 *   stdio  -- Claude Desktop spawns this process and talks via stdin/stdout.
 *             Used when stdin is not a TTY (Claude is piping to it).
 *             Configure in claude_desktop_config.json using "command" + "args".
 *
 *   SSE    -- Runs as an HTTP server with a persistent SSE connection.
 *             Used when running standalone (node mcp-server.js in a terminal).
 *             Connect via URL in Claude Projects or remote deployments.
 *
 * Required environment variables:
 *   WORKER_URL    https://climbing-db.your-subdomain.workers.dev
 *   WORKER_TOKEN  the API_SECRET you set on the Worker
 *   PORT          port to listen on for SSE mode (default: 3000)
 *
 * Claude Desktop config (stdio mode):
 *   {
 *     "mcpServers": {
 *       "climbing-journal": {
 *         "command": "/usr/local/bin/node",
 *         "args": ["/absolute/path/to/mcp-server.js"],
 *         "env": {
 *           "WORKER_URL": "https://climbing-db.your-subdomain.workers.dev",
 *           "WORKER_TOKEN": "your_api_secret"
 *         }
 *       }
 *     }
 *   }
 */

import http from "http";

const WORKER_URL   = process.env.WORKER_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const PORT         = parseInt(process.env.PORT ?? "3000");

if (!WORKER_URL || !WORKER_TOKEN) {
  console.error("Missing WORKER_URL or WORKER_TOKEN environment variables.");
  process.exit(1);
}

// ── Tool definitions ──────────────────────────────────────────────────────────
//
// These are what Claude reads to understand what tools exist and when to use
// them. The description is the most important field — it drives tool selection.
// Write descriptions from the coach's perspective: when should this be called?

const TOOLS = [
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
  },

  {
    name: "get_session_detail",
    description: `Returns full detail for a single session including all linked
      attempts with their results, RPE, and microbeta notes, plus the associated
      project details (grade, wall type, wall angle, hold types, description,
      beta). Use when the athlete asks about a specific session, when reviewing
      what was attempted on a particular day, or when diagnosing performance on
      a specific problem.`,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The session ID (integer). Get this from get_recent_sessions.",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "get_flagged_sessions",
    description: `Returns sessions where physical flags were logged — finger
      soreness, pulley tweaks, joint pain, skin issues, etc. Call this whenever
      the athlete mentions pain, soreness, or injury, before recommending any
      high-intensity finger loading, or when assessing injury risk across recent
      training.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of flagged sessions to return. Defaults to 10.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_low_readiness_sessions",
    description: `Returns sessions where the athlete's Oura Ring readiness score
      was below a threshold. Use this when assessing recovery patterns, when the
      athlete asks whether they should train on a low-readiness day, or when
      looking for correlations between recovery and performance. Default threshold
      is 70 — below this, session intensity recommendations should be reduced.`,
    inputSchema: {
      type: "object",
      properties: {
        threshold: {
          type: "number",
          description: "Oura readiness score threshold. Returns sessions below this value. Defaults to 70.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_grade_stats",
    description: `Returns grade distribution across recent sessions: attempt
      counts and send rate per grade. Use this when assessing where the athlete
      is clustering their effort, when identifying whether they are spending
      enough time at a challenging grade, or when tracking grade progression
      over time. A narrow grade band is a flag worth naming.`,
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Lookback window in days. Defaults to 90.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_hold_type_stats",
    description: `Returns hold type frequency and send rate across recent
      attempts. Use this when identifying gaps in training — if a hold type
      like slopers or pinches hasn't appeared in weeks, that absence is as
      meaningful as presence. Especially relevant given this athlete's known
      weakness in open-hand grip and recruitment.`,
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Lookback window in days. Defaults to 60.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_wall_angle_stats",
    description: `Returns wall angle frequency and send rate across recent
      attempts (slab, vertical, overhang, cave, etc.). Use this when assessing
      whether the athlete is avoiding certain wall angles, when planning a
      training block, or when diagnosing movement weaknesses that correlate
      with specific angles.`,
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Lookback window in days. Defaults to 60.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_load_trend",
    description: `Returns effort rating, focus quality, and Oura readiness for
      recent sessions in reverse chronological order. Use this when assessing
      whether the athlete is trending toward overtraining or needs a deload,
      when effort and focus quality have been consistently high across multiple
      sessions, or when recovery scores are declining over time.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent sessions to include. Defaults to 8.",
        },
      },
      required: [],
    },
  },

  {
    name: "get_project_attempts",
    description: `Returns all attempts on a specific project across all sessions,
      including session context (date, readiness, effort), attempt results, RPE,
      microbeta notes, and the project details. Use this when the athlete asks
      about a specific problem they have been working on, when tracking progress
      on a project over time, or when analyzing why a specific problem is proving
      difficult.`,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The project ID (integer). Get this from get_projects.",
        },
      },
      required: ["id"],
    },
  },

  {
    name: "get_projects",
    description: `Returns all logged projects with attempt counts and send
      counts. Use this to identify which problems the athlete has been working
      on, to find a project ID for get_project_attempts, or when getting an
      overview of current and past projects.`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ── Write tools ─────────────────────────────────────────────────────────────
  // Used during post-session logging. Always confirm the full summary with
  // the athlete before calling any of these. Insert order: projects first
  // (to get project IDs), then session, then attempts.

  {
    name: "create_project",
    description: `Creates a new project (problem or route) in the database and
      returns its ID. Call this during session logging when the athlete mentions
      a problem that doesn't already exist in get_projects. Must be called before
      create_attempt since attempts require a project_id. Returns { id } of the
      newly created project.`,
    inputSchema: {
      type: "object",
      properties: {
        grade:       { type: "string", description: "Grade (e.g. V4, 5.11b)" },
        wall_type:   { type: "string", enum: ["Boulder", "Lead", "Top Rope", "System Board", "Spray Wall"], description: "Wall type" },
        wall_angle:  { type: "string", enum: ["Slab", "Face", "Slight Overhang", "Moderate Overhang", "Steep Overhang", "Roof"], description: "Wall angle(s), comma-separated (e.g. Overhang, Vertical)" },
        hold_types:  { type: "string", description: "Crux or Dominant hold types, comma-separated (e.g. Crimp, Sloper)" },
        features:    { type: "string", description: "Additional features, comma-separated" },
        description: { type: "string", description: "Problem description from start to finish, identify the crux" },
        beta:        { type: "string", description: "Key moves, what worked, what didn't" },
      },
      required: [],
    },
  },

  {
    name: "create_session",
    description: `Creates a new session record in the database and returns its
      ID. Call this once per session during post-session logging, after
      confirming the full session summary with the athlete. Must be called
      before create_attempt since attempts require a session_id. Returns { id }
      of the newly created session.`,
    inputSchema: {
      type: "object",
      properties: {
        date:               { type: "string", description: "Session date in YYYY-MM-DD format" },
        location_type:      { type: "string", enum: ["Indoor", "Outdoor"], description: "Indoor or Outdoor" },
        conditions:         { type: "string", description: "Temp, humidity, rock type, etc." },
        objective:          { type: "string", enum: ["Technique", "Power", "Power Endurance", "Endurance", "Projecting", "Social", "Assessment"], description: "Why the athlete climbed today" },
        plan:               { type: "string", description: "What the athlete intended to work on" },
        process_goals:      { type: "string", description: "Specific, observable, within-control goals regardless of send" },
        confidence:         { type: "string", enum: ["Uncertain", "Tenative", "Assured", "Confident", "Commanding"], description: "Pre-session confidence level" },
        oura_readiness:     { type: "number", description: "Oura Ring readiness score (0-100)" },
        physical_flags:     { type: "string", description: "Any soreness, tweaks, or physical concerns including skin condition" },
        warmup_score:       { type: "string", enum: ["Cold", "Warm", "Warm and Loose", "Fully Primed"], description: "Quality of warmup" },
        duration_seconds:   { type: "number", description: "Session duration in seconds" },
        volume:             { type: "string", description: "Attempts per grade, one per line (e.g. V4 - 6)" },
        effort:             { type: "string", enum: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], description: "Effort rating 1-10" },
        focus_quality:      { type: "string", enum: ["Checked Out", "In My Head", "Distrcted", "Focused", "In The Flow"], description: "Focus quality rating" },
        mental_notes:       { type: "string", description: "Headspace, breakthroughs, blockers" },
        session_notes:      { type: "string", description: "Did goals get met? What felt good/off?" },
        key_takeaway:       { type: "string", description: "The one thing to remember from this session" },
        next_session_focus: { type: "string", description: "What to focus on next session" },
      },
      required: ["date"],
    },
  },

  {
    name: "create_attempt",
    description: `Creates a single attempt record linking a session to a project.
      Call once per attempt during post-session logging, after create_session and
      create_project have returned their IDs. Call this multiple times if the
      athlete made multiple attempts on different problems. Returns { id } of
      the newly created attempt.`,
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "ID returned by create_session" },
        project_id: { type: "number", description: "ID returned by create_project or from get_projects" },
        datetime:   { type: "string", description: "ISO 8601 datetime of the attempt (optional)" },
        result:     { type: "string", enum: ["Send", "Flash", "Fall", "High Point"], description: "Outcome of the attempt" },
        rpe:        { type: "number", description: "Rate of Perceived Exertion (0-10)" },
        microbeta:  { type: "string", description: "What specifically happened on this attempt" },
      },
      required: ["session_id", "project_id"],
    },
  },
];

// ── Tool → Worker endpoint mapping ────────────────────────────────────────────
//
// Each tool name maps to a function that builds the Worker URL path and query
// string from the tool's input arguments.

function buildWorkerRequest(toolName, args) {
  const a = args ?? {};

  switch (toolName) {
    case "get_recent_sessions":
      return `/sessions/recent?limit=${a.limit ?? 10}`;

    case "get_session_detail":
      return `/sessions/${a.id}`;

    case "get_flagged_sessions":
      return `/sessions/flagged?limit=${a.limit ?? 10}`;

    case "get_low_readiness_sessions":
      return `/sessions/low-readiness?threshold=${a.threshold ?? 70}`;

    case "get_grade_stats":
      return `/stats/grades?days=${a.days ?? 90}`;

    case "get_hold_type_stats":
      return `/stats/hold-types?days=${a.days ?? 60}`;

    case "get_wall_angle_stats":
      return `/stats/wall-angles?days=${a.days ?? 60}`;

    case "get_load_trend":
      return `/stats/load-trend?limit=${a.limit ?? 8}`;

    case "get_project_attempts":
      return `/projects/${a.id}/attempts`;

    case "get_projects":
      return `/projects`;

    // Write tools — return [method, path, body] instead of just path
    case "create_session":
      return ["POST", `/sessions`, args];

    case "create_project":
      return ["POST", `/projects`, args];

    case "create_attempt":
      return ["POST", `/attempts`, args];

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── Worker fetch ──────────────────────────────────────────────────────────────

async function callWorker(pathOrTuple) {
  // Read tools pass a path string; write tools pass [method, path, body]
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worker error ${res.status}: ${text}`);
  }

  return res.json();
}

// ── JSON-RPC handler ──────────────────────────────────────────────────────────
//
// Handles the four MCP methods Claude will call:
//   initialize  — Claude connects, server declares capabilities
//   tools/list  — Claude asks what tools exist
//   tools/call  — Claude calls a specific tool
//   ping        — keepalive

async function handleRPC(message) {
  const { id, method, params } = message;

  // initialize — tell Claude who we are and what we support
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "climbing-journal", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    };
  }

  // ping — keepalive
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  // tools/list — return tool definitions
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  // tools/call — execute a tool
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      const path = buildWorkerRequest(name, args);
      const data = await callWorker(path);
      return {
        jsonrpc: "2.0", id,
        result: {
          content: [{
            type: "text",
            // Return as formatted JSON — Claude reads this as structured data
            text: JSON.stringify(data, null, 2),
          }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  // Unknown method
  return {
    jsonrpc: "2.0", id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// -- Transport -- auto-detected at startup ----------------------------------------
//
// stdio: Claude Desktop spawns this process. Messages arrive on stdin as
//        newline-delimited JSON, responses are written to stdout the same way.
//        stderr is safe to use for logging -- Claude ignores it.
//
// SSE:   Running standalone. Claude connects via GET /sse, then POSTs messages
//        to /message. Responses go back over the persistent SSE connection.

const IS_STDIO = !process.stdin.isTTY;

if (IS_STDIO) {
  // -- stdio transport ----------------------------------------------------------
  process.stderr.write(`Climbing Journal MCP server (stdio) -- ${TOOLS.length} tools\n`);

  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message  = JSON.parse(trimmed);
        const response = await handleRPC(message);
        // Write response as a single newline-terminated JSON line
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (err) {
        process.stderr.write(`Parse error: ${err.message}\n`);
      }
    }
  });

  process.stdin.on("end", () => process.exit(0));

} else {
  // -- SSE transport ------------------------------------------------------------
  //
  // 1. Claude opens GET /sse -- server sends an "endpoint" event with the
  //    POST URL for that session.
  // 2. Claude POSTs JSON-RPC messages to /message?sessionId=xxx.
  // 3. Server sends responses back over the open SSE connection.

  const clients = new Map(); // sessionId -> SSE response object

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // GET /sse -- open SSE connection
    if (req.method === "GET" && url.pathname === "/sse") {
      const sessionId = crypto.randomUUID();

      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
      clients.set(sessionId, res);
      console.log(`Claude connected -- session ${sessionId}`);

      req.on("close", () => {
        clients.delete(sessionId);
        console.log(`Claude disconnected -- session ${sessionId}`);
      });
      return;
    }

    // POST /message -- receive JSON-RPC from Claude
    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId");
      const sseRes    = clients.get(sessionId);

      if (!sseRes) {
        res.writeHead(400);
        res.end("Unknown session");
        return;
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const message  = JSON.parse(body);
          const response = await handleRPC(message);
          sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          res.writeHead(202);
          res.end();
        } catch (err) {
          console.error("RPC error:", err.message);
          res.writeHead(500);
          res.end(err.message);
        }
      });
      return;
    }

    // GET /health -- health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tools: TOOLS.length }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`Climbing Journal MCP server (SSE) running on port ${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Tools: ${TOOLS.length}`);
  });
}
