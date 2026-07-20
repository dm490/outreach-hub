// api/bulk-email.js
//
// Emails a Bulk Match summary to the recruitment team. For each role it includes
// ONLY the top `perRole` candidates (default 2) scoring at or above `threshold`
// (default 80). Roles with no qualifying candidates are omitted. Reuses the
// Resend setup proven in daily-scan.js (verified davidjoseph.co sender).
//
// POST body: { results:[...bulk-match results...], to?, subject?, threshold?, perRole? }
//   results  - the `results` array returned by /api/bulk-match
//   to       - recipient(s): array or comma-separated string (defaults to DEFAULT_TO)
//   subject  - optional custom subject
//   threshold- minimum score to include (default 80)
//   perRole  - max candidates per role (default 2)
//
// NOTE: like the scan endpoints, this is currently unauthenticated.

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = "DJ Recruiter Portal <portal@davidjoseph.co>";
const DEFAULT_TO = ["dm@davidjoseph.co"];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreColor(s) {
  return s >= 80 ? "#34d399" : s >= 60 ? "#f59e0b" : "#ef4444";
}

function buildHtml(rolesOut, totalCands, today, threshold, perRole) {
  var rolesHtml = rolesOut
    .map(function (role) {
      var cands = role.cands
        .map(function (c) {
          var col = scoreColor(c.score);
          var sub = [c.title, c.company].filter(Boolean).map(esc).join(" @ ");
          return (
            '<div style="display:flex;gap:10px;padding:10px;background:#0f172a;border-radius:8px;margin-bottom:6px;">' +
            '<div style="min-width:40px;height:40px;border-radius:50%;background:' +
            col +
            "22;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:" +
            col +
            ';">' +
            esc(c.score) +
            "</div>" +
            '<div style="flex:1;"><div style="font-size:14px;font-weight:700;color:#f1f5f9;">' +
            esc(c.name) +
            "</div>" +
            (sub ? '<div style="font-size:12px;color:#94a3b8;">' + sub + "</div>" : "") +
            (c.reason
              ? '<div style="font-size:12px;color:#cbd5e1;margin-top:4px;">' + esc(c.reason) + "</div>"
              : "") +
            "</div></div>"
          );
        })
        .join("");
      return (
        '<div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:14px;border-left:3px solid #6366f1;">' +
        '<div style="font-size:15px;font-weight:700;color:#f1f5f9;margin-bottom:2px;">' +
        esc(role.title) +
        "</div>" +
        '<div style="font-size:11px;color:#64748b;margin-bottom:10px;">' +
        esc([role.location, role.salary].filter(Boolean).join(" \u00b7 ")) +
        "</div>" +
        cands +
        "</div>"
      );
    })
    .join("");

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;max-width:700px;margin:0 auto;">' +
    '<div style="margin-bottom:20px;">' +
    '<div style="font-size:18px;font-weight:700;color:#f1f5f9;">Top Prospects to Reach Out To</div>' +
    '<div style="font-size:12px;color:#64748b;">' +
    today +
    "</div></div>" +
    '<div style="background:#1e293b;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#cbd5e1;">' +
    "Team \u2014 below are <strong>" +
    totalCands +
    " prospect" +
    (totalCands === 1 ? "" : "s") +
    "</strong> across <strong>" +
    rolesOut.length +
    " role" +
    (rolesOut.length === 1 ? "" : "s") +
    "</strong> worth reaching out to. These are the top " +
    perRole +
    " applicants per role scoring " +
    threshold +
    " or above. Please start outreach." +
    "</div>" +
    rolesHtml +
    '<div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #1e293b;">' +
    '<a href="https://outreach-hub-liard.vercel.app/" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">Open Recruiter Portal</a>' +
    '<div style="font-size:9px;color:#334155;margin-top:12px;">David Joseph &amp; Company | Bulk Match Summary</div>' +
    "</div></body></html>"
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed; use POST" });
  if (!RESEND_KEY) return res.status(500).json({ error: "RESEND_API_KEY not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const results = Array.isArray(body.results) ? body.results : [];
  const threshold = typeof body.threshold === "number" ? body.threshold : 78;
  const perRole = typeof body.perRole === "number" ? body.perRole : 2;

  let to = body.to;
  if (typeof to === "string") to = to.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(to) || !to.length) to = DEFAULT_TO;

  // Filter: per role -> score >= threshold, top `perRole`.
  const rolesOut = [];
  let totalCands = 0;
  for (const r of results) {
    const scored = (r && r.scored) || [];
    const qualifying = scored
      .filter((c) => typeof c.score === "number" && c.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, perRole);
    if (qualifying.length) {
      rolesOut.push({ title: r.jobTitle, location: r.location, salary: r.salary, cands: qualifying });
      totalCands += qualifying.length;
    }
  }

  if (!totalCands) {
    return res.status(200).json({
      success: false,
      sent: false,
      reason: "no_candidates_at_threshold",
      candidateCount: 0,
      roleCount: 0,
    });
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const subject =
    body.subject ||
    "Top prospects to reach out to: " +
      totalCands +
      " across " +
      rolesOut.length +
      " role" +
      (rolesOut.length === 1 ? "" : "s") +
      " \u2014 " +
      today;

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: to, subject: subject, html: buildHtml(rolesOut, totalCands, today, threshold, perRole) }),
    });
    const emailResult = await emailRes.json();
    if (!emailRes.ok) return res.status(502).json({ success: false, sent: false, error: emailResult });
    return res.status(200).json({
      success: true,
      sent: true,
      recipients: to,
      candidateCount: totalCands,
      roleCount: rolesOut.length,
      id: emailResult.id || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
