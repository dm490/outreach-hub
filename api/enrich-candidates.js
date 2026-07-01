// api/enrich-candidates.js
//
// ZoomInfo enrichment has been REMOVED.
//
// This endpoint is now a no-op passthrough: it returns the candidates exactly
// as received, with an enrichedCount of 0. The frontend still calls it, sees a
// clean 200 response, finds no new emails to merge, and continues straight to
// scoring. No ZoomInfo, no Postgres/Neon, no external calls -> no more 500s.
//
// (If you ever want contact enrichment back, restore the previous version from
//  git history: `git log --oneline -- api/enrich-candidates.js`.)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { candidates = [] } = req.body || {};

  return res.status(200).json({
    candidates: Array.isArray(candidates) ? candidates : [],
    enrichedCount: 0,
    fromCache: 0,
    fromZi: 0,
    enrichmentDisabled: true,
  });
}
