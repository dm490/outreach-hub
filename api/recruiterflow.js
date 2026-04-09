export default async function handler(req, res) {
  const RF_KEY = process.env.RECRUITERFLOW_API_KEY;
  
  if (!RF_KEY) {
    return res.status(200).json({ error: "No API key", hasKey: false });
  }

  try {
    // Try the user list endpoint first (simplest)
    const r = await fetch("https://recruiterflow.com/api/external/user/list?include_count=true", {
      method: "GET",
      headers: {
        "rf-api-key": RF_KEY
      }
    });

    const text = await r.text();
    
    return res.status(200).json({
      success: r.ok,
      httpStatus: r.status,
      keyUsed: RF_KEY.substring(0, 8) + "...",
      response: text.substring(0, 2000)
    });
  } catch (e) {
    return res.status(200).json({
      error: e.message,
      name: e.name,
      keyUsed: RF_KEY.substring(0, 8) + "..."
    });
  }
}
