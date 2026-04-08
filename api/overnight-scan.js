const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAN_BASE = "https://api.manatal.com/open/v3";

function strip(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens || 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

async function searchCandidates(keyword, page) {
  await wait(350);
  const r1 = await manGet(
    "/candidates/?page=" + (page || 1) + "&page_size=20&current_position=" + encodeURIComponent(keyword)
  );
  return r1?.results || [];
}

async function searchCandidatesByDesc(keyword) {
  await wait(350);
  const r = await manGet(
    "/candidates/?page=1&page_size=20&description=" + encodeURIComponent(keyword)
  );
  return r?.results || [];
}

export default async function handler(req, res) {
  const startTime = Date.now();

  if (!MANATAL_TOKEN || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Missing env vars" });
  }

  try {
    // Step 1: Fetch ALL active jobs
    const jobsPage1 = await manGet("/jobs/?page_size=100&status=active");
    const jobs = jobsPage1?.results || [];

    // Step 2: Fetch ALL applicants across all jobs (recent matches)
    const allMatches = await manGet("/matches/?page_size=100&ordering=-created_at");
    const matchesByJob = {};
    const matchedCandidateIds = new Set();
    for (const m of allMatches?.results || []) {
      if (!matchesByJob[m.job]) matchesByJob[m.job] = [];
      matchesByJob[m.job].push(m);
      matchedCandidateIds.add(m.candidate);
    }

    // Step 3: Generate keywords for ALL jobs in one Claude call (batch)
    const jobSummaries = jobs.map((j) => ({
      id: j.id,
      title: j.position_name,
      desc: strip(j.description || "").substring(0, 200),
    }));

    // Split into batches of 15 for keyword generation
    const keywordBatches = [];
    for (let i = 0; i < jobSummaries.length; i += 15) {
      keywordBatches.push(jobSummaries.slice(i, i + 15));
    }

    const jobKeywords = {}; // jobId -> [keywords]

    for (const batch of keywordBatches) {
      if (Date.now() - startTime > 30000) break; // 30s safety for keyword gen

      const kwPrompt = `For each job below, extract 3 SINGLE-WORD search keywords (technical skills, tools, or role terms). Return ONLY a JSON object mapping job IDs to keyword arrays.

Example: {"123":["Python","Backend","AWS"],"456":["Sales","Enterprise","Fintech"]}

Jobs:
${batch.map((j) => `ID ${j.id}: ${j.title} - ${j.desc}`).join("\n")}

Return ONLY the JSON object.`;

      try {
        const kwResponse = await callClaude(kwPrompt, 800);
        const jsonMatch = kwResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          for (const [id, kws] of Object.entries(parsed)) {
            jobKeywords[id] = kws;
          }
        }
      } catch (e) {
        // Fallback: use title words
        for (const j of batch) {
          jobKeywords[j.id] = j.title.split(" ").filter((w) => w.length > 3).slice(0, 3);
        }
      }
      await wait(500);
    }

    // Step 4: Search database for candidates matching each job
    // Build a shared search cache to avoid duplicate searches
    const searchCache = {}; // keyword -> candidates[]
    const jobCandidates = {}; // jobId -> candidates[]

    for (const job of jobs) {
      if (Date.now() - startTime > 180000) break; // 3 min safety

      const kws = jobKeywords[job.id] || [job.position_name.split(" ")[0]];
      const seen = {};
      const candidates = [];

      // Add applicants who applied to THIS job
      const jobMatches = matchesByJob[job.id] || [];
      for (const m of jobMatches.slice(0, 5)) {
        await wait(300);
        const candData = await manGet("/candidates/?id=" + m.candidate);
        const cand = candData?.results?.[0];
        if (cand && !seen[cand.id]) {
          seen[cand.id] = true;
          cand._applied = true;
          candidates.push(cand);
        }
      }

      // Search by keywords (use cache)
      for (const kw of kws) {
        if (candidates.length > 25) break;
        if (!searchCache[kw]) {
          searchCache[kw] = await searchCandidates(kw);
        }
        for (const c of searchCache[kw]) {
          if (!seen[c.id]) {
            seen[c.id] = true;
            candidates.push(c);
          }
        }
      }

      // Also search first keyword by description
      if (kws[0] && candidates.length < 20) {
        const descKey = "desc_" + kws[0];
        if (!searchCache[descKey]) {
          searchCache[descKey] = await searchCandidatesByDesc(kws[0]);
        }
        for (const c of searchCache[descKey]) {
          if (!seen[c.id]) {
            seen[c.id] = true;
            candidates.push(c);
          }
        }
      }

      jobCandidates[job.id] = candidates;
    }

    // Step 5: AI-score in batches of 3 jobs
    const results = [];
    const scoringBatches = [];
    for (let i = 0; i < jobs.length; i += 3) {
      scoringBatches.push(jobs.slice(i, i + 3));
    }

    for (const batch of scoringBatches) {
      if (Date.now() - startTime > 270000) break; // 4.5 min safety

      // Build prompt for batch
      let batchPrompt =
        "You are an expert recruiter. For each job below, select the SINGLE BEST candidate and score them 0-100.\n\n";

      let hasAnyCandidates = false;

      for (const job of batch) {
        const cands = jobCandidates[job.id] || [];
        if (cands.length === 0) continue;
        hasAnyCandidates = true;

        const jobDesc = strip(job.description || "").substring(0, 400);

        // Get notes/screening criteria
        let notes = "";
        try {
          const notesData = await manGet("/jobs/" + job.id + "/notes/");
          const notesList = notesData?.result || notesData?.results || [];
          notes = notesList
            .map((n) => strip(n.info || ""))
            .join(" ")
            .substring(0, 300);
        } catch (e) {}

        batchPrompt += `---
JOB ID: ${job.id}
TITLE: ${job.position_name}
LOCATION: ${job.address || "Not specified"}
SALARY: $${job.salary_min || "?"} - $${job.salary_max || "?"}
DESCRIPTION: ${jobDesc}
${notes ? "SCREENING CRITERIA: " + notes : ""}

CANDIDATES:
${cands
  .slice(0, 15)
  .map(
    (c) =>
      `- ID:${c.id} | ${c.full_name} | ${c.current_position || "N/A"} at ${c.current_company || "N/A"} | ${c.candidate_location || "N/A"} | ${c.latest_university || "N/A"} | ${c._applied ? "APPLIED" : "sourced"} | ${(c.description || "").substring(0, 300)}`
  )
  .join("\n")}

`;
      }

      if (!hasAnyCandidates) continue;

      batchPrompt += `\nFor EACH job above, pick the SINGLE BEST candidate. Follow screening criteria strictly if provided. Candidates who APPLIED get strong priority.

Return ONLY a JSON array:
[{"jobId":123,"candidateId":456,"candidateName":"Name","score":85,"title":"Current Title","company":"Current Company","reason":"One sentence why they are the best fit"}]`;

      try {
        const aiResponse = await callClaude(batchPrompt, 1500);
        const jsonMatch = aiResponse.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (!jsonMatch) {
          const fallbackMatch = aiResponse.match(/\[[\s\S]*\]/);
          if (fallbackMatch) {
            const scored = JSON.parse(fallbackMatch[0]);
            results.push(...scored);
          }
        } else {
          const scored = JSON.parse(jsonMatch[0]);
          results.push(...scored);
        }
      } catch (e) {
        // Skip this batch on error
      }

      await wait(500);
    }

    // Step 6: Enrich results with job titles for any missing
    const jobMap = {};
    for (const j of jobs) jobMap[j.id] = j;

    const enrichedResults = results.map((r) => {
      const job = jobMap[r.jobId];
      return {
        jobId: r.jobId,
        jobTitle: job?.position_name || r.jobTitle || "Unknown",
        jobLocation: job?.address || "",
        jobSalary: job
          ? "$" + (job.salary_min || "?") + " - $" + (job.salary_max || "?")
          : "",
        candidateId: r.candidateId,
        candidateName: r.candidateName,
        candidateTitle: r.title || "",
        candidateCompany: r.company || "",
        score: r.score || 0,
        reason: r.reason || "",
      };
    });

    // Sort by score descending
    enrichedResults.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      duration: Math.round((Date.now() - startTime) / 1000) + "s",
      totalJobs: jobs.length,
      jobsScanned: Object.keys(jobCandidates).length,
      jobsWithMatches: enrichedResults.length,
      candidatesSearched: Object.values(searchCache).reduce(
        (s, arr) => s + arr.length,
        0
      ),
      uniqueSearchTerms: Object.keys(searchCache).length,
      matches: enrichedResults,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e.message, stack: e.stack, duration: Math.round((Date.now() - startTime) / 1000) + "s" });
  }
}
