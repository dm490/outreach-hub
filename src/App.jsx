import { useState, useEffect, useCallback } from "react";

// Config
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;
const MANATAL_MCP = { type: "url", url: "https://mcp.manatal.com/p/dyzGAk-Qi8H9Hc5XBDzeDgMTWt0be4ELRTT874c", name: "manatal" };
const GMAIL_MCP = { type: "url", url: "https://gmail.mcp.claude.com/mcp", name: "gmail" };
const API_HEADERS = { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };

function Badge({ children, variant = "default" }) {
  const s = { default: { background: "rgba(99,102,241,0.12)", color: "#818cf8" }, success: { background: "rgba(52,211,153,0.12)", color: "#34d399" }, warning: { background: "rgba(251,191,36,0.12)", color: "#fbbf24" }, muted: { background: "rgba(148,163,184,0.1)", color: "#94a3b8" }, info: { background: "rgba(56,189,248,0.12)", color: "#38bdf8" }, error: { background: "rgba(239,68,68,0.12)", color: "#ef4444" } };
  return <span style={{ ...s[variant], padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>;
}

function CandidateRow({ candidate, selected, onToggle, onCompose }) {
  const [h, setH] = useState(false);
  return (
    <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "grid", gridTemplateColumns: "40px 2fr 1.5fr 1.5fr 1fr 100px", alignItems: "center", padding: "14px 20px", background: selected ? "rgba(99,102,241,0.06)" : h ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "all 0.15s ease", cursor: "pointer" }}
      onClick={() => onToggle(candidate.id)}>
      <div><div style={{ width: 18, height: 18, borderRadius: 5, border: selected ? "none" : "1.5px solid rgba(255,255,255,0.2)", background: selected ? "#6366f1" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s ease" }}>{selected && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div></div>
      <div><div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 14, marginBottom: 3 }}>{candidate.full_name}</div><div style={{ color: "#64748b", fontSize: 12 }}>{candidate.email || "No email"}</div></div>
      <div><div style={{ color: "#cbd5e1", fontSize: 13 }}>{candidate.current_position}</div><div style={{ color: "#475569", fontSize: 12 }}>{candidate.current_company}</div></div>
      <div style={{ color: "#64748b", fontSize: 13 }}>{candidate.candidate_location}</div>
      <div><Badge variant={candidate.source_type === "sourced" ? "info" : "default"}>{candidate.source_type}</Badge></div>
      <div style={{ textAlign: "right" }}>{candidate.email && <button onClick={(e) => { e.stopPropagation(); onCompose(candidate); }} style={{ background: h ? "rgba(99,102,241,0.15)" : "transparent", border: "1px solid rgba(99,102,241,0.3)", color: "#818cf8", padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: "pointer", transition: "all 0.15s ease", fontFamily: "inherit" }}>Compose</button>}</div>
    </div>
  );
}

