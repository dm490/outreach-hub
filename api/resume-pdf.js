import PDFDocument from "pdfkit";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const c = req.body;
  if (!c || !c.full_name) return res.status(400).json({ error: "Candidate data required" });

  try {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 55, right: 55 } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => {
      const pdf = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=\"" + c.full_name.replace(/[^a-zA-Z0-9 ]/g, "") + " - Resume.pdf\"");
      res.status(200).send(pdf);
    });

    const W = 502; // usable width (612 - 55 - 55)
    const NAVY = "#1e293b";
    const DARK = "#334155";
    const MED = "#475569";
    const ACCENT = "#6366f1";
    const DIVIDER = "#cbd5e1";

    // === HEADER ===
    doc.rect(0, 0, 612, 110).fill("#0f172a");
    doc.fillColor("#f8fafc").font("Helvetica-Bold").fontSize(26)
      .text(c.full_name, 55, 30, { width: W });

    if (c.current_position || c.current_company) {
      doc.fillColor("#94a3b8").font("Helvetica").fontSize(13)
        .text(
          (c.current_position || "") + (c.current_company ? " at " + c.current_company : ""),
          55, 62, { width: W }
        );
    }

    // Contact line
    const contacts = [];
    if (c.email) contacts.push(c.email);
    if (c.phone_number) contacts.push(c.phone_number);
    if (c.linkedin) contacts.push(c.linkedin);
    if (contacts.length > 0) {
      doc.fillColor("#64748b").fontSize(10)
        .text(contacts.join("  |  "), 55, 85, { width: W });
    }

    let y = 125;

    // Helper: section header
    function sectionHeader(title) {
      if (y > 680) { doc.addPage(); y = 50; }
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(11)
        .text(title.toUpperCase(), 55, y, { width: W });
      y += 16;
      doc.moveTo(55, y).lineTo(55 + W, y).lineWidth(0.75).strokeColor(DIVIDER).stroke();
      y += 10;
    }

    // Helper: check page break
    function checkPage(needed) {
      if (y + needed > 720) { doc.addPage(); y = 50; }
    }

    // === SUMMARY ===
    if (c.candidate_summary) {
      sectionHeader("Professional Summary");
      checkPage(60);
      doc.fillColor(DARK).font("Helvetica").fontSize(10)
        .text(c.candidate_summary.substring(0, 800), 55, y, { width: W, lineGap: 3 });
      y = doc.y + 18;
    }

    // === SKILLS ===
    if (c.skills && c.skills.length > 0) {
      sectionHeader("Skills & Expertise");
      checkPage(40);
      // Render as pill-style tags
      const skills = c.skills.slice(0, 25);
      let xPos = 55;
      const pillH = 20;
      const pillPad = 10;
      const gap = 6;

      for (const skill of skills) {
        const tw = doc.font("Helvetica").fontSize(9).widthOfString(skill);
        const pillW = tw + pillPad * 2;
        if (xPos + pillW > 55 + W) { xPos = 55; y += pillH + gap; checkPage(pillH + gap); }
        doc.roundedRect(xPos, y, pillW, pillH, 4).fill("#eef2ff");
        doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9)
          .text(skill, xPos + pillPad, y + 5, { width: pillW - pillPad * 2 });
        xPos += pillW + gap;
      }
      y += pillH + 16;
    }

    // === EXPERIENCE ===
    if (c.experience && c.experience.length > 0) {
      sectionHeader("Professional Experience");
      for (const exp of c.experience.slice(0, 8)) {
        checkPage(70);
        const title = exp.designation || exp.title || "Role";
        const company = exp.company || "";
        const fromParts = (exp.from || []).filter(Boolean);
        const toParts = exp.current ? ["Present"] : (exp.to || []).filter(Boolean);
        const dateStr = fromParts.length > 0
          ? fromParts.join("/") + " - " + (toParts.join("/") || "N/A")
          : "";

        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11)
          .text(title, 55, y, { width: W * 0.65 });
        if (dateStr) {
          doc.fillColor(MED).font("Helvetica").fontSize(9)
            .text(dateStr, 55 + W * 0.65, y + 2, { width: W * 0.35, align: "right" });
        }
        y = doc.y + 2;
        if (company) {
          doc.fillColor(ACCENT).font("Helvetica").fontSize(10)
            .text(company, 55, y, { width: W });
          y = doc.y + 4;
        }
        if (exp.description) {
          const desc = exp.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          if (desc.length > 5) {
            checkPage(40);
            doc.fillColor(DARK).font("Helvetica").fontSize(9.5)
              .text(desc.substring(0, 500), 55, y, { width: W, lineGap: 2.5 });
            y = doc.y + 4;
          }
        }
        y += 10;
      }
    }

    // === EDUCATION ===
    if (c.education && c.education.length > 0) {
      sectionHeader("Education");
      for (const edu of c.education.slice(0, 5)) {
        checkPage(40);
        const degree = (edu.degree || "") + (edu.specialization ? " in " + edu.specialization : "");
        const school = edu.school || "";
        if (degree) {
          doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5)
            .text(degree, 55, y, { width: W });
          y = doc.y + 2;
        }
        if (school) {
          doc.fillColor(MED).font("Helvetica").fontSize(10)
            .text(school, 55, y, { width: W });
          y = doc.y;
        }
        y += 12;
      }
    }

    // === FOOTER ===
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fillColor("#94a3b8").font("Helvetica").fontSize(8)
        .text(
          "Prepared by David Joseph & Company",
          55, 740, { width: W, align: "center" }
        );
    }

    doc.end();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
