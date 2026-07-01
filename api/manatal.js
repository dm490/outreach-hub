// api/manatal.js
//
// Data-source client for Manatal (https://api.manatal.com/open/v3).
// Mirrors the action interface of api/recruiterflow.js so the MCP layer
// (api/mcp.js) can forward to it WITHOUT any other change.
//
// Auth: MANATAL_TOKEN env var (already configured — the scan endpoints use it).
//
// Skill-search note: Manatal's Open API has no server-side "skills" filter.
// Its candidate filters are substring ("contains") matches. So we retrieve
// using the fields Manatal CAN filter — description (the parsed resume summary,
// which usually mentions skills explicitly) and current_position (job title) —
// then RANK the pooled results against each candidate's structured skills[]
// array. That ranking is the part that makes matching better than a raw
// keyword search.

const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const MAN_BASE = "https://api.manatal.com/open/v3";

function strip(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function manGet(path) {
  const r = await fetch(MAN_BASE + path, {
    headers: {
      Authorization: "Token " + MANATAL_TOKEN,
      "Content-Type": "application/json",
    },
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

// Pull the plain skill-name strings off a raw Manatal candidate.
function skillNamesOf(c) {
  return Array.isArray(c.skills)
    ? c.skills.map((s) => (s && s.skill_name ? String(s.skill_name) : "")).filter(Boolean)
    : [];
}

// Map a raw Manatal candidate into the common shape the MCP tools expect.
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
    linkedin: null, // not returned by the candidates list endpoint
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
  };
}

// Retrieve one page of candidates for a single term via a given filter field.
async function manSearchField(field, term, perPage) {
  const data = await manGet(
    "/candidates/?page=1&page_size=" +
      (perPage || 25) +
      "&" +
      field +
      "=" +
      encodeURIComponent(term)
  );
  return (data && data.results) || [];
}

// Retrieve candidates for a single skill/term across the fields Manatal can
// filter (resume summary + job title), de-duplicated by candidate id.
async function retrieveForTerm(term, perPage) {
  const byId = new Map();
  // description (parsed resume summary) mentions skills explicitly -> best recall
  try {
    for (const c of await manSearchField("description", term, perPage)) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
  } catch (e) {
    /* continue */
  }
  await wait(200);
  // current_position (job title) catches role-style terms
  try {
    for (const c of await manSearchField("current_position", term, perPage)) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
  } catch (e) {
    /* continue */
  }
  return Array.from(byId.values());
}

// Score a raw candidate against the desired skills (already lowercased).
// A structured skill hit weighs most; a title/summary text hit adds a little.
function scoreAgainstSkills(rawCand, wantedLower) {
  const have = skillNamesOf(rawCand).map((s) => s.toLowerCase());
  const haystack = (
    (rawCand.current_position || "") +
    " " +
    (rawCand.description || "")
  ).toLowerCase();

  const matched = [];
  let score = 0;
  for (const w of wantedLower) {
    const inSkills = have.some((h) => h === w || h.includes(w) || w.includes(h));
    const inText = haystack.includes(w);
    if (inSkills) {
      score += 3;
      matched.push(w);
    } else if (inText) {
      score += 1;
      matched.push(w);
    }
  }
  return { score, matched };
}

// Core: given a flat list of skill terms, build a ranked candidate pool.
async function skillSearch(terms, perTerm, limit) {
  const pool = new Map(); // id -> raw candidate
  const cap = (limit || 300) * 2;
  for (const term of terms) {
    if (pool.size >= cap) break;
    const raw = await retrieveForTerm(term, perTerm || 25);
    for (const c of raw) if (!pool.has(c.id)) pool.set(c.id, c);
    await wait(150);
  }
  const wantedLower = terms.map((t) => String(t).toLowerCase());
  return Array.from(pool.values())
    .map((c) => {
      const s = scoreAgainstSkills(c, wantedLower);
      const norm = normalizeCandidate(c);
      norm.match_score = s.score;
      norm.matched_skills = s.matched;
      return norm;
    })
    .sort((a, b) => b.match_score - a.match_score);
}

// Fetch jobs (optionally only active ones).
async function fetchJobs(activeOnly) {
  const data = await manGet("/jobs/?page_size=100" + (activeOnly ? "&status=active" : ""));
  return (data && data.results) || [];
}

// Best-effort: which pipelines (jobs) is a candidate currently in?
// NOTE: uses the candidate_id filter on /matches/. We also re-filter the
// results by candidate id so correctness holds even if the server ignores the
// param. If Manatal exposes a different filter name, this degrades gracefully
// (candidate simply won't be marked "applied") rather than erroring.
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
        is_active: m.is_active !== false,
      }));
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mcp-key, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!MANATAL_TOKEN) return res.status(500).json({ error: "MANATAL_TOKEN not configured" });

  // Lightweight health check.
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
      const { skills, perPage } = params || {};
      if (!skills || !skills.length) return res.status(400).json({ error: "skills array required" });
      const ranked = await skillSearch(skills, 30, 200);
      const perP = perPage || 100;
      return res.status(200).json({
        count: Math.min(ranked.length, perP),
        source: "manatal",
        candidates: ranked.slice(0, perP),
      });
    }

    // ========== MATCH CANDIDATES (multiple skill sets) ==========
    if (action === "matchCandidates") {
      const { skillSets, maxTotal } = params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });
      const limit = maxTotal || 300;

      // Flatten to unique terms for retrieval, then rank against the full set.
      const terms = Array.from(new Set(skillSets.flat().map((s) => String(s))));
      const ranked = await skillSearch(terms, 25, limit);

      return res.status(200).json({
        count: Math.min(ranked.length, limit),
        source: "manatal",
        searchStats: { terms: terms.length, pooled: ranked.length },
        candidates: ranked.slice(0, limit),
      });
    }

    // ========== MATCH APPLIED CANDIDATES (already in a pipeline) ==========
    if (action === "matchAppliedCandidates") {
      const { skillSets, maxTotal, checkLimit } = params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });

      const terms = Array.from(new Set(skillSets.flat().map((s) => String(s))));
      const ranked = await skillSearch(terms, 25, maxTotal || 200);

      // Build a job id -> title map once for labelling pipelines.
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
          cand._jobs = pipes.map((p) => ({
            id: p.job_id,
            name: p.job_name,
            currentStage: p.stage || "Unknown",
          }));
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
