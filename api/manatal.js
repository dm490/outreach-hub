// api/manatal.js
//
// Data-source client for Manatal (https://api.manatal.com/open/v3).
// Mirrors the action interface of the MCP layer (api/mcp.js forwards to it).
//
// Auth: MANATAL_TOKEN env var.
//
// Skill-search note: Manatal's Open API has no server-side "skills" filter, and
// its candidate filters are substring ("contains") matches that return results
// ALPHABETICALLY. So we (a) retrieve using the fields Manatal CAN filter
// (description = parsed resume summary, current_position = job title), sampling
// pages across the whole result range to avoid an "A-names" bias, then
// (b) RANK the pool against each candidate's structured skills[] plus optional
// seniority / location / recency signals.

const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const MAN_BASE = "https://api.manatal.com/open/v3";

const FIELDS = ["description", "current_position"];

function strip(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function manGet(path) {
  const r = await fetch(MAN_BASE + path, {
    headers: { Authorization: "Token " + MANATAL_TOKEN, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    let body = "";
    try {
      body = await r.text();
    } catch (e) {}
    const err = new Error("Manatal " + r.status + ": " + body.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function skillNamesOf(c) {
  return Array.isArray(c.skills)
    ? c.skills.map((s) => (s && s.skill_name ? String(s.skill_name) : "")).filter(Boolean)
    : [];
}

// ---- Matching helpers -----------------------------------------------------

// Whole-token match that won't let "Java" match "JavaScript" or "React" match
// "React Native", while still allowing "C++", "C#", ".NET" as tokens.
function matchToken(text, termLower) {
  if (!text) return false;
  const esc = termLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^a-z0-9+#.])" + esc + "([^a-z0-9+#.]|$)", "i").test(text);
}

function textHaystack(c) {
  return ((c.current_position || "") + " " + (c.description || "")).toLowerCase();
}

// Returns "structured" (skill tag), "text" (resume/title mention), or null.
function skillHit(c, termLower) {
  const have = skillNamesOf(c).map((s) => s.toLowerCase());
  if (have.includes(termLower)) return "structured";
  if (have.some((h) => matchToken(h, termLower))) return "structured";
  if (matchToken(textHaystack(c), termLower)) return "text";
  return null;
}

const SENIORITY_PATTERNS = [
  { level: "lead", rx: /\b(principal|staff|lead|head|director|vp|chief|architect)\b/i },
  { level: "senior", rx: /\b(senior|sr\.?|manager)\b/i },
  { level: "junior", rx: /\b(junior|jr\.?|intern|entry[- ]?level|associate|trainee|graduate)\b/i },
];
function seniorityOf(title) {
  const t = title || "";
  for (const p of SENIORITY_PATTERNS) if (p.rx.test(t)) return p.level;
  return "mid";
}
function seniorityBonus(candLevel, wanted) {
  if (!wanted) return 0;
  const order = { junior: 1, mid: 2, senior: 3, lead: 4 };
  const w = order[String(wanted).toLowerCase()];
  const c = order[candLevel];
  if (!w || !c) return 0;
  if (c === w) return 2;
  if (w >= 3 && c >= w) return 2; // asking senior/lead, candidate is that or higher
  if (Math.abs(c - w) === 1) return 0.5; // adjacent
  return 0;
}

function recencyBonus(c) {
  const d = c.updated_at || c.created_at;
  if (!d) return 0;
  const days = (Date.now() - new Date(d).getTime()) / 86400000;
  if (isNaN(days)) return 0;
  if (days <= 30) return 1;
  if (days <= 90) return 0.5;
  return 0;
}

// Score one raw candidate. Returns null if a required skill is missing.
// opts: { preferred:[], required:[], seniority, location }
function scoreCandidate(c, opts) {
  const required = (opts.required || []).map((s) => String(s).toLowerCase());
  const preferred = (opts.preferred || []).map((s) => String(s).toLowerCase());
  const allWanted = Array.from(new Set([...required, ...preferred]));

  let score = 0;
  const matched = [];
  for (const w of allWanted) {
    const hit = skillHit(c, w);
    if (hit === "structured") {
      score += 3;
      matched.push(w);
    } else if (hit === "text") {
      score += 1;
      matched.push(w);
    }
  }

  const missingRequired = required.filter((r) => !matched.includes(r));
  if (required.length && missingRequired.length) return null; // hard filter

  const candLevel = seniorityOf(c.current_position);
  score += seniorityBonus(candLevel, opts.seniority);

  if (opts.location) {
    if ((c.candidate_location || "").toLowerCase().includes(String(opts.location).toLowerCase())) {
      score += 2;
    }
  }
  score += recencyBonus(c);

  return { score, matched, missingRequired, seniority: candLevel };
}

// ---- Normalization --------------------------------------------------------

function normalizeCandidate(c) {
  const skills = skillNamesOf(c);
  const description = strip(c.description || "");
  const education = [c.latest_degree, c.latest_university].filter(Boolean).join(" - ");
  const resumeParts = [
    c.full_name || "",
    c.current_position
      ? "CURRENT ROLE: " + c.current_position + " at " + (c.current_company || "N/A")
      : "",
    skills.length ? "SKILLS: " + skills.join(", ") : "",
    education ? "EDUCATION: " + education : "",
    c.candidate_location ? "LOCATION: " + c.candidate_location : "",
    description ? "SUMMARY: " + description.substring(0, 600) : "",
  ].filter(Boolean);

  return {
    source: "manatal",
    manatal_id: c.id,
    full_name: c.full_name || "",
    email: c.email || null,
    all_emails: c.email ? [c.email] : [],
    phone_number: c.phone_number || null,
    current_position: c.current_position || null,
    current_company: c.current_company || null,
    location: c.candidate_location || null,
    skills: skills,
    linkedin: null,
    education: education,
    experience_summary: c.current_position
      ? c.current_position + (c.current_company ? " at " + c.current_company : "")
      : "",
    resume_text: resumeParts.join("\n"),
    has_resume: !!c.resume,
    resume_url: c.resume || null,
    candidate_tags: c.candidate_tags || [],
    candidate_industries: c.candidate_industries || [],
    description: description,
    updated_at: c.updated_at || null,
  };
}

// ---- Retrieval (recall) ---------------------------------------------------

async function fetchField(field, term, page, pageSize) {
  const data = await manGet(
    "/candidates/?page=" + page + "&page_size=" + pageSize + "&" + field + "=" + encodeURIComponent(term)
  );
  return { results: (data && data.results) || [], count: (data && data.count) || 0 };
}

// Which pages to read: always page 1, then evenly spread the rest across the
// full range so we don't only see alphabetically-early candidates.
function samplePages(totalPages, depth) {
  if (totalPages <= 1) return [1];
  if (totalPages <= depth) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set([1]);
  const step = totalPages / depth;
  for (let i = 1; i < depth; i++) {
    pages.add(Math.min(totalPages, Math.max(2, Math.round(1 + i * step))));
  }
  return Array.from(pages).sort((a, b) => a - b);
}

// Retrieve candidates for one term across both fields, sampling pages.
// budget.calls caps total Manatal requests to keep latency bounded.
async function retrieveForTerm(term, opts, budget) {
  const pageSize = opts.pageSize || 100;
  const depth = opts.depth || 4;
  const byId = new Map();

  for (const field of FIELDS) {
    if (budget.calls <= 0) break;
    let first;
    try {
      first = await fetchField(field, term, 1, pageSize);
      budget.calls--;
    } catch (e) {
      continue;
    }
    for (const c of first.results) if (!byId.has(c.id)) byId.set(c.id, c);

    const totalPages = Math.ceil((first.count || 0) / pageSize);
    const morePages = samplePages(totalPages, depth).filter((p) => p !== 1);
    for (const p of morePages) {
      if (budget.calls <= 0) break;
      await wait(150);
      try {
        const r = await fetchField(field, term, p, pageSize);
        budget.calls--;
        for (const c of r.results) if (!byId.has(c.id)) byId.set(c.id, c);
      } catch (e) {
        /* skip page */
      }
    }
    await wait(150);
  }
  return Array.from(byId.values());
}

async function buildPool(terms, opts) {
  const budget = { calls: opts.maxCalls || 60 };
  const pool = new Map();
  for (const term of terms) {
    if (budget.calls <= 0) break;
    const raw = await retrieveForTerm(term, opts, budget);
    for (const c of raw) if (!pool.has(c.id)) pool.set(c.id, c);
  }
  return Array.from(pool.values());
}

// Rank a raw pool with the scoring function; drops required-skill misses.
function rankPool(raw, opts) {
  const out = [];
  for (const c of raw) {
    const s = scoreCandidate(c, opts);
    if (!s) continue;
    const n = normalizeCandidate(c);
    n.match_score = s.score;
    n.matched_skills = s.matched;
    n.missing_required = s.missingRequired;
    n.seniority = s.seniority;
    out.push(n);
  }
  out.sort((a, b) => b.match_score - a.match_score);
  return out;
}

async function fetchJobs(activeOnly) {
  const data = await manGet("/jobs/?page_size=100" + (activeOnly ? "&status=active" : ""));
  return (data && data.results) || [];
}

async function candidatePipelines(candidateId, jobMap) {
  try {
    const data = await manGet(
      "/matches/?page_size=50&ordering=-created_at&candidate_id=" + candidateId
    );
    const results = (data && data.results) || [];
    return results
      .filter((m) => String(m.candidate) === String(candidateId))
      .map((m) => ({
        job_id: m.job,
        job_name: (jobMap && jobMap[m.job]) || null,
        stage: m.stage && m.stage.name ? m.stage.name : null,
      }));
  } catch (e) {
    return [];
  }
}

// ---- Handler --------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mcp-key, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!MANATAL_TOKEN) return res.status(500).json({ error: "MANATAL_TOKEN not configured" });

  if (req.method === "GET") {
    try {
      const data = await manGet("/candidates/?page_size=1");
      return res.status(200).json({ success: true, source: "manatal", total_candidates: data.count });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, params } = req.body || {};

  try {
    // ========== SIMPLE SKILL SEARCH ==========
    if (action === "searchBySkills") {
      const { skills, required, seniority, location, perPage, depth } = params || {};
      if (!skills || !skills.length) return res.status(400).json({ error: "skills array required" });

      const terms = Array.from(new Set([...(required || []), ...skills].map(String)));
      const raw = await buildPool(terms, { depth: depth || 4, pageSize: 100, maxCalls: 50 });
      const ranked = rankPool(raw, { preferred: skills, required: required || [], seniority, location });
      const perP = perPage || 100;

      return res.status(200).json({
        count: Math.min(ranked.length, perP),
        source: "manatal",
        pooled: raw.length,
        candidates: ranked.slice(0, perP),
      });
    }

    // ========== MATCH CANDIDATES (multiple skill sets) ==========
    if (action === "matchCandidates") {
      const { skillSets, required, seniority, location, maxTotal, depth } = params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });
      const limit = maxTotal || 300;

      const preferred = Array.from(new Set(skillSets.flat().map(String)));
      const terms = Array.from(new Set([...(required || []).map(String), ...preferred]));
      const raw = await buildPool(terms, { depth: depth || 4, pageSize: 100, maxCalls: 60 });
      const ranked = rankPool(raw, { preferred, required: required || [], seniority, location });

      return res.status(200).json({
        count: Math.min(ranked.length, limit),
        source: "manatal",
        searchStats: { terms: terms.length, pooled: raw.length, ranked: ranked.length },
        candidates: ranked.slice(0, limit),
      });
    }

    // ========== MATCH APPLIED CANDIDATES (already in a pipeline) ==========
    if (action === "matchAppliedCandidates") {
      const { skillSets, required, seniority, location, maxTotal, checkLimit, depth } = params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });

      const preferred = Array.from(new Set(skillSets.flat().map(String)));
      const terms = Array.from(new Set([...(required || []).map(String), ...preferred]));
      const raw = await buildPool(terms, { depth: depth || 3, pageSize: 100, maxCalls: 50 });
      const ranked = rankPool(raw, { preferred, required: required || [], seniority, location });

      const jobMap = {};
      try {
        for (const j of await fetchJobs(false)) jobMap[j.id] = j.position_name;
      } catch (e) {}

      const toCheck = ranked.slice(0, checkLimit || 60);
      const applied = [];
      let checked = 0;
      for (const cand of toCheck) {
        const pipes = await candidatePipelines(cand.manatal_id, jobMap);
        checked++;
        if (pipes.length > 0) {
          cand._jobs = pipes.map((p) => ({ id: p.job_id, name: p.job_name, currentStage: p.stage || "Unknown" }));
          applied.push(cand);
        }
        if (checked % 5 === 0) await wait(200);
      }

      return res.status(200).json({
        count: applied.length,
        source: "manatal",
        totalSearched: ranked.length,
        totalChecked: checked,
        candidates: applied,
      });
    }

    // ========== JOB LIST ==========
    if (action === "jobs") {
      const jobs = await fetchJobs(true);
      return res.status(200).json({
        count: jobs.length,
        source: "manatal",
        jobs: jobs.map((j) => ({
          id: j.id,
          title: j.position_name,
          location: j.address || null,
          salary_min: j.salary_min || null,
          salary_max: j.salary_max || null,
          status: j.status || null,
        })),
      });
    }

    // ========== TEST ==========
    if (action === "test") {
      const data = await manGet("/candidates/?page_size=1");
      return res.status(200).json({ success: true, source: "manatal", total_candidates: data.count });
    }

    return res.status(400).json({ error: "Invalid action: " + action });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
