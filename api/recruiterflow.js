const RF_KEY = process.env.RECRUITERFLOW_API_KEY;
const RF_BASE = "https://api.recruiterflow.com/api/external";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") { const r = await fetch(RF_BASE + "/candidates?page=1&per_page=3", { headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" } }); const data = await r.json(); return res.status(r.status).json({ success: r.ok, sample: data }); } if (req.method === "GET") { try { const r = await fetch(RF_BASE + "/candidates?page=1&per_page=3", { headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" } }); const data = await r.json(); return res.status(200).json({ success: true, sample: data }); } catch(e) { return res.status(500).json({ error: e.message }); } } if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!RF_KEY) return res.status(500).json({ error: "RECRUITERFLOW_API_KEY not configured" });

  const { action, params } = req.body || {};

  try {
    if (action === "search") {
      // Search candidates by keyword
      const { keyword, page, per_page } = params || {};
      const url = RF_BASE + "/candidates?page=" + (page || 1) + "&per_page=" + (per_page || 25) +
        (keyword ? "&search=" + encodeURIComponent(keyword) : "");
      const r = await fetch(url, {
        headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (action === "list") {
      // List candidates with pagination
      const { page, per_page } = params || {};
      const url = RF_BASE + "/candidates?page=" + (page || 1) + "&per_page=" + (per_page || 25);
      const r = await fetch(url, {
        headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (action === "candidate") {
      // Get single candidate details
      const { id } = params || {};
      if (!id) return res.status(400).json({ error: "Missing candidate id" });
      const r = await fetch(RF_BASE + "/candidates/" + id, {
        headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (action === "test") {
      // Test the API connection
      const r = await fetch(RF_BASE + "/candidates?page=1&per_page=2", {
        headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" }
      });
      const data = await r.json();
      return res.status(r.status).json({
        success: r.ok,
        status: r.status,
        sample: data
      });
    }

    return res.status(400).json({ error: "Invalid action: " + action });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
