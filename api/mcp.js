// api/mcp.js
//
// A minimal, stateless MCP (Model Context Protocol) server that exposes your
// Manatal integration to Claude as connector "tools".
//
// Transport: Streamable HTTP (JSON-RPC 2.0 over a single POST endpoint).
//   - No SSE, no session state -> fits Vercel serverless cleanly.
//   - It does NOT re-implement the Manatal calls. It forwards to your
//     /api/manatal function, so that file stays the single source of truth.
//
// Auth: a shared secret (env var MCP_SHARED_SECRET).
//   - The handshake (initialize/tools/list/ping) is OPEN so the connector can
//     connect. The key is required for tools/call (the actual data calls).
//   - Claude.ai custom connectors are URL-only, so pass the secret as a query
//     param:  https://<your-app>.vercel.app/api/mcp?key=THESECRET
//   - For testing you can also send it as "Authorization: Bearer THESECRET"
//     or the "x-mcp-key" header.
//   - If MCP_SHARED_SECRET is unset, everything runs OPEN.

const SECRET = process.env.MCP_SHARED_SECRET || null;
const PROTOCOL_FALLBACK = "2025-06-18";

const SERVER_INFO = { name: "manatal-mcp", version: "1.0.0" };

// ---- Tool definitions (JSON Schema input) ---------------------------------

const TOOLS = [
  {
    name: "search_candidates_by_skills",
    description:
      "Search Manatal for candidates matching a list of skills. Retrieves from the " +
      "resume summary and job title, then ranks by each candidate's structured skill " +
      "tags. Returns a compact list with name, email, current role, company, location, " +
      "skills, and which requested skills matched.",
    inputSchema: {
      type: "object",
      properties: {
        skills: {
          type: "array",
          items: { type: "string" },
          description: 'Skills to match, e.g. ["React", "TypeScript"].',
        },
        page: { type: "integer", description: "Page number (default 1)." },
        perPage: { type: "integer", description: "Results per page, max 100 (default 100)." },
      },
      required: ["skills"],
    },
  },
  {
    name: "match_candidates",
    description:
      "Run several skill-set searches at once, de-duplicate, rank by skill overlap, and " +
      "return up to maxTotal candidates. Use when you have multiple skill combinations to " +
      "cover for a role.",
    inputSchema: {
      type: "object",
      properties: {
        skillSets: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: 'Array of skill groups, e.g. [["React","Node"],["Python","Django"]].',
        },
        maxTotal: { type: "integer", description: "Max candidates to return (default 300)." },
      },
      required: ["skillSets"],
    },
  },
  {
    name: "match_applied_candidates",
    description:
      "Like match_candidates, but also checks each candidate's pipeline membership and only " +
      "returns those already in a job pipeline. Includes their current pipeline stage(s).",
    inputSchema: {
      type: "object",
      properties: {
        skillSets: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Array of skill groups.",
        },
        maxTotal: { type: "integer", description: "Max candidates to pull from skill search (default 200)." },
        checkLimit: { type: "integer", description: "How many top candidates to check for pipeline activity (default 60)." },
      },
      required: ["skillSets"],
    },
  },
  {
    name: "list_jobs",
    description: "List all active jobs/open roles in Manatal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "test_connection",
    description: "Verify the Manatal API token works. Returns success plus total candidate count.",
    inputSchema: { type: "object", properties: {} },
  },
];

// Map MCP tool name -> the action/params your /api/manatal expects.
function toManatalCall(name, args) {
  const a = args || {};
  switch (name) {
    case "search_candidates_by_skills":
      return { action: "searchBySkills", params: { skills: a.skills, page: a.page, perPage: a.perPage } };
    case "match_candidates":
      return { action: "matchCandidates", params: { skillSets: a.skillSets, maxTotal: a.maxTotal } };
    case "match_applied_candidates":
      return { action: "matchAppliedCandidates", params: { skillSets: a.skillSets, maxTotal: a.maxTotal, checkLimit: a.checkLimit } };
    case "list_jobs":
      return { action: "jobs", params: {} };
    case "test_connection":
      return { action: "test", params: {} };
    default:
      return null;
  }
}

