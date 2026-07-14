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
//
// Green flags: positive, free-text differentiators from the job (e.g. "founded
// a startup", "open-source contributor"). They are a SOFT signal handled in two
// layers -- a cheap deterministic keyword bonus, and an optional AI semantic
// pass that catches paraphrases. Green flags only ever ADD score; they never
// exclude a candidate the way a missing required skill does.

const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAN_BASE = "https://api.manatal.com/open/v3";

const FIELDS = ["description", "current_position"];

// Green-flag tuning knobs (kept as named constants so they're easy to adjust).
const GREEN_FLAG_KEYWORD_BONUS = 2; // per green flag whose text appears in the profile
const AI_GREEN_WEIGHT = 1.0; // green_flag_score (0-10) * weight, added to match_score
const AI_GREEN_MODEL = "claude-sonnet-4-6";
const AI_GREEN_DEFAULT_LIMIT = 25; // how many top candidates get the AI pass

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

async function callClaude(prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AI_GREEN_MODEL,
      max_tokens: maxTokens || 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

// ---- Query expansion (recall) ---------------------------------------------
//
// Manatal search is literal substring matching, so "React" never finds a
// profile that only says "ReactJS". We widen each search term into its close
// variants (abbreviations, alternate spellings, .js-style suffixes, tight
// synonyms) before hitting Manatal. One batched Claude call; falls back to the
// original terms if the key is missing or the response can't be parsed.
// Originals are always kept and searched first, so this only ever ADDS recall.
const EXPAND_MAX_VARIANTS = 3; // extra variants per term (excludes the original)
const EXPAND_MAX_TERMS = 24; // hard cap on total terms sent to retrieval

async function expandTerms(terms) {
  const base = Array.from(new Set(terms.map((t) => String(t).trim()).filter(Boolean)));
  if (!ANTHROPIC_KEY || !base.length) return base;

  const prompt =
    "You expand recruiting search terms into close variants to widen a keyword search. " +
    "For EACH term return up to " +
    EXPAND_MAX_VARIANTS +
    " ADDITIONAL variants: common abbreviations, alternate spellings, and formatting " +
    '(e.g. "React" -> "ReactJS", "React.js"; "Kubernetes" -> "K8s"; "Machine Learning" -> "ML"). ' +
    "Keep them TIGHT and high-precision -- do NOT add broad or loosely-related terms. " +
    "Return ONLY a JSON object mapping each input term to an array of variant strings " +
    "(excluding the original).\n\nTerms: " +
    JSON.stringify(base);

  try {
    const resp = await callClaude(prompt, 600);
    const m = resp.match(/\{[\s\S]*\}/);
    if (!m) return base;
    const map = JSON.parse(m[0]);

    const seen = new Set(base.map((t) => t.toLowerCase()));
    const ordered = [...base]; // originals first, so they're never starved of budget
    for (const t of base) {
      const variants = Array.isArray(map[t]) ? map[t] : [];
      for (const v of variants.slice(0, EXPAND_MAX_VARIANTS)) {
        const s = String(v).trim();
        if (s && !seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          ordered.push(s);
        }
      }
    }
    return ordered.slice(0, EXPAND_MAX_TERMS);
  } catch (e) {
    return base;
  }
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

// Green flags -- deterministic keyword layer. Award a hit when the flag's text
// shows up in the candidate's title, resume summary, or skill tags. Literal by
// design; the AI layer below handles paraphrases.
function greenFlagKeywordHits(c, flagsLower) {
  if (!flagsLower.length) return [];
  const hay = textHaystack(c) + " " + skillNamesOf(c).join(" ").toLowerCase();
  const hits = [];
  for (const f of flagsLower) {
    if (f && hay.includes(f)) hits.push(f);
  }
  return hits;
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
// opts: { preferred:[], required:[], seniority, location, greenFlags:[] }
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

  // Green flags -- keyword layer (soft bonus, never a filter).
  const greenFlags = (opts.greenFlags || []).map((s) => String(s).toLowerCase());
  const matchedGreen = greenFlagKeywordHits(c, greenFlags);
  score += matchedGreen.length * GREEN_FLAG_KEYWORD_BONUS;

  return { score, matched, missingRequired, seniority: candLevel, matchedGreen };
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
    n.matched_green_flags = s.matchedGreen;
    out.push(n);
  }
  out.sort((a, b) => b.match_score - a.match_score);
  return out;
}

// ---- Green flags: AI (semantic) layer -------------------------------------
//
// Runs on the top `limit` keyword-ranked candidates, asks Claude to judge how
// well each embodies the job's green flags (catching paraphrases the keyword
// layer misses), and blends that into a final_score used for the final sort.
// Degrades gracefully: if the key is missing, there are no green flags, or the
// call fails, every candidate simply keeps match_score as final_score.
async function applyAiGreenFlags(ranked, greenFlags, limit) {
  // Baseline: everyone's final score starts at their keyword score.
  for (const c of ranked) c.final_score = c.match_score;

  if (!ANTHROPIC_KEY) return { aiApplied: false, reason: "no_anthropic_key" };
  if (!greenFlags || !greenFlags.length) return { aiApplied: false, reason: "no_green_flags" };
  if (!ranked.length) return { aiApplied: false, reason: "empty_pool" };

  const shortlist = ranked.slice(0, limit || AI_GREEN_DEFAULT_LIMIT);

  const prompt =
    "You are an expert recruiter. Below is a list of GREEN FLAGS for a role -- " +
    "positive, differentiating qualities that make a candidate a strong fit. For EACH candidate, " +
    "judge how well their profile embodies these green flags, INCLUDING paraphrased or implied " +
    'evidence (e.g. "co-founded an early-stage company" satisfies "startup founder"). ' +
    "Score 0-10 (0 = no evidence, 10 = clearly embodies most/all) and give a one-line reason.\n\n" +
    "GREEN FLAGS:\n" +
    greenFlags.map((f) => "- " + f).join("\n") +
    "\n\nCANDIDATES:\n" +
    shortlist
      .map(
        (c) =>
          "ID:" +
          c.manatal_id +
          " | " +
          c.full_name +
          " | " +
          (c.current_position || "N/A") +
          " at " +
          (c.current_company || "N/A") +
          " | skills: " +
          (c.skills || []).slice(0, 20).join(", ") +
          " | " +
          (c.description || "").substring(0, 400)
      )
      .join("\n") +
    '\n\nReturn ONLY a JSON array: [{"id":123,"green_flag_score":8,"reason":"..."}]';

  try {
    const resp = await callClaude(prompt, 1500);
    const m = resp.match(/\[[\s\S]*\]/);
    if (!m) return { aiApplied: false, reason: "unparseable_response" };
    const scores = JSON.parse(m[0]);

    const byId = {};
    for (const s of scores) byId[String(s.id)] = s;

    for (const c of shortlist) {
      const s = byId[String(c.manatal_id)];
      if (s && typeof s.green_flag_score === "number") {
        c.green_flag_score = s.green_flag_score;
        c.green_flag_reason = s.reason || "";
        c.final_score = c.match_score + s.green_flag_score * AI_GREEN_WEIGHT;
      }
    }

    ranked.sort((a, b) => (b.final_score || 0) - (a.final_score || 0));
    return { aiApplied: true, scored: shortlist.length };
  } catch (e) {
    return { aiApplied: false, reason: "error:" + e.message };
  }
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
      const { skills, required, seniority, location, perPage, depth, greenFlags, aiGreenFlags, greenFlagLimit, expandQuery } =
        params || {};
      if (!skills || !skills.length) return res.status(400).json({ error: "skills array required" });

      const baseTerms = Array.from(new Set([...(required || []), ...skills].map(String)));
      const terms = expandQuery === false ? baseTerms : await expandTerms(baseTerms);
      const raw = await buildPool(terms, { depth: depth || 4, pageSize: 100, maxCalls: 60 });
      const ranked = rankPool(raw, {
        preferred: skills,
        required: required || [],
        seniority,
        location,
        greenFlags: greenFlags || [],
      });

      let aiMeta = { aiApplied: false };
      if (aiGreenFlags !== false) {
        aiMeta = await applyAiGreenFlags(ranked, greenFlags || [], greenFlagLimit);
      } else {
        for (const c of ranked) c.final_score = c.match_score;
      }

      const perP = perPage || 100;
      return res.status(200).json({
        count: Math.min(ranked.length, perP),
        source: "manatal",
        pooled: raw.length,
        queryTerms: terms.length,
        greenFlags: greenFlags || [],
        aiGreenFlagsApplied: aiMeta.aiApplied,
        candidates: ranked.slice(0, perP),
      });
    }

    // ========== MATCH CANDIDATES (multiple skill sets) ==========
    if (action === "matchCandidates") {
      const { skillSets, required, seniority, location, maxTotal, depth, greenFlags, aiGreenFlags, greenFlagLimit, expandQuery } =
        params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });
      const limit = maxTotal || 300;

      const preferred = Array.from(new Set(skillSets.flat().map(String)));
      const baseTerms = Array.from(new Set([...(required || []).map(String), ...preferred]));
      const terms = expandQuery === false ? baseTerms : await expandTerms(baseTerms);
      const raw = await buildPool(terms, { depth: depth || 4, pageSize: 100, maxCalls: 60 });
      const ranked = rankPool(raw, {
        preferred,
        required: required || [],
        seniority,
        location,
        greenFlags: greenFlags || [],
      });

      let aiMeta = { aiApplied: false };
      if (aiGreenFlags !== false) {
        aiMeta = await applyAiGreenFlags(ranked, greenFlags || [], greenFlagLimit);
      } else {
        for (const c of ranked) c.final_score = c.match_score;
      }

      return res.status(200).json({
        count: Math.min(ranked.length, limit),
        source: "manatal",
        searchStats: { terms: terms.length, pooled: raw.length, ranked: ranked.length },
        greenFlags: greenFlags || [],
        aiGreenFlagsApplied: aiMeta.aiApplied,
        candidates: ranked.slice(0, limit),
      });
    }

    // ========== MATCH APPLIED CANDIDATES (already in a pipeline) ==========
    if (action === "matchAppliedCandidates") {
      const { skillSets, required, seniority, location, maxTotal, checkLimit, depth, greenFlags, aiGreenFlags, greenFlagLimit, expandQuery } =
        params || {};
      if (!skillSets || !skillSets.length)
        return res.status(400).json({ error: "skillSets array required" });

      const preferred = Array.from(new Set(skillSets.flat().map(String)));
      const baseTerms = Array.from(new Set([...(required || []).map(String), ...preferred]));
      const terms = expandQuery === false ? baseTerms : await expandTerms(baseTerms);
      const raw = await buildPool(terms, { depth: depth || 3, pageSize: 100, maxCalls: 50 });
      const ranked = rankPool(raw, {
        preferred,
        required: required || [],
        seniority,
        location,
        greenFlags: greenFlags || [],
      });

      // Apply green flags BEFORE the pipeline check so the shortlist we check is
      // green-flag-aware (best-fit candidates get pipeline-checked first).
      let aiMeta = { aiApplied: false };
      if (aiGreenFlags !== false) {
        aiMeta = await applyAiGreenFlags(ranked, greenFlags || [], greenFlagLimit);
      } else {
        for (const c of ranked) c.final_score = c.match_score;
      }

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
        greenFlags: greenFlags || [],
        aiGreenFlagsApplied: aiMeta.aiApplied,
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
