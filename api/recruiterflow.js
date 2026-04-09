const RF_KEY = process.env.RECRUITERFLOW_API_KEY;
const RF_BASE = "https://recruiterflow.com/api/external";

function normalizeCandidate(c) {
  return {
    source: "recruiterflow",
    rf_id: c.id,
    full_name: (c.first_name || "") + " " + (c.last_name || ""),
    email: c.email_id || null,
    phone_number: c.phone || null,
    current_position: c.current_designation || null,
    current_company: c.current_organization || null,
    skills: c.skills || [],
    resume_text: [
      (c.first_name || "") + " " + (c.last_name || ""),
      c.current_designation ? "Current: " + c.current_designation + " at " + (c.current_organization || "") : "",
      c.skills?.length ? "Skills: " + c.skills.join(", ") : "",
      (c.education || []).map(e => e.degree + " from " + e.school).join("; "),
      (c.experience || []).slice(0, 5).map(e =>
        (e.designation || "") + " at " + (e.company || "")
      ).join("; ")
    ].filter(Boolean).join("\n")
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!RF_KEY) return res.status(500).json({ error: "RECRUITERFLOW_API_KEY not configured" });

  // GET = quick test
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
          // Page 1: 100 candidates with match-any (broader)
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

          // Page 2 for first 3 skill sets (most relevant keywords)
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
