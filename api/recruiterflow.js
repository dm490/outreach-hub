const RF_KEY = process.env.RECRUITERFLOW_API_KEY;

export default async function handler(req, res) {
  if (!RF_KEY) return res.status(200).json({ error: "No API key" });

  try {
    if (req.method === "GET") {
      // Try candidate list endpoint
      const r = await fetch("https://api.recruiterflow.com/api/external/candidate/list?current_page=1&items_per_page=3&include_count=true", {
        method: "GET",
        headers: { "RF-Api-Key": RF_KEY }
      });
      const text = await r.text();
      return res.status(200).json({ ok: r.ok, status: r.status, url: "api.recruiterflow.com", body: text.substring(0, 3000) });
    }

    if (req.method === "POST") {
      const { action, params } = req.body || {};
      const { keyword, field, page, per_page } = params || {};

      if (action === "list") {
        const r = await fetch("https://api.recruiterflow.com/api/external/candidate/list?current_page=" + (page || 1) + "&items_per_page=" + (per_page || 25) + "&include_count=true", {
          method: "GET",
          headers: { "RF-Api-Key": RF_KEY }
        });
        const data = await r.json();
        return res.status(200).json(data);
      }

      if (action === "search") {
        const filters = [];
        if (keyword) {
          filters.push({ conjunction: "contains", filter_type: "text", values: [keyword], key: field || "first_name" });
        }
        if (filters.length === 0) {
          filters.push({ conjunction: "contains", filter_type: "text", values: ["a"], key: "first_name" });
        }
        const r = await fetch("https://api.recruiterflow.com/api/external/candidate/search", {
          method: "POST",
          headers: { "RF-Api-Key": RF_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            conjunction: "match-all",
            current_page: String(page || 1),
            filters: filters,
            items_per_page: String(per_page || 25)
          })
        });
        const data = await r.json();
        return res.status(200).json(data);
      }

      return res.status(200).json({ error: "Invalid action" });
    }

    return res.status(200).json({ error: "Use GET or POST" });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