function StatusToast({ items }) {
  if (!items.length) return null;
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 8, zIndex: 999 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          padding: "12px 18px", borderRadius: 10, display: "flex", alignItems: "center", gap: 10,
          background: item.status === "success" ? "rgba(52,211,153,0.15)" : item.status === "error" ? "rgba(239,68,68,0.15)" : "rgba(99,102,241,0.15)",
          border: `1px solid ${item.status === "success" ? "rgba(52,211,153,0.3)" : item.status === "error" ? "rgba(239,68,68,0.3)" : "rgba(99,102,241,0.3)"}`,
          backdropFilter: "blur(12px)", animation: "slideIn 0.3s ease",
          minWidth: 280,
        }}>
          {item.status === "loading" && <span className="gen-spinner" style={{ width: 14, height: 14 }} />}
          {item.status === "success" && <span style={{ color: "#34d399", fontSize: 16 }}>✓</span>}
          {item.status === "error" && <span style={{ color: "#ef4444", fontSize: 16 }}>✕</span>}
          <div>
            <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 500 }}>{item.title}</div>
            {item.detail && <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2 }}>{item.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmailComposer({ candidates, onSend, onBack, generating, onGenerate, streamedSubject, streamedBody, sendingStatus }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [tone, setTone] = useState("professional");
  const [currentPreview, setCurrentPreview] = useState(0);
  const [edited, setEdited] = useState(false);

  useEffect(() => { if (streamedSubject && !edited) setSubject(streamedSubject); }, [streamedSubject, edited]);
  useEffect(() => { if (streamedBody && !edited) setBody(streamedBody); }, [streamedBody, edited]);

  const cwe = candidates.filter(c => c.email);
  const p = cwe[currentPreview];

  const merge = (raw) => {
    if (!raw || !p) return raw || "";
    return raw.replace(/\{name\}/g, p.full_name?.split(" ")[0] || "there").replace(/\{first_name\}/g, p.full_name?.split(" ")[0] || "there").replace(/\{position\}/g, p.current_position || "your role").replace(/\{company\}/g, p.current_company || "your company");
  };

  const isSending = sendingStatus === "sending";

  return (
    <div style={{ display: "flex", gap: 24, height: "100%" }}>
      <div style={{ flex: "0 0 310px", background: "rgba(255,255,255,0.02)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <h3 style={{ color: "#f1f5f9", fontSize: 15, fontWeight: 600, margin: 0 }}>Campaign Settings</h3>
        <div>
          <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.04em" }}>JOB TITLE / ROLE</label>
          <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Senior ML Engineer" style={{ width: "100%", padding: "10px 12px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#f1f5f9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
        <div>
          <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.04em" }}>YOUR COMPANY</label>
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme Corp" style={{ width: "100%", padding: "10px 12px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#f1f5f9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
        <div>
          <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.04em" }}>TONE</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["professional", "casual", "enthusiastic", "direct"].map(t => (
              <button key={t} onClick={() => setTone(t)} style={{ padding: "6px 13px", borderRadius: 6, fontSize: 12, fontWeight: 500, background: tone === t ? "#6366f1" : "rgba(0,0,0,0.3)", border: tone === t ? "1px solid #6366f1" : "1px solid rgba(255,255,255,0.08)", color: tone === t ? "white" : "#94a3b8", cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>{t}</button>
            ))}
          </div>
        </div>
        <button onClick={() => { setEdited(false); setSubject(""); setBody(""); onGenerate({ candidates, jobTitle, companyName, tone }); }} disabled={generating || !jobTitle} style={{ padding: "12px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, background: generating ? "rgba(99,102,241,0.5)" : "linear-gradient(135deg, #6366f1, #8b5cf6)", border: "none", color: "white", cursor: generating ? "default" : "pointer", fontFamily: "inherit", opacity: !jobTitle ? 0.4 : 1 }}>
          {generating ? <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><span className="gen-spinner" />Writing...</span> : "✦ Generate with AI"}
        </button>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
          <div style={{ color: "#64748b", fontSize: 12, marginBottom: 8 }}>{cwe.length} recipient{cwe.length !== 1 ? "s" : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
            {cwe.map((c, i) => (
              <div key={c.id} onClick={() => setCurrentPreview(i)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, background: currentPreview === i ? "rgba(99,102,241,0.1)" : "transparent", border: currentPreview === i ? "1px solid rgba(99,102,241,0.2)" : "1px solid transparent", cursor: "pointer" }}>
                <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: `hsl(${(i * 67 + 200) % 360}, 45%, 45%)`, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 10, fontWeight: 600 }}>{c.full_name.split(" ").map(n => n[0]).join("")}</div>
                <div style={{ minWidth: 0 }}><div style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.full_name}</div><div style={{ color: "#475569", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.current_position}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={onBack} style={{ background: "none", border: "none", color: "#64748b", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>← Back to candidates</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { if (p) onSend({ to: p.email, subject: merge(subject), body: merge(body), candidateName: p.full_name, candidateId: p.id, mode: "single" }); }}
              disabled={!subject || !body || !cwe.length || generating || isSending}
              style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: (!subject || !body || generating || isSending) ? "rgba(52,211,153,0.2)" : "#34d399", border: "none", color: (!subject || !body || generating || isSending) ? "rgba(255,255,255,0.3)" : "#022c22", cursor: (!subject || !body || generating || isSending) ? "default" : "pointer", fontFamily: "inherit" }}>
              {isSending ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span className="gen-spinner" style={{ width: 12, height: 12, borderTopColor: "#022c22", borderColor: "rgba(0,0,0,0.2)" }} />Sending...</span> : `Draft to ${p?.full_name?.split(" ")[0] || "recipient"} →`}
            </button>
            {cwe.length > 1 && (
              <button onClick={() => {
                cwe.forEach((c, i) => {
                  setTimeout(() => {
                    const sub = subject.replace(/\{name\}/g, c.full_name?.split(" ")[0]).replace(/\{first_name\}/g, c.full_name?.split(" ")[0]);
                    const bod = body.replace(/\{name\}/g, c.full_name?.split(" ")[0]).replace(/\{first_name\}/g, c.full_name?.split(" ")[0]).replace(/\{position\}/g, c.current_position || "").replace(/\{company\}/g, c.current_company || "");
                    onSend({ to: c.email, subject: sub, body: bod, candidateName: c.full_name, candidateId: c.id, mode: "bulk" });
                  }, i * 1500);
                });
              }}
                disabled={!subject || !body || generating || isSending}
                style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: (!subject || !body || generating || isSending) ? "rgba(99,102,241,0.2)" : "linear-gradient(135deg, #6366f1, #8b5cf6)", border: "none", color: "white", cursor: (!subject || !body || generating || isSending) ? "default" : "pointer", fontFamily: "inherit", opacity: (!subject || !body || generating || isSending) ? 0.4 : 1 }}>
                Draft all {cwe.length} →
              </button>
            )}
          </div>
        </div>

        <div style={{ flex: 1, background: "rgba(255,255,255,0.02)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", padding: 28, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.05em" }}>TO</label>
            <div style={{ color: "#cbd5e1", fontSize: 14, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>{p?.email || "No recipient"}</span>
              {cwe.length > 1 && <Badge variant="muted">+{cwe.length - 1} more</Badge>}
            </div>
          </div>
          <div>
            <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.05em" }}>SUBJECT</label>
            <input value={merge(subject)} onChange={(e) => { setEdited(true); setSubject(e.target.value); }} placeholder="Subject line..." style={{ width: "100%", padding: "10px 0", background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#f1f5f9", fontSize: 15, fontWeight: 500, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <label style={{ display: "block", color: "#94a3b8", fontSize: 11, fontWeight: 500, marginBottom: 6, letterSpacing: "0.05em" }}>
              BODY {generating && <span style={{ color: "#818cf8", marginLeft: 8, fontWeight: 400, fontStyle: "italic", textTransform: "none", letterSpacing: 0, animation: "pulse 1.5s infinite" }}>streaming...</span>}
            </label>
            <textarea value={merge(body)} onChange={(e) => { setEdited(true); setBody(e.target.value); }}
              placeholder="Enter a job title and click '✦ Generate with AI' — the email streams in real-time."
              style={{ width: "100%", height: "100%", minHeight: 250, padding: "12px 0", background: "transparent", border: "none", color: generating ? "#a5b4fc" : "#cbd5e1", fontSize: 14, lineHeight: 1.7, outline: "none", fontFamily: "'Instrument Sans', sans-serif", resize: "none", boxSizing: "border-box" }} />
            {generating && <div style={{ position: "absolute", bottom: 8, right: 0, width: 6, height: 18, background: "#818cf8", borderRadius: 2, animation: "blink 0.6s step-end infinite" }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SentLog({ sentEmails }) {
  if (!sentEmails.length) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, color: "#475569" }}>
      <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>📭</div>
      <div style={{ fontSize: 15, fontWeight: 500 }}>No drafts created yet</div>
      <div style={{ fontSize: 13, marginTop: 4, color: "#334155" }}>Drafts will appear in your Gmail ready to send</div>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ padding: "12px 16px", background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 10, color: "#34d399", fontSize: 13, display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>💡</span> Drafts are saved in your Gmail — open Gmail to review and send them
      </div>
      {sentEmails.map(e => (
        <div key={e.id} style={{ padding: "16px 20px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ color: "#f1f5f9", fontSize: 14, fontWeight: 500 }}>{e.candidateName}</div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>{e.to} · {e.subject}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Badge variant={e.status === "success" ? "success" : e.status === "error" ? "error" : "warning"}>{e.status === "success" ? "Drafted" : e.status === "error" ? "Failed" : "Pending"}</Badge>
            {e.logged && <Badge variant="info">Logged</Badge>}
            <span style={{ color: "#475569", fontSize: 11 }}>{e.sentAt}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Fetch candidates from Manatal via Anthropic API + MCP
async function fetchCandidatesFromManatal(page = 1, pageSize = 20, filters = {}) {
  const toolParams = { page, page_size: pageSize };
  if (filters.source_type && filters.source_type !== "all") {
    toolParams.source_type = filters.source_type;
  }
  if (filters.search) {
    toolParams.full_name = filters.search;
    toolParams.case_insensitive = true;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `Use the candidates_list tool with these exact parameters: ${JSON.stringify(toolParams)}. Return ONLY the raw JSON result from the tool, no commentary.`
      }],
      mcp_servers: [MANATAL_MCP],
    }),
  });

  const data = await res.json();

  const toolResult = data.content?.find(b => b.type === "mcp_tool_result");
  if (toolResult?.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(toolResult.content[0].text);
      return {
        candidates: parsed.results || [],
        totalCount: parsed.count || 0,
        hasNext: !!parsed.next,
        hasPrev: !!parsed.previous,
      };
    } catch (e) {
      console.error("Failed to parse Manatal response:", e);
    }
  }

  const textBlock = data.content?.find(b => b.type === "text");
  if (textBlock?.text) {
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*"results"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          candidates: parsed.results || [],
          totalCount: parsed.count || 0,
          hasNext: !!parsed.next,
          hasPrev: !!parsed.previous,
        };
      }
    } catch (e) {}
  }

  throw new Error("Could not fetch candidates from Manatal");
}

function App() {
  const [tab, setTab] = useState("candidates");
  const [candidates, setCandidates] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [composeTargets, setComposeTargets] = useState([]);
  const [sentEmails, setSentEmails] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [sendingStatus, setSendingStatus] = useState("idle");
  const [streamedSubject, setStreamedSubject] = useState("");
  const [streamedBody, setStreamedBody] = useState("");
  const [filterSource, setFilterSource] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [toasts, setToasts] = useState([]);
  const PAGE_SIZE = 20;

  const addToast = (t) => { setToasts(prev => [...prev, t]); setTimeout(() => setToasts(prev => prev.slice(1)), 4000); };

  const loadCandidates = useCallback(async (page = 1, filters = {}) => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchCandidatesFromManatal(page, PAGE_SIZE, filters);
      setCandidates(result.candidates);
      setTotalCount(result.totalCount);
      setHasNext(result.hasNext);
      setHasPrev(result.hasPrev);
      setCurrentPage(page);
    } catch (err) {
      console.error("Load error:", err);
      setLoadError(err.message);
      addToast({ title: "Failed to load candidates", detail: err.message, status: "error" });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCandidates(1, { source_type: "all", search: "" });
  }, []);

  const applyFilters = (source, search) => {
    setSelected(new Set());
    loadCandidates(1, { source_type: source, search });
  };

  const handleSourceFilter = (source) => {
    setFilterSource(source);
    applyFilters(source, searchTerm);
  };

  const handleSearch = () => {
    setSearchTerm(searchInput);
    applyFilters(filterSource, searchInput);
  };

  const handlePageChange = (newPage) => {
    setSelected(new Set());
    loadCandidates(newPage, { source_type: filterSource, search: searchTerm });
  };

  const toggleSelect = useCallback((id) => { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }, []);
  const selectAll = () => { setSelected(prev => prev.size === candidates.length ? new Set() : new Set(candidates.map(c => c.id))); };

  const handleComposeSingle = (c) => { setComposeTargets([c]); setStreamedSubject(""); setStreamedBody(""); setTab("compose"); };
  const handleComposeSelected = () => { setComposeTargets(candidates.filter(c => selected.has(c.id))); setStreamedSubject(""); setStreamedBody(""); setTab("compose"); };

  const handleGenerate = async ({ candidates: cands, jobTitle, companyName, tone }) => {
    setGenerating(true); setStreamedSubject(""); setStreamedBody("");
    const ctx = cands.filter(c => c.email).slice(0, 3).map(c => `${c.full_name}: ${c.current_position} at ${c.current_company}${c.description ? " — " + c.description.substring(0, 80) : ""}`).join("; ");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, stream: true,
          messages: [{ role: "user", content: `Write a recruiting email. Return ONLY JSON: {"subject":"...","body":"..."}\nRole: ${jobTitle} at ${companyName || "[Company]"}. Tone: ${tone}. Candidates: ${ctx}\nMerge vars: {name} {position} {company}. Under 100 words. Personal, compelling CTA. No "I came across your profile." No markdown/backticks.` }] }),
      });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let full = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        for (const line of dec.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const d = line.slice(6).trim(); if (d === "[DONE]") continue;
          try {
            const p = JSON.parse(d);
            if (p.type === "content_block_delta" && p.delta?.text) {
              full += p.delta.text;
              try {
                const sm = full.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                if (sm) setStreamedSubject(sm[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
                const bi = full.indexOf('"body"'); if (bi !== -1) { const ac = full.indexOf(":", bi); if (ac !== -1) { const aq = full.indexOf('"', ac + 1); if (aq !== -1) { let bc = full.substring(aq + 1); const cq = bc.lastIndexOf('"'); if (cq > 0) bc = bc.substring(0, cq); setStreamedBody(bc.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t")); } } }
              } catch (e) {}
            }
          } catch (e) {}
        }
      }
      try { const parsed = JSON.parse(full.replace(/```json|```/g, "").trim()); setStreamedSubject(parsed.subject || ""); setStreamedBody(parsed.body || ""); } catch (e) {}
    } catch (err) {
      setStreamedSubject("Opportunity — {name}");
      setStreamedBody("Hi {name},\n\nYour experience as {position} at {company} is impressive. We have a role that could be a great fit.\n\nWould you be open to a quick chat this week?\n\nBest regards");
    }
    setGenerating(false);
  };

  const handleSend = async ({ to, subject, body, candidateName, candidateId }) => {
    setSendingStatus("sending");
    const entryId = Math.random().toString(36).substr(2, 9);
    const entry = { id: entryId, to, subject, body, candidateName, candidateId, sentAt: new Date().toLocaleString(), status: "pending", logged: false };
    setSentEmails(prev => [entry, ...prev]);
    addToast({ title: `Creating draft for ${candidateName}...`, status: "loading" });

    try {
      const draftRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 300,
          messages: [{ role: "user", content: `Create a Gmail draft to ${to} with subject "${subject}" and body:\n\n${body}\n\nUse the gmail_create_draft tool. Just create the draft, no explanation needed.` }],
          mcp_servers: [GMAIL_MCP],
        }),
      });
      const draftData = await draftRes.json();
      const draftSuccess = draftData.content?.some(b => b.type === "mcp_tool_result" || b.type === "text");

      if (draftSuccess) {
        setSentEmails(prev => prev.map(e => e.id === entryId ? { ...e, status: "success" } : e));
        addToast({ title: `Draft created for ${candidateName}`, detail: "Check your Gmail drafts", status: "success" });
      } else {
        throw new Error("Draft creation failed");
      }

      try {
        await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: API_HEADERS,
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514", max_tokens: 300,
            messages: [{ role: "user", content: `Add a note to candidate ${candidateId} that says: "Outreach email drafted on ${new Date().toLocaleDateString()} — Subject: ${subject} — Sent to: ${to}". Use the candidates_notes_create tool.` }],
            mcp_servers: [MANATAL_MCP],
          }),
        });
        setSentEmails(prev => prev.map(e => e.id === entryId ? { ...e, logged: true } : e));
        addToast({ title: `Logged to Manatal`, detail: candidateName, status: "success" });
      } catch (noteErr) {
        console.error("Manatal note error:", noteErr);
      }

    } catch (err) {
      console.error("Send error:", err);
      setSentEmails(prev => prev.map(e => e.id === entryId ? { ...e, status: "error" } : e));
      addToast({ title: `Failed for ${candidateName}`, detail: err.message, status: "error" });
    }
    setSendingStatus("idle");
  };

  const startPage = (currentPage - 1) * PAGE_SIZE + 1;
  const endPage = Math.min(currentPage * PAGE_SIZE, totalCount);

  return (
    <div style={{ fontFamily: "'Instrument Sans', 'DM Sans', sans-serif", background: "#0a0e1a", minHeight: "100vh", color: "#e2e8f0", position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        input::placeholder, textarea::placeholder { color: #334155; }
        .gen-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top: 2px solid white; border-radius: 50%; animation: spin 0.6s linear infinite; display: inline-block; }
      `}</style>
      <div style={{ position: "absolute", top: -200, right: -200, width: 600, height: 600, background: "radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />
      <StatusToast items={toasts} />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>✦</div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc", margin: 0, letterSpacing: "-0.02em" }}>Outreach Hub</h1>
              <Badge variant="success">v4 — live data</Badge>
            </div>
            <p style={{ color: "#475569", fontSize: 13, margin: 0, paddingLeft: 42 }}>Live from Manatal · Gmail drafts · Auto-logging</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {["Manatal", "Gmail", "Claude AI"].map(n => (
              <span key={n} style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#34d399", animation: "pulse 2s infinite" }} />
                <span style={{ color: "#475569", fontSize: 12 }}>{n}</span>
              </span>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
          {[
            { label: "Total Candidates", value: totalCount.toLocaleString(), sub: "In Manatal", color: "#6366f1" },
            { label: "With Email", value: candidates.filter(c => c.email).length, sub: "This page", color: "#34d399" },
            { label: "Selected", value: selected.size, sub: "For outreach", color: "#f59e0b" },
            { label: "Drafted", value: sentEmails.filter(e => e.status === "success").length, sub: "In Gmail", color: "#38bdf8" },
          ].map((s, i) => (
            <div key={i} style={{ padding: "18px 20px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ color: "#64748b", fontSize: 11, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}>{s.label}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: s.color, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
              <div style={{ color: "#334155", fontSize: 11, marginTop: 2 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 4 }}>
            {["candidates", "compose", "sent"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 500, background: tab === t ? "rgba(99,102,241,0.15)" : "transparent", border: "none", color: tab === t ? "#818cf8" : "#475569", cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>
                {t === "sent" ? `drafts${sentEmails.length ? ` (${sentEmails.length})` : ""}` : t}
              </button>
            ))}
          </div>
          {tab === "candidates" && selected.size > 0 && (
            <button onClick={handleComposeSelected} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", border: "none", color: "white", cursor: "pointer", fontFamily: "inherit" }}>✦ Compose for {selected.size} selected</button>
          )}
        </div>

        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {tab === "candidates" && (
            <div style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                      placeholder="Search by name..." style={{ padding: "7px 12px", width: 200, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, color: "#f1f5f9", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
                    <button onClick={handleSearch} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 500, background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", color: "#818cf8", cursor: "pointer", fontFamily: "inherit" }}>Search</button>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {["all", "applied", "sourced"].map(f => (
                      <button key={f} onClick={() => handleSourceFilter(f)} style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 500, background: filterSource === f ? "rgba(99,102,241,0.15)" : "transparent", border: filterSource === f ? "1px solid rgba(99,102,241,0.3)" : "1px solid rgba(255,255,255,0.06)", color: filterSource === f ? "#818cf8" : "#475569", cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>{f}</button>
                    ))}
                  </div>
                </div>
                <button onClick={selectAll} style={{ background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{selected.size === candidates.length && candidates.length > 0 ? "Deselect all" : "Select all"}</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "40px 2fr 1.5fr 1.5fr 1fr 100px", padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#475569", fontSize: 11, fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase" }}><div></div><div>Candidate</div><div>Role</div><div>Location</div><div>Source</div><div></div></div>

              {loading ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "60px 0", gap: 12 }}>
                  <span className="gen-spinner" />
                  <span style={{ color: "#64748b", fontSize: 14 }}>Loading candidates from Manatal...</span>
                </div>
              ) : loadError ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 0", gap: 12 }}>
                  <span style={{ color: "#ef4444", fontSize: 14 }}>Failed to load candidates</span>
                  <span style={{ color: "#475569", fontSize: 12 }}>{loadError}</span>
                  <button onClick={() => loadCandidates(currentPage, { source_type: filterSource, search: searchTerm })} style={{ marginTop: 8, padding: "8px 16px", borderRadius: 8, fontSize: 13, background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", color: "#818cf8", cursor: "pointer", fontFamily: "inherit" }}>Retry</button>
                </div>
              ) : candidates.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "60px 0", color: "#475569", fontSize: 14 }}>No candidates found</div>
              ) : (
                candidates.map(c => <CandidateRow key={c.id} candidate={c} selected={selected.has(c.id)} onToggle={toggleSelect} onCompose={handleComposeSingle} />)
              )}

              <div style={{ padding: "14px 20px", borderTop: "1px solid rgba(255,255,255,0.04)", color: "#475569", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>{!loading && `Showing ${startPage}–${endPage} of ${totalCount.toLocaleString()}`}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => handlePageChange(currentPage - 1)} disabled={!hasPrev || loading}
                    style={{ padding: "5px 14px", borderRadius: 6, fontSize: 12, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", color: hasPrev && !loading ? "#cbd5e1" : "#334155", cursor: hasPrev && !loading ? "pointer" : "default", fontFamily: "inherit" }}>← Prev</button>
                  <span style={{ padding: "5px 12px", color: "#64748b", fontSize: 12 }}>Page {currentPage}</span>
                  <button onClick={() => handlePageChange(currentPage + 1)} disabled={!hasNext || loading}
                    style={{ padding: "5px 14px", borderRadius: 6, fontSize: 12, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", color: hasNext && !loading ? "#cbd5e1" : "#334155", cursor: hasNext && !loading ? "pointer" : "default", fontFamily: "inherit" }}>Next →</button>
                </div>
              </div>
            </div>
          )}
          {tab === "compose" && <div style={{ minHeight: 500 }}><EmailComposer candidates={composeTargets.length > 0 ? composeTargets : candidates.filter(c => selected.has(c.id))} onSend={handleSend} onBack={() => setTab("candidates")} generating={generating} onGenerate={handleGenerate} streamedSubject={streamedSubject} streamedBody={streamedBody} sendingStatus={sendingStatus} /></div>}
          {tab === "sent" && <SentLog sentEmails={sentEmails} />}
        </div>
        <div style={{ textAlign: "center", marginTop: 32, color: "#1e293b", fontSize: 11 }}>Outreach Hub v4 · Live Manatal Data · Gmail Drafts · Claude AI</div>
      </div>
    </div>
  );
}

export default App;
