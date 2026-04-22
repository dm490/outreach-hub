// api/enrich-candidates.js
//
// POST /api/enrich-candidates
// Body: { candidates: [{ id, firstName, lastName, company, email? }, ...] }
// Returns: { candidates: [...], enrichedCount, fromCache, fromZi }
//
// - Self-contained: DB schema auto-creates on first invocation.
// - Cache-first: anything seen in last 30 days comes from Postgres.
// - Cache-miss: batched against ZoomInfo (up to 25/req), written back.
// - Only candidates missing an email AND having name + company get enriched.
//
// Uses @neondatabase/serverless (Vercel Postgres → Neon native integration).

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL || process.env.DATABASE_URL);

// ============================================================================
// Schema — runs once per cold start (idempotent, safe under concurrency)
// ============================================================================

let _schemaReady = false;

async function ensureSchema() {
  if (_schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS enrichment_cache (
      id              BIGSERIAL PRIMARY KEY,
      lookup_key      TEXT        NOT NULL UNIQUE,
      first_name      TEXT,
      last_name       TEXT,
      company_name    TEXT,
      found           BOOLEAN     NOT NULL DEFAULT FALSE,
      email           TEXT,
      phone           TEXT,
      job_title       TEXT,
      linkedin_url    TEXT,
      zoominfo_id     TEXT,
      raw_response    JSONB,
      source          TEXT        NOT NULL DEFAULT 'zoominfo',
      enriched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_enrichment_cache_company  ON enrichment_cache(company_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_enrichment_cache_enriched ON enrichment_cache(enriched_at)`;
  _schemaReady = true;
}

// ============================================================================
// Cache key normalization
// ============================================================================

function buildLookupKey({ firstName = '', lastName = '', company = '' }) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s&-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const normCompany = norm(company)
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|sas|bv|holdings?|group)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return `${norm(firstName)}|${norm(lastName)}|${normCompany}`;
}

// ============================================================================
// ZoomInfo client — JWT caching + batch enrich (up to 25 per call)
// ============================================================================

const ZI_BASE = 'https://api.zoominfo.com';
let _jwtCache = { token: null, expiresAt: 0 };

async function getZiJwt() {
  const now = Date.now();
  if (_jwtCache.token && _jwtCache.expiresAt > now + 60_000) return _jwtCache.token;

  const res = await fetch(`${ZI_BASE}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ZOOMINFO_USERNAME,
      password: process.env.ZOOMINFO_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`ZoomInfo auth failed: ${res.status} ${await res.text()}`);
  const { jwt } = await res.json();
  _jwtCache = { token: jwt, expiresAt: now + 50 * 60_000 };
  return jwt;
}

async function batchEnrich(inputs) {
  if (!inputs?.length) return [];
  const jwt = await getZiJwt();
  const CHUNK = 25;
  const out = [];

  for (let i = 0; i < inputs.length; i += CHUNK) {
    const chunk = inputs.slice(i, i + CHUNK);
    const body = {
      matchPersonInput: chunk.map((c, idx) => ({
        personID: String(idx),
        firstName: c.firstName,
        lastName: c.lastName,
        companyName: c.companyName,
      })),
      outputFields: [
        'id', 'firstName', 'lastName', 'email', 'phone',
        'directPhoneDoNotCall', 'mobilePhoneDoNotCall',
        'jobTitle', 'companyName', 'externalUrls',
      ],
    };

    const res = await fetch(`${ZI_BASE}/enrich/contact`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('[zoominfo] enrich error', res.status, await res.text());
      for (const c of chunk) out.push({ lookupKey: c.lookupKey, found: false });
      continue;
    }

    const json = await res.json();
    const results = json?.data?.result || [];
    const byIdx = new Map();
    for (const r of results) {
      const idx = Number(r.input?.personID);
      if (Number.isFinite(idx)) byIdx.set(idx, r);
    }

    chunk.forEach((c, idx) => {
      const r = byIdx.get(idx);
      const person = r?.data?.[0];
      if (!person) { out.push({ lookupKey: c.lookupKey, found: false }); return; }
      const linkedin = (person.externalUrls || []).find((u) => /linkedin\.com/i.test(u.url))?.url || null;
      out.push({
        lookupKey: c.lookupKey,
        found: true,
        email: person.email || null,
        phone: person.phone || person.directPhoneDoNotCall || person.mobilePhoneDoNotCall || null,
        jobTitle: person.jobTitle || null,
        linkedinUrl: linkedin,
        zoominfoId: person.id ? String(person.id) : null,
        raw: person,
      });
    });
  }
  return out;
}

// ============================================================================
// DB helpers
// ============================================================================

async function getCachedEnrichments(lookupKeys, maxAgeDays = 30) {
  if (!lookupKeys?.length) return new Map();
  const rows = await sql`
    SELECT lookup_key, found, email, phone, job_title, linkedin_url, zoominfo_id, enriched_at
    FROM enrichment_cache
    WHERE lookup_key = ANY(${lookupKeys}::text[])
      AND enriched_at > NOW() - (${maxAgeDays} || ' days')::interval
  `;
  return new Map(rows.map((r) => [r.lookup_key, r]));
}

async function upsertEnrichments(rows) {
  if (!rows?.length) return;
  for (const r of rows) {
    await sql`
      INSERT INTO enrichment_cache
        (lookup_key, first_name, last_name, company_name, found,
         email, phone, job_title, linkedin_url, zoominfo_id, raw_response)
      VALUES
        (${r.lookup_key}, ${r.first_name}, ${r.last_name}, ${r.company_name}, ${r.found},
         ${r.email}, ${r.phone}, ${r.job_title}, ${r.linkedin_url}, ${r.zoominfo_id},
         ${r.raw_response ? JSON.stringify(r.raw_response) : null}::jsonb)
      ON CONFLICT (lookup_key) DO UPDATE SET
        found         = EXCLUDED.found,
        email         = COALESCE(EXCLUDED.email, enrichment_cache.email),
        phone         = COALESCE(EXCLUDED.phone, enrichment_cache.phone),
        job_title     = COALESCE(EXCLUDED.job_title, enrichment_cache.job_title),
        linkedin_url  = COALESCE(EXCLUDED.linkedin_url, enrichment_cache.linkedin_url),
        zoominfo_id   = COALESCE(EXCLUDED.zoominfo_id, enrichment_cache.zoominfo_id),
        raw_response  = EXCLUDED.raw_response,
        updated_at    = NOW(),
        enriched_at   = NOW()
    `;
  }
}

// ============================================================================
// Handler
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await ensureSchema();

    const { candidates = [] } = req.body || {};
    if (!Array.isArray(candidates)) {
      return res.status(400).json({ error: 'candidates must be an array' });
    }

    const needs = [];
    for (const c of candidates) {
      if (c.email) continue;
      if (!c.firstName && !c.lastName) continue;
      if (!c.company) continue;
      const lookupKey = buildLookupKey({
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.company,
      });
      needs.push({ candidate: c, lookupKey });
    }

    if (needs.length === 0) {
      return res.status(200).json({ candidates, enrichedCount: 0, fromCache: 0, fromZi: 0 });
    }

    const keys = needs.map((n) => n.lookupKey);
    const cache = await getCachedEnrichments(keys, 30);

    const toFetch = needs.filter((n) => !cache.has(n.lookupKey));
    let fromZi = 0;

    if (toFetch.length > 0) {
      const ziInputs = toFetch.map((n) => ({
        lookupKey: n.lookupKey,
        firstName: n.candidate.firstName || '',
        lastName: n.candidate.lastName || '',
        companyName: n.candidate.company || '',
      }));
      const ziResults = await batchEnrich(ziInputs);
      fromZi = ziResults.filter((r) => r.found).length;

      const rowsToUpsert = ziResults.map((r, idx) => {
        const n = toFetch[idx];
        return {
          lookup_key: r.lookupKey,
          first_name: n.candidate.firstName || null,
          last_name: n.candidate.lastName || null,
          company_name: n.candidate.company || null,
          found: r.found,
          email: r.email || null,
          phone: r.phone || null,
          job_title: r.jobTitle || null,
          linkedin_url: r.linkedinUrl || null,
          zoominfo_id: r.zoominfoId || null,
          raw_response: r.raw || null,
        };
      });
      await upsertEnrichments(rowsToUpsert);

      for (const r of ziResults) {
        cache.set(r.lookupKey, {
          lookup_key: r.lookupKey,
          found: r.found,
          email: r.email,
          phone: r.phone,
          job_title: r.jobTitle,
          linkedin_url: r.linkedinUrl,
          zoominfo_id: r.zoominfoId,
        });
      }
    }

    const enrichmentByCandidate = new Map();
    for (const n of needs) {
      const e = cache.get(n.lookupKey);
      if (e?.found) enrichmentByCandidate.set(n.candidate, e);
    }

    const out = candidates.map((c) => {
      const e = enrichmentByCandidate.get(c);
      if (!e) return c;
      return {
        ...c,
        email: c.email || e.email || null,
        phone: c.phone || e.phone || null,
        jobTitle: c.jobTitle || e.job_title || null,
        linkedinUrl: c.linkedinUrl || e.linkedin_url || null,
        enrichedVia: 'zoominfo',
      };
    });

    return res.status(200).json({
      candidates: out,
      enrichedCount: enrichmentByCandidate.size,
      fromCache: enrichmentByCandidate.size - fromZi,
      fromZi,
    });
  } catch (err) {
    console.error('[enrich-candidates] error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
