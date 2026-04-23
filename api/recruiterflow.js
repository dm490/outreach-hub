const RF_KEY = process.env.RECRUITERFLOW_API_KEY;
const RF_BASE = "https://recruiterflow.com/api/external";

function normalizeCandidate(c) {
  const emails = c.email || [];
  const primaryEmail = emails[0] || null;
  const phone = Array.isArray(c.phone_number) ? c.phone_number[0] : (c.phone_number || null);

  const resumeParts = [
    (c.first_name || "") + " " + (c.last_name || ""),
    c.current_designation ? "CURRENT ROLE: " + c.current_designation + " at " + (c.current_organization || "N/A") : "",
    c.skills?.length ? "SKILLS: " + c.skills.join(", ") : "",
    (c.education || []).length ? "EDUCATION: " + c.education.map(e =>
      (e.degree || "") + (e.specialization ? " in " + e.specialization : "") + " from " + (e.school || "")
    ).join("; ") : "",
    (c.experience || []).length ? "EXPERIENCE:\n" + c.experience.slice(0, 8).map(e =>
      "- " + (e.designation || "Role") + " at " + (e.company || "Company") +
      (e.from ? " (" + e.from.filter(Boolean).join("/") + " - " + (e.current ? "Present" : (e.to || []).filter(Boolean).join("/") || "N/A") + ")" : "") +
      (e.description ? "\n  " + e.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300) : "")
    ).join("\n") : "",
    c.candidate_summary ? "SUMMARY: " + c.candidate_summary.substring(0, 500) : "",
    c.linkedin_profile ? "LinkedIn: " + c.linkedin_profile : ""
  ].filter(Boolean);

  return {
    source: "recruiterflow",
    rf_id: c.id,
    full_name: (c.first_name || "") + " " + (c.last_name || ""),
    email: primaryEmail,
    all_emails: emails,
    phone_number: phone,
    current_position: c.current_designation || null,
    current_company: c.current_organization || null,
    skills: c.skills || [],
    linkedin: c.linkedin_profile || null,
    education: (c.education || []).map(e => (e.degree || "") + " from " + (e.school || "")).join("; "),
    experience_summary: (c.experience || []).slice(0, 5).map(e =>
      (e.designation || "") + " at " + (e.company || "")
    ).join(" | "),
    resume_text: resumeParts.join("\n"),
    has_resume: false,
    resume_url: null,
    raw_experience: c.experience || [],
    raw_education: c.education || [],
    candidate_summary: c.candidate_summary || ""
  };
}

