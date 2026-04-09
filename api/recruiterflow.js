const RF_KEY = process.env.RECRUITERFLOW_API_KEY;

export default async function handler(req, res) {
  if (!RF_KEY) return res.status(200).json({ error: "No API key" });

  try {
    if (req.method === "GET") {
      const r = await fetch("https://recruiterflow.com/api/external/candidate/search", {
        method: "POST",
        headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          conjunction: "match-all",
          current_page: "1",
          filters: [{ conjunction: "contains", filter_type: "text", values: ["engineer"], key: "position" }],
          items_per_page: "3"
        })
      });
      const text = await r.text();
      return res.status(200).json({ ok: r.ok, status: r.status, body: text.substring(0, 3000) });
    }

    if (req.method === "POST") {
      const { action, params } = req.body || {};
      const { keyword, field, page, per_page } = params || {};
      const filters = [];
      if (keyword) {
        filters.push({ conjunction: "contains", filter_type: "text", values: [keyword], key: field || "position" });
      }
      if (filters.length === 0) {
        filters.push({ conjunction: "contains", filter_type: "text", values: ["a"], key: "name" });
      }
      const r = await fetch("https://recruiterflow.com/api/external/candidate/search", {
        method: "POST",
        headers: { "rf-api-key": RF_KEY, "Content-Type": "application/json" },
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

    return res.status(200).json({ error: "Use GET or POST" });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
