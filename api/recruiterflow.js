const RF_KEY = process.env.RECRUITERFLOW_API_KEY;
const RF_BASE = "https://recruiterflow.com/api/external";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!RF_KEY) return res.status(500).json({ error: "RECRUITERFLOW_API_KEY not configured" });

  try {
    // GET = test the connection with a simple candidate search
    if (req.method === "GET") {
      const r = await fetch(RF_BASE + "/candidate/search", {
        method: "POST",
        headers: {
          "rf-api-key": RF_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conjunction: "match-all",
          current_page: "1",
          filters: [],
          items_per_page: "3"
        })
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch(e) { data = { raw: text.substring(0, 500) }; }
      return res.status(200).json({ success: r.ok, status: r.status, sample: data });
    }

    // POST = actual API operations
    if (req.method === "POST") {
      const { action, params } = req.body || {};

      if (action === "search") {
        const { keyword, page, per_page } = params || {};
        const filters = keyword ? [{
          conjunction: "contains",
          filter_type: "text",
          values: [keyword],
          key: "name"
        }] : [];
        const r = await fetch(RF_BASE + "/candidate/search", {
          method: "POST",
          headers: {
            "rf-api-key": RF_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            conjunction: "match-all",
            current_page: String(page || 1),
            filters: filters,
            items_per_page: String(per_page || 25)
          })
        });
        const data = await r.json();
        return res.status(r.status).json(data);
      }

      if (action === "search_position") {
        const { keyword, page, per_page } = params || {};
        const filters = keyword ? [{
          conjunction: "contains",
          filter_type: "text",
          values: [keyword],
          key: "position"
        }] : [];
        const r = await fetch(RF_BASE + "/candidate/search", {
          method: "POST",
          headers: {
            "rf-api-key": RF_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            conjunction: "match-all",
            current_page: String(page || 1),
            filters: filters,
            items_per_page: String(per_page || 25)
          })
        });
        const data = await r.json();
        return res.status(r.status).json(data);
      }

      if (action === "list") {
        const { page, per_page } = params || {};
        const r = await fetch(RF_BASE + "/candidate/search", {
          method: "POST",
          headers: {
            "rf-api-key": RF_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            conjunction: "match-all",
            current_page: String(page || 1),
            filters: [],
            items_per_page: String(per_page || 25)
          })
        });
        const data = await r.json();
        return res.status(r.status).json(data);
      }

      return res.status(400).json({ error: "Invalid action: " + action });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
