// api/bulk-match.js
//
// Bulk applicant ranking. For a set of jobs (default: the newest active roles),
// this pulls each job's APPLICANTS (people already in its pipeline), scores them
// against the job's own green/red flags + requirements, and returns a ranked
// shortlist per job. No sourcing/retrieval -- the candidates are already known,
// so this is the fast path.
//
// Cost model: the applicant profile fetch (one Manatal call per applicant) is the
// bottleneck, so we (a) cache candidate fetches across jobs, (b) cap applicants
// per job, and (c) time-box the run and return a cursor. The client re-calls with
// { jobIds, cursor: nextCursor } until { done: true } -- turning a 40-role batch
// into a few background calls instead of 40 separate queued matches.
//
// NOTE: like the scan endpoints, this is currently unauthenticated. Once the
// shared-secret gate is added across the app, gate this too (it returns PII).

const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAN_BASE = "https://api.manatal.com/open/v3";
const MODEL = "claude-sonnet-4-6";

function strip(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pull the screening-relevant sections (green flags, red flags / traits to
// avoid, requirements, screening) out of a job description instead of blindly
// taking a prefix -- those sections sit near the END of the description.
const SIGNAL_HEADINGS =
  /(green\s*flag|red\s*flag|traits?\s*to\s*avoid|non-?ideal|do\s*not\s*source|requirement|qualification|must[- ]?have|nice[- ]?to[- ]?have|screening|ideal\s*compan)/i;

function extractScreeningSignal(html, maxChars) {
  if (!html) return "";
  const parts = html.split(/(?=<h[1-3][^>]*>)/i);
  const kept = [];
  for (const part of parts) {
    const h = part.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const heading = h ? strip(h[1]) : "";
    if (heading && SIGNAL_HEADINGS.test(heading)) kept.push(strip(part));
  }
  const signal = kept.join("\n") || strip(html);
  return signal.substring(0, maxChars || 2500);
}

async function manGet(path) {
  const r = await fetch(MAN_BASE + path, {
    headers: { Authorization: "Token " + MANATAL_TOKEN },
  });
  if (!r.ok) return null;
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
      model: MODEL,
      max_tokens: maxTokens || 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

async function fetchActiveJobs() {
  const out = [];
  let page = 1;
  while (page <= 4) {
    const data = await manGet("/jobs/?page_size=100&status=active&page=" + page);
    const rows = (data && data.results) || [];
    out.push(...rows);
    if (!data || !data.next) break;
    page++;
    await wait(150);
  }
  return out;
}

async function fetchJobById(id) {
  const data = await manGet("/jobs/" + id + "/");
  return data && data.id ? data : null;
}

// Applicants = pipeline matches for this job. Ordered newest-first, capped.
async function fetchApplicants(jobId, cap) {
  const out = [];
  let page = 1;
  while (out.length < cap && page <= 5) {
    const data = await manGet(
      "/matches/?job_id=" + jobId + "&page_size=50&ordering=-created_at&page=" + page
    );
    const rows = ((data && data.results) || []).filter((m) => String(m.job) === String(jobId));
    for (const m of rows) out.push(m);
    if (!data || !data.next) break;
    page++;
    await wait(200);
  }
  return out.slice(0, cap);
}

// Fetch a candidate profile, caching across jobs so an applicant to several
// roles is only fetched once.
async function getCandidate(id, cache) {
  const key = String(id);
  if (key in cache) return cache[key];
  await wait(250);
  const data = await manGet("/candidates/?id=" + id);
  const c = (data && data.results && data.results[0]) || null;
  cache[key] = c;
  return c;
}

async function getJobNotes(jobId) {
  try {
    const data = await manGet("/jobs/" + jobId + "/notes/");
    const list = (data && (data.result || data.results)) || [];
    return list
      .map((n) => strip(n.info || ""))
      .join(" ")
      .substring(0, 1200);
  } catch (e) {
    return "";
  }
}

function candLine(c, stage) {
  return (
    "- ID:" +
    c.id +
    " | " +
    (c.full_name || "N/A") +
    " | " +
    (c.current_position || "N/A") +
    " at " +
    (c.current_company || "N/A") +
    " | " +
    (c.candidate_location || "N/A") +
    " | " +
    (c.latest_university || "N/A") +
    (stage ? " | stage: " + stage : "") +
    " | " +
    strip(c.description || "").substring(0, 350)
  );
}

// Score up to SCORE_BATCH applicants per Claude call. Large fields are split
// into sub-batches and merged, so a busy role never silently returns empty.
const SCORE_BATCH = 12;

function buildScorePrompt(job, signal, notes, profiles) {
  return (
    "You are an expert recruiter. Rank the applicants for this role by fit.\n\n" +
    "JOB: " + job.position_name + "\n" +
    "LOCATION: " + (job.address || "Not specified") + "\n" +
    "SALARY: $" + (job.salary_min || "?") + " - $" + (job.salary_max || "?") + "\n" +
    "JOB SIGNAL (green flags, red flags, requirements): " + signal + "\n" +
    (notes ? "SCREENING CRITERIA: " + notes + "\n" : "") +
    "\nAPPLICANTS:\n" +
    profiles.map((p) => candLine(p.c, p.stage)).join("\n") +
    "\n\nScore EVERY applicant listed 0-100 for fit (return one object per applicant). Weigh GREEN " +
    "FLAGS as positives and RED FLAGS as negatives, but ONLY when the profile shows real evidence -- " +
    "ignore any flag you can't assess from a resume (attitude or interview-only signals). Do not " +
    "auto-reject on an inferred red flag; treat it as a strong negative, not a hard filter.\n\n" +
    "Return ONLY a JSON array, best first: " +
    '[{"candidateId":123,"name":"Name","score":85,"title":"Current Title","company":"Company","reason":"one sentence"}]'
  );
}

async function scoreChunk(job, signal, notes, profiles) {
  const prompt = buildScorePrompt(job, signal, notes, profiles);
  try {
    const resp = await callClaude(prompt, 3000);
    const m = resp.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Manatal doesn't store a LinkedIn URL for these candidates, so: use a real
// profile URL if the candidate included one in their resume/cover-letter text,
// otherwise build a "find them on LinkedIn" search link from name + company.
function linkedinFor(c) {
  const text = (c.description || "") + " " + (c.resume || "");
  const m = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i);
  if (m) {
    let u = m[0].replace(/\/$/, "");
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return { url: u, type: "profile" };
  }
  const q = encodeURIComponent(((c.full_name || "") + " " + (c.current_company || "")).trim());
  return { url: "https://www.google.com/search?q=" + q + "+linkedin", type: "search" };
}

async function scoreJob(job, applicantRows, candCache, perJob) {
  const profiles = [];
  for (const m of applicantRows) {
    const c = await getCandidate(m.candidate, candCache);
    if (c) profiles.push({ c, stage: m.stage && m.stage.name ? m.stage.name : null });
  }
  if (!profiles.length) return { scored: [], applicantCount: applicantRows.length };

  const profById = {};
  profiles.forEach((p) => {
    profById[String(p.c.id)] = p.c;
  });

  const signal = extractScreeningSignal(job.description || "", 2500);
  const notes = await getJobNotes(job.id);

  // Split into sub-batches so no single scoring prompt gets too large to parse.
  const all = [];
  for (let i = 0; i < profiles.length; i += SCORE_BATCH) {
    const chunk = profiles.slice(i, i + SCORE_BATCH);
    const scored = await scoreChunk(job, signal, notes, chunk);
    all.push(...scored);
    if (i + SCORE_BATCH < profiles.length) await wait(300);
  }

  all.sort((a, b) => (b.score || 0) - (a.score || 0));
  all.forEach((s) => {
    const c = profById[String(s.candidateId)];
    if (c) {
      const li = linkedinFor(c);
      s.linkedin = li.url;
      s.linkedin_type = li.type;
    }
  });
  return { scored: all.slice(0, perJob), applicantCount: applicantRows.length };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mcp-key, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed; use POST" });
  if (!MANATAL_TOKEN || !ANTHROPIC_KEY) return res.status(500).json({ error: "Missing env vars" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const {
    jobIds, // optional: pin a specific ordered set (used for pagination)
    scope = "newest", // "newest" | "active"  (used only when jobIds omitted)
    newestCount = 40,
    perJob = 5,
    maxApplicants = 25,
    cursor = 0,
    batchJobs = 100,
    timeBudgetMs = 250000,
  } = body;

  const startTime = Date.now();

  try {
    // Always resolve active jobs so we have full job objects available every
    // call (cheap: 1-4 requests). Client pins the ordered id set via jobIds.
    const active = await fetchActiveJobs();
    const jobObjById = {};
    for (const j of active) jobObjById[String(j.id)] = j;

    let orderedIds;
    if (Array.isArray(jobIds) && jobIds.length) {
      orderedIds = jobIds.map(String);
    } else if (scope === "active") {
      orderedIds = active.map((j) => String(j.id));
    } else {
      orderedIds = active
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, newestCount)
        .map((j) => String(j.id));
    }

    const results = [];
    const candCache = {};
    let i = cursor;
    let processed = 0;

    for (; i < orderedIds.length && processed < batchJobs; i++) {
      if (Date.now() - startTime > timeBudgetMs) break;

      const jid = orderedIds[i];
      let job = jobObjById[jid];
      if (!job) job = await fetchJobById(jid);
      if (!job) {
        processed++;
        continue;
      }

      const salary = "$" + (job.salary_min || "?") + " - $" + (job.salary_max || "?");
      const applicants = await fetchApplicants(jid, maxApplicants);

      if (!applicants.length) {
        results.push({
          jobId: jid,
          jobTitle: job.position_name,
          location: job.address || "",
          salary,
          applicantCount: 0,
          scored: [],
        });
        processed++;
        continue;
      }

      const { scored, applicantCount } = await scoreJob(job, applicants, candCache, perJob);
      results.push({
        jobId: jid,
        jobTitle: job.position_name,
        location: job.address || "",
        salary,
        applicantCount,
        scored,
      });
      processed++;
      await wait(300);
    }

    const done = i >= orderedIds.length;
    return res.status(200).json({
      success: true,
      done,
      nextCursor: done ? null : i,
      jobIds: orderedIds, // client passes this back (with nextCursor) for the next page
      totalJobs: orderedIds.length,
      processedThisCall: processed,
      candidatesFetched: Object.keys(candCache).length,
      duration: Math.round((Date.now() - startTime) / 1000) + "s",
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