async function rfSearch(skills, page, perPage, conjunction) {
  const r = await fetch(RF_BASE + "/candidate/search", {
    method: "POST",
    headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: [{ key: "skills", conjunction: "in", values: skills }],
      conjunction: conjunction || "match-any",
      current_page: page || 1,
      items_per_page: perPage || 100
    })
  });
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// Fetch stage movements (which jobs a candidate is in) for a single candidate
async function getStageMovements(candidateId) {
  try {
    const r = await fetch(RF_BASE + "/candidate/activities/stage-movement/list?id=" + candidateId, {
      headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.data || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!RF_KEY) return res.status(500).json({ error: "RECRUITERFLOW_API_KEY not configured" });

  if (req.method === "GET") {
    try {
      const r = await fetch(RF_BASE + "/user/list", {
        headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(200).json({ success: true, users: data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, params } = req.body || {};

  try {
    // ========== MATCH CANDIDATES (main integration endpoint) ==========
    if (action === "matchCandidates") {
      const { skillSets, maxTotal } = params || {};
      if (!skillSets || !skillSets.length) return res.status(400).json({ error: "skillSets array required" });

      const allCandidates = new Map();
      const limit = maxTotal || 300;
      const searchStats = [];

      for (const skills of skillSets) {
        if (allCandidates.size >= limit) break;
        const skillArr = Array.isArray(skills) ? skills : [skills];

        try {
          const page1 = await rfSearch(skillArr, 1, 100, "match-any");
          let added = 0;
          for (const c of page1) {
            if (allCandidates.size >= limit) break;
            if (!allCandidates.has(c.id)) {
              allCandidates.set(c.id, normalizeCandidate(c));
              added++;
            }
          }
          searchStats.push({ skills: skillArr.join("+"), page1: page1.length, added });

          if (searchStats.length <= 3 && page1.length >= 90 && allCandidates.size < limit) {
            const page2 = await rfSearch(skillArr, 2, 100, "match-any");
            let added2 = 0;
            for (const c of page2) {
              if (allCandidates.size >= limit) break;
              if (!allCandidates.has(c.id)) {
                allCandidates.set(c.id, normalizeCandidate(c));
                added2++;
              }
            }
            if (added2 > 0) searchStats[searchStats.length - 1].page2 = page2.length;
            searchStats[searchStats.length - 1].added += added2;
          }

          await new Promise(r => setTimeout(r, 150));
        } catch (e) {
          searchStats.push({ skills: skillArr.join("+"), error: e.message });
        }
      }

      return res.status(200).json({
        count: allCandidates.size,
        source: "recruiterflow",
        searchStats,
        totalSearches: searchStats.length,
        candidates: Array.from(allCandidates.values())
      });
    }

    // ========== MATCH APPLIED CANDIDATES (skill search + stage movement check) ==========
    if (action === "matchAppliedCandidates") {
      const { skillSets, maxTotal, checkLimit } = params || {};
      if (!skillSets || !skillSets.length) return res.status(400).json({ error: "skillSets array required" });

      // Step 1: Skill search (same as matchCandidates)
      const allRaw = new Map();
      const limit = maxTotal || 200;

      for (const skills of skillSets) {
        if (allRaw.size >= limit) break;
        const skillArr = Array.isArray(skills) ? skills : [skills];
        try {
          const results = await rfSearch(skillArr, 1, 100, "match-any");
          for (const c of results) {
            if (allRaw.size >= limit) break;
            if (!allRaw.has(c.id)) allRaw.set(c.id, c);
          }
          await new Promise(r => setTimeout(r, 150));
        } catch (e) { /* skip */ }
      }

      // Step 2: Check stage movements for top candidates (most likely to have jobs)
      const toCheck = Array.from(allRaw.values()).slice(0, checkLimit || 60);
      const applied = [];
      let checked = 0;

      for (const c of toCheck) {
        try {
          const movements = await getStageMovements(c.id);
          checked++;
          if (movements && movements.jobs && movements.jobs.length > 0) {
            const normalized = normalizeCandidate(c);
            // Attach job pipeline info
            normalized._jobs = movements.jobs.map(j => ({
              id: j.id,
              name: j.name,
              currentStage: j.transitions && j.transitions.length > 0
                ? j.transitions[j.transitions.length - 1].to
                : "Unknown",
              addedBy: j.added_by ? j.added_by.name : null,
              stageCount: j.transitions ? j.transitions.length : 0
            }));
            applied.push(normalized);
          }
          // Rate limit: small delay every 5 checks
          if (checked % 5 === 0) await new Promise(r => setTimeout(r, 200));
        } catch (e) { /* skip */ }
      }

      return res.status(200).json({
        count: applied.length,
        source: "recruiterflow",
        totalSearched: allRaw.size,
        totalChecked: checked,
        candidates: applied
      });
    }

    // ========== SIMPLE SKILL SEARCH ==========
    if (action === "searchBySkills") {
      const { skills, page, perPage } = params || {};
      if (!skills || !skills.length) return res.status(400).json({ error: "skills array required" });

      const data = await rfSearch(skills, page || 1, perPage || 100, "match-any");
      const candidates = data.map(normalizeCandidate);

      return res.status(200).json({ count: candidates.length, source: "recruiterflow", candidates });
    }

    // ========== JOB LIST ==========
    if (action === "jobs") {
      const r = await fetch(RF_BASE + "/job/list", {
        headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    // ========== TEST ==========
    if (action === "test") {
      const r = await fetch(RF_BASE + "/user/list", {
        headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(200).json({ success: r.ok, users: data });
    }

    return res.status(400).json({ error: "Invalid action: " + action });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
