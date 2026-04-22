const MANATAL_TOKEN = process.env.MANATAL_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!MANATAL_TOKEN) return res.status(500).json({ error: "No MANATAL_TOKEN" });

  const { action, jobId, status } = req.body || {};

  // Archive/pause a job
  if (action === "updateJobStatus") {
    if (!jobId || !status) return res.status(400).json({ error: "jobId and status required" });
    if (!["active", "on_hold", "won", "lost"].includes(status)) {
      return res.status(400).json({ error: "status must be active, on_hold, won, or lost" });
    }
    try {
      const r = await fetch("https://api.manatal.com/open/v3/jobs/" + jobId + "/", {
        method: "PATCH",
        headers: {
          Authorization: "Token " + MANATAL_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });
      const data = await r.json();
      return res.status(r.status).json({ success: r.ok, jobId, status, data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Batch archive/pause multiple jobs
  if (action === "batchUpdateStatus") {
    const { jobs } = req.body; // [{id, status}]
    if (!jobs || !jobs.length) return res.status(400).json({ error: "jobs array required" });
    const results = [];
    for (const j of jobs) {
      try {
        const r = await fetch("https://api.manatal.com/open/v3/jobs/" + j.id + "/", {
          method: "PATCH",
          headers: {
            Authorization: "Token " + MANATAL_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: j.status }),
        });
        const data = await r.json();
        results.push({ id: j.id, status: j.status, success: r.ok, name: data.position_name || "?" });
      } catch (e) {
        results.push({ id: j.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return res.status(200).json({ results });
  }

  return res.status(400).json({ error: "Invalid action" });
}
