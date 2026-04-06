export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { target, path, body } = req.body;

  try {
    if (target === "anthropic") {
      const r = await fetch("https://api.anthropic.com" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (target === "manatal") {
      const r = await fetch("https://api.manatal.com" + path, {
        headers: {
          Authorization: "Token " + process.env.MANATAL_TOKEN,
        },
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (target === "manatal_post") {
      const r = await fetch("https://api.manatal.com" + path, {
        method: "POST",
        headers: {
          Authorization: "Token " + process.env.MANATAL_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    return res.status(400).json({ error: "Invalid target" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
