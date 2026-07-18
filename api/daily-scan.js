const MANATAL_TOKEN = process.env.MANATAL_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAN_BASE = "https://api.manatal.com/open/v3";

async function manGet(path) {
  const r = await fetch(MAN_BASE + path, {
    headers: { Authorization: "Token " + MANATAL_TOKEN },
  });
  if (!r.ok) return null;
  return r.json();
}

async function callClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

function strip(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Pull the screening-relevant sections (green flags, red flags / traits to
// avoid, requirements, screening) out of a job description instead of blindly
// taking the first N characters. These sections sit near the END of the
// description, so a leading-prefix truncation misses them entirely. Falls back
// to a generous prefix when no recognizable sections are found.
const SIGNAL_HEADINGS =
  /(green\s*flag|red\s*flag|traits?\s*to\s*avoid|non-?ideal|do\s*not\s*source|requirement|qualification|must[- ]?have|nice[- ]?to[- ]?have|screening|ideal\s*compan)/i;

function extractScreeningSignal(html, maxChars) {
  if (!html) return "";
  const parts = html.split(/(?=<h[1-3][^>]*>)/i);
  const kept = [];
  for (const part of parts) {
    const h = part.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const heading = h ? strip(h[1]) : "";
    if (heading && SIGNAL_HEADINGS.test(heading)) kept.push(strip(part));
  }
  const signal = kept.join("\n") || strip(html);
  return signal.substring(0, maxChars || 2500);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handler(req, res) {
  // Allow manual trigger via GET/POST and cron trigger
  const startTime = Date.now();

  if (!MANATAL_TOKEN || !ANTHROPIC_KEY || !RESEND_KEY) {
    return res.status(500).json({
      error: "Missing env vars",
      has_manatal: !!MANATAL_TOKEN,
      has_anthropic: !!ANTHROPIC_KEY,
      has_resend: !!RESEND_KEY,
    });
  }

  try {
    // Step 1: Fetch all active jobs
    const jobsData = await manGet("/jobs/?page_size=100&status=active");
    const jobs = jobsData?.results || [];

    // Step 2: Check each job for new applicants (last 24 hours)
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const jobsWithNewApplicants = [];

    for (let i = 0; i < jobs.length; i++) {
      await wait(300);
      const matchData = await manGet(
        "/matches/?job_id=" + jobs[i].id + "&page_size=10&created_at__gte=" + yesterday
      );
      const newMatches = matchData?.results || [];
      if (newMatches.length > 0) {
        jobsWithNewApplicants.push({
          job: jobs[i],
          newApplicants: newMatches.length,
          matches: newMatches,
        });
      }

      // Safety: don't exceed 4 minutes on job scanning
      if (Date.now() - startTime > 240000) break;
    }

    // Step 3: For top 5 jobs with most new applicants, get AI scoring
    jobsWithNewApplicants.sort((a, b) => b.newApplicants - a.newApplicants);
    const topJobs = jobsWithNewApplicants.slice(0, 5);
    const scoredJobs = [];

    for (const item of topJobs) {
      const job = item.job;
      const jobDesc = extractScreeningSignal(job.description || "", 3000);

      // Fetch candidate details for new applicants
      const candidateProfiles = [];
      for (const match of item.matches.slice(0, 8)) {
        await wait(300);
        const candData = await manGet("/candidates/?id=" + match.candidate);
        const cand = candData?.results?.[0];
        if (cand) {
          candidateProfiles.push({
            id: cand.id,
            name: cand.full_name,
            position: cand.current_position,
            company: cand.current_company,
            location: cand.candidate_location,
            degree: cand.latest_degree,
            university: cand.latest_university,
            description: (cand.description || "").substring(0, 1000),
          });
        }
      }

      if (candidateProfiles.length === 0) continue;

      // Fetch job notes (screening criteria)
      let notes = "";
      try {
        const notesData = await manGet("/jobs/" + job.id + "/notes/");
        const notesList = notesData?.result || notesData?.results || [];
        notes = notesList.map((n) => strip(n.info || "")).join("\n");
      } catch (e) {}

      // AI Score
      const prompt = `You are an expert recruiter. Score these new applicants for this job.

JOB: ${job.position_name}
LOCATION: ${job.address || "Not specified"}
SALARY: $${job.salary_min || "?"} - $${job.salary_max || "?"}
JOB SIGNAL (green flags, red flags, requirements): ${jobDesc}
${notes ? "\nSCREENING CRITERIA:\n" + notes.substring(0, 1500) : ""}

NEW APPLICANTS:
${candidateProfiles.map((c) => JSON.stringify(c)).join("\n")}

Score each candidate 0-100. Weigh GREEN FLAGS as positives and RED FLAGS as negatives, but only when the profile shows real evidence -- ignore any flag you can't assess from the profile (attitude or interview-only signals). Do not auto-reject on an inferred red flag; treat it as a strong negative, not a hard filter. Give a one-line assessment.
Return ONLY a JSON array:
[{"name":"Name","score":85,"assessment":"One line reason"}]`;

      try {
        const aiResponse = await callClaude(prompt);
        const jsonMatch = aiResponse.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (jsonMatch) {
          const scored = JSON.parse(jsonMatch[0]);
          scoredJobs.push({
            jobTitle: job.position_name,
            jobId: job.id,
            location: job.address,
            salary: `$${job.salary_min || "?"} - $${job.salary_max || "?"}`,
            totalNewApplicants: item.newApplicants,
            scoredCandidates: scored.sort((a, b) => b.score - a.score),
          });
        }
      } catch (e) {
        scoredJobs.push({
          jobTitle: job.position_name,
          jobId: job.id,
          totalNewApplicants: item.newApplicants,
          scoredCandidates: candidateProfiles.map((c) => ({
            name: c.name,
            score: 0,
            assessment: c.position + " at " + c.company,
          })),
        });
      }

      // Safety: don't exceed 4.5 minutes total
      if (Date.now() - startTime > 270000) break;
    }

    // Step 4: Build summary of jobs WITHOUT new applicants
    const jobsWithoutApplicants = jobs.filter(
      (j) => !jobsWithNewApplicants.find((x) => x.job.id === j.id)
    );

    // Step 5: Build HTML email
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 700px; margin: 0 auto;">
  <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 24px;">
    <div style="width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #6366f1, #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; color: white; text-align: center; line-height: 36px;">DJ</div>
    <div>
      <div style="font-size: 18px; font-weight: 700; color: #f1f5f9;">Daily Recruiting Report</div>
      <div style="font-size: 12px; color: #64748b;">${today}</div>
    </div>
  </div>

  <!-- Summary Stats -->
  <div style="display: flex; gap: 12px; margin-bottom: 24px;">
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="font-size: 24px; font-weight: 700; color: #6366f1;">${jobs.length}</div>
      <div style="font-size: 10px; color: #64748b; text-transform: uppercase;">Active Jobs</div>
    </div>
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="font-size: 24px; font-weight: 700; color: #34d399;">${jobsWithNewApplicants.reduce((s, j) => s + j.newApplicants, 0)}</div>
      <div style="font-size: 10px; color: #64748b; text-transform: uppercase;">New Applicants</div>
    </div>
    <div style="flex: 1; background: #1e293b; border-radius: 8px; padding: 14px; text-align: center;">
      <div style="font-size: 24px; font-weight: 700; color: #f59e0b;">${jobsWithNewApplicants.length}</div>
      <div style="font-size: 10px; color: #64748b; text-transform: uppercase;">Jobs w/ Activity</div>
    </div>
  </div>

  ${scoredJobs.length > 0 ? `
  <!-- AI-Scored Matches -->
  <div style="font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">Top Matches (AI-Scored)</div>
  ${scoredJobs.map((sj) => `
  <div style="background: #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 12px; border-left: 3px solid #6366f1;">
    <div style="font-size: 15px; font-weight: 600; color: #f1f5f9; margin-bottom: 4px;">${sj.jobTitle}</div>
    <div style="font-size: 11px; color: #64748b; margin-bottom: 10px;">${sj.location || "Remote"} | ${sj.salary} | ${sj.totalNewApplicants} new applicant${sj.totalNewApplicants > 1 ? "s" : ""}</div>
    ${sj.scoredCandidates.map((c) => {
      const color = c.score >= 80 ? "#34d399" : c.score >= 60 ? "#f59e0b" : "#ef4444";
      return `
    <div style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: #0f172a; border-radius: 6px; margin-bottom: 4px;">
      <div style="min-width: 36px; height: 36px; border-radius: 50%; background: ${color}20; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: ${color};">${c.score}</div>
      <div>
        <div style="font-size: 13px; font-weight: 600; color: #f1f5f9;">${c.name}</div>
        <div style="font-size: 11px; color: #94a3b8;">${c.assessment}</div>
      </div>
    </div>`;
    }).join("")}
  </div>`).join("")}
  ` : ""}

  ${jobsWithNewApplicants.filter((j) => !scoredJobs.find((s) => s.jobId === j.job.id)).length > 0 ? `
  <!-- Other jobs with applicants -->
  <div style="font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 12px;">Other Jobs with New Applicants</div>
  ${jobsWithNewApplicants.filter((j) => !scoredJobs.find((s) => s.jobId === j.job.id)).map((j) => `
  <div style="display: flex; justify-content: space-between; padding: 8px 12px; background: #1e293b; border-radius: 6px; margin-bottom: 4px;">
    <span style="font-size: 13px; color: #f1f5f9;">${j.job.position_name}</span>
    <span style="font-size: 13px; font-weight: 700; color: #f59e0b;">${j.newApplicants} new</span>
  </div>`).join("")}
  ` : ""}

  ${jobsWithNewApplicants.length === 0 ? `
  <div style="background: #1e293b; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 16px;">
    <div style="font-size: 14px; color: #94a3b8;">No new applicants in the last 24 hours.</div>
    <div style="font-size: 12px; color: #64748b; margin-top: 8px;">${jobs.length} jobs active across your pipeline.</div>
  </div>
  ` : ""}

  <!-- Footer -->
  <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #1e293b;">
    <a href="https://outreach-hub-liard.vercel.app/" style="display: inline-block; padding: 10px 24px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; text-decoration: none; border-radius: 8px; font-size: 13px; font-weight: 600;">Open Recruiter Portal</a>
    <div style="font-size: 9px; color: #334155; margin-top: 12px;">David Joseph & Company | Recruiter Portal | Daily Scan</div>
  </div>
</body>
</html>`;

    // Step 6: Send email via Resend
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + RESEND_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "DJ Recruiter Portal <portal@davidjoseph.co>",
        to: ["dm@davidjoseph.co"],
        cc: ["rm@davidjoseph.co", "dhous009@gmail.com"],
        subject: `Daily Report: ${jobsWithNewApplicants.reduce((s, j) => s + j.newApplicants, 0)} new applicants across ${jobsWithNewApplicants.length} jobs — ${today}`,
        html: html,
      }),
    });

    const emailResult = await emailRes.json();

    return res.status(200).json({
      success: true,
      duration: Math.round((Date.now() - startTime) / 1000) + "s",
      activeJobs: jobs.length,
      jobsWithNewApplicants: jobsWithNewApplicants.length,
      totalNewApplicants: jobsWithNewApplicants.reduce((s, j) => s + j.newApplicants, 0),
      aiScoredJobs: scoredJobs.length,
      emailSent: emailResult,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
