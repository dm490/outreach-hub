// api/recruitee.js
//
// POST /api/recruitee
// Body: { action: "searchCandidates", params: { query, limit } }
//       { action: "matchCandidates", params: { skillSets, maxTotal } }
//
// Proxies to Recruitee's ATS API using env vars:
//   RECRUITEE_TOKEN    — Personal API token
//   RECRUITEE_COMPANY_ID — Company ID from Recruitee URL

const BASE = 'https://api.recruitee.com/c/';

function headers() {
  return {
    'Authorization': 'Bearer ' + process.env.RECRUITEE_TOKEN,
    'Content-Type': 'application/json',
  };
}

function companyUrl(path) {
  return BASE + process.env.RECRUITEE_COMPANY_ID + path;
}

// Search candidates using the performant search endpoint
async function searchCandidates(query, limit) {
  limit = limit || 25;
  const url = companyUrl('/search/new/candidates') +
    '?query=' + encodeURIComponent(query) +
    '&limit=' + limit;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const txt = await r.text();
    console.error('[recruitee] search error', r.status, txt);
    return { candidates: [], total: 0 };
  }
  const data = await r.json();
  const candidates = (data.candidates || []).map(function (c) {
    return {
      rt_id: c.id,
      full_name: c.name || '',
      email: (c.emails && c.emails[0]) || '',
      phone_number: (c.phones && c.phones[0]) || '',
      current_position: '',
      current_company: '',
      candidate_location: '',
      tags: c.tags || [],
      photo_url: c.photo_thumb_url || '',
      source: c.source || 'recruitee',
      created_at: c.created_at || '',
      placements: c.placements || [],
    };
  });
  return { candidates: candidates, total: data.total || candidates.length };
}

// Get full candidate details (includes fields, links, cv, etc.)
async function getCandidate(id) {
  const url = companyUrl('/candidates/' + id);
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) return null;
  const data = await r.json();
  return data.candidate || null;
}

// Match candidates: search multiple skill sets, deduplicate, return enriched profiles
async function matchCandidates(skillSets, maxTotal) {
  maxTotal = maxTotal || 150;
  const seen = {};
  const all = [];

  for (let i = 0; i < skillSets.length && all.length < maxTotal; i++) {
    const query = skillSets[i].join(' ');
    if (!query) continue;
    try {
      const result = await searchCandidates(query, 30);
      for (let j = 0; j < result.candidates.length; j++) {
        const c = result.candidates[j];
        if (!seen[c.rt_id]) {
          seen[c.rt_id] = true;
          all.push(c);
        }
      }
    } catch (e) {
      console.error('[recruitee] match search error for:', query, e.message);
    }
    // Small delay to stay under rate limits
    if (i < skillSets.length - 1) {
      await new Promise(function (r) { setTimeout(r, 300); });
    }
  }

  // Enrich top candidates with full details (get position, company, resume text)
  const enrichLimit = Math.min(all.length, 50);
  let enriched = 0;
  for (let k = 0; k < enrichLimit; k++) {
    try {
      const full = await getCandidate(all[k].rt_id);
      if (full) {
        // Extract position and company from fields or placements
        const fields = full.fields || [];
        const posField = fields.find(function (f) {
          return f.name && f.name.toLowerCase().indexOf('position') !== -1;
        });
        const compField = fields.find(function (f) {
          return f.name && f.name.toLowerCase().indexOf('company') !== -1;
        });
        all[k].current_position = (posField && posField.values && posField.values[0] && posField.values[0].text) || '';
        all[k].current_company = (compField && compField.values && compField.values[0] && compField.values[0].text) || '';

        // Try to get resume/CV text from qualifications or description
        all[k].resume_text = full.cv_plain_text || '';

        // Get social links
        const links = full.links || [];
        const linkedin = links.find(function (l) {
          return l.url && l.url.indexOf('linkedin') !== -1;
        });
        all[k].linkedin = linkedin ? linkedin.url : '';

        // Tags
        all[k].tags = full.tags || all[k].tags || [];

        enriched++;
      }
    } catch (e) {
      // Skip enrichment failures silently
    }
    if (k < enrichLimit - 1 && k % 5 === 4) {
      await new Promise(function (r) { setTimeout(r, 300); });
    }
  }

  return {
    candidates: all,
    count: all.length,
    totalSearches: skillSets.length,
    enriched: enriched,
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.RECRUITEE_TOKEN || !process.env.RECRUITEE_COMPANY_ID) {
    return res.status(500).json({ error: 'Recruitee credentials not configured' });
  }

  const { action, params } = req.body || {};

  try {
    if (action === 'searchCandidates') {
      const result = await searchCandidates(params.query || '', params.limit || 25);
      return res.status(200).json(result);
    }
    if (action === 'matchCandidates') {
      const result = await matchCandidates(params.skillSets || [], params.maxTotal || 150);
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: 'Invalid action. Use: searchCandidates, matchCandidates' });
  } catch (e) {
    console.error('[recruitee] handler error', e);
    return res.status(500).json({ error: e.message });
  }
}