// Trim heavy candidate objects (drop resume_text / description blobs) so tool
// responses stay a sane size for the model.
function compactCandidate(c) {
  if (!c || typeof c !== "object") return c;
  return {
    manatal_id: c.manatal_id,
    full_name: c.full_name,
    email: c.email,
    phone_number: c.phone_number,
    current_position: c.current_position,
    current_company: c.current_company,
    location: c.location,
    skills: (c.skills || []).slice(0, 30),
    matched_skills: c.matched_skills,
    match_score: c.match_score,
    education: c.education,
    experience_summary: c.experience_summary,
    ...(c._jobs ? { jobs: c._jobs } : {}),
  };
}

function compactResult(data) {
  if (data && Array.isArray(data.candidates)) {
    return { ...data, candidates: data.candidates.map(compactCandidate) };
  }
  return data;
}

// ---- Auth -----------------------------------------------------------------

function authorized(req) {
  if (!SECRET) return true; // open mode
  const auth = req.headers["authorization"];
  const bearer = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const headerKey = req.headers["x-mcp-key"] || null;
  const queryKey = (req.query && (req.query.key || req.query.token)) || null;
  return [bearer, headerKey, queryKey].includes(SECRET);
}

// ---- JSON-RPC helpers -----------------------------------------------------

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callManatal(req, name, args) {
  const base = `https://${req.headers.host}`;
  const payload = toManatalCall(name, args);
  if (!payload) return { isError: true, text: `Unknown tool: ${name}` };

  try {
    const r = await fetch(`${base}/api/manatal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // forward the secret in case you later lock down /api/manatal too
        ...(SECRET ? { "x-mcp-key": SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return { isError: true, text: `Manatal error (${r.status}): ${JSON.stringify(data)}` };
    return { isError: false, text: JSON.stringify(compactResult(data), null, 2) };
  } catch (e) {
    return { isError: true, text: `Request failed: ${e.message}` };
  }
}

// Handle one JSON-RPC message. Returns a response object, or null for notifications.
async function handleMessage(req, msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested =
        params && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : PROTOCOL_FALLBACK;
      return ok(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      // Auth is enforced HERE (on the actual data calls), not on the
      // handshake, so the connector can complete its initial connection.
      if (!authorized(req)) {
        return ok(id, {
          content: [
            {
              type: "text",
              text:
                "Unauthorized: the MCP key is missing or invalid. The connector URL must " +
                "end with ?key=YOUR_SECRET matching MCP_SHARED_SECRET in Vercel.",
            },
          ],
          isError: true,
        });
      }
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const result = await callManatal(req, name, args);
      return ok(id, {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      });
    }

    case "ping":
      return ok(id, {});

    default:
      // Notifications (e.g. notifications/initialized) get no response.
      if (isNotification) return null;
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ---- HTTP entry point -----------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-mcp-key, Mcp-Session-Id, Mcp-Protocol-Version"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  // NOTE: no auth gate here. The handshake (initialize/tools/list/ping) must
  // succeed unauthenticated so the connector can connect; the key is checked
  // inside tools/call instead.

  if (req.method === "GET") {
    return res.status(405).json(err(null, -32000, "Method Not Allowed: use POST for JSON-RPC"));
  }

  if (req.method !== "POST") {
    return res.status(405).json(err(null, -32000, "Method Not Allowed"));
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (!body) return res.status(400).json(err(null, -32700, "Parse error: empty or invalid JSON body"));

  try {
    if (Array.isArray(body)) {
      const responses = [];
      for (const msg of body) {
        const r = await handleMessage(req, msg);
        if (r) responses.push(r);
      }
      if (responses.length === 0) return res.status(202).end();
      return res.status(200).json(responses);
    }

    const response = await handleMessage(req, body);
    if (!response) return res.status(202).end(); // notification
    return res.status(200).json(response);
  } catch (e) {
    return res.status(500).json(err(body && body.id, -32603, `Internal error: ${e.message}`));
  }
}
