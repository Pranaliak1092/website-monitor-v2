/**
 * reporter.js
 * ──────────────────────────────────────────────────────────────────
 * Builds and sends professional, management-friendly crawl reports.
 *
 * Design goals:
 *  - ONE section per website, clean and scannable
 *  - Each broken link appears EXACTLY ONCE, with all source pages grouped under it
 *  - Priority badges: 🟢 Healthy / 🟡 Warning / 🔴 Critical
 *  - Final fleet summary when multiple sites are scanned
 *  - Zero repeated spam / zero raw developer logs in the email
 * ──────────────────────────────────────────────────────────────────
 */

"use strict";

const nodemailer = require("nodemailer");

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_LABEL = {
  "not-found":    "404 Not Found",
  "soft-404":     "404 Not Found",
  "forbidden":    "403 Access Denied",
  "server-error": "Server Error (5xx)",
  "timeout":      "Timeout / Unreachable",
};

// Priority thresholds (number of unique broken links)
const PRIORITY = {
  HEALTHY:  { label: "🟢 HEALTHY",  max: 0  },
  WARNING:  { label: "🟡 WARNING",  max: 5  },
  CRITICAL: { label: "🔴 CRITICAL", max: Infinity },
};

// Line separators
const SEP_HEAVY = "══════════════════════════════════════════════════════";
const SEP_LIGHT = "──────────────────────────────────────────────────────";

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryLabel(cat) {
  return CATEGORY_LABEL[cat] || cat;
}

/**
 * Derives a priority label from the number of unique broken links.
 */
function getPriority(brokenCount) {
  if (brokenCount === 0) return PRIORITY.HEALTHY.label;
  if (brokenCount <= 5)  return PRIORITY.WARNING.label;
  return PRIORITY.CRITICAL.label;
}

/**
 * Returns the raw priority tier for summary counting.
 * @returns {'healthy'|'warning'|'critical'}
 */
function getPriorityTier(brokenCount) {
  if (brokenCount === 0) return "healthy";
  if (brokenCount <= 5)  return "warning";
  return "critical";
}

/**
 * Formats a response time number into a clean string.
 * @param {number|null} ms  Milliseconds, or null if unknown
 */
function fmtTime(ms) {
  if (ms == null) return "N/A";
  return `${ms}ms`;
}

/**
 * Shortens a full URL to a relative path for compact display in "Found on" lists.
 * e.g. https://site.com/en/admissions/  →  /en/admissions/
 */
function toRelativePath(fullUrl) {
  try {
    const u = new URL(fullUrl);
    const path = u.pathname + u.search;
    return path === "/" ? "Homepage" : path;
  } catch {
    return fullUrl;
  }
}

// ── Single-site report block ──────────────────────────────────────────────────

/**
 * Builds the text block for ONE website's report.
 * @param {object} report   CrawlReport from crawler.crawlDomain()
 * @returns {string}
 */
function buildSiteBlock(report) {
  const { rootUrl, pagesScanned, broken, responseTimeMs } = report;

  const totalBroken = broken.length;
  const priority    = getPriority(totalBroken);
  const lines       = [];

  // ── Site header ──────────────────────────────────────────────────────────────
  lines.push(SEP_HEAVY);
  lines.push(rootUrl);
  lines.push(SEP_HEAVY);
  lines.push("");
  lines.push(`Status          : ${priority}`);
  lines.push(`Response Time   : ${fmtTime(responseTimeMs)}`);
  lines.push(`Pages Crawled   : ${pagesScanned}`);
  lines.push(`Broken Links    : ${totalBroken}`);
  lines.push("");

  if (totalBroken === 0) {
    lines.push("✅ All internal links are working correctly.");
    lines.push("");
    return lines.join("\n");
  }

  // ── Broken link details ──────────────────────────────────────────────────────
  broken.forEach((link, idx) => {
    lines.push(SEP_LIGHT);
    lines.push("");

    lines.push(`${idx + 1}. Broken Button Detected`);
    lines.push("");
    lines.push(`   Button Text :`);
    lines.push(`   "${link.text}"`);
    lines.push("");
    lines.push(`   Broken Redirect URL :`);
    lines.push(`   ${link.url}`);
    lines.push("");
    lines.push(`   Error :`);
    lines.push(`   ${categoryLabel(link.category)}`);
    lines.push("");

    if (link.aiReason) {
      lines.push(`   🤖 Smart AI Analysis :`);
      lines.push(`   "${link.aiReason}"`);
      lines.push("");
    }

    const pageCount = link.foundOnPages.length;
    lines.push(`   Button Found On Pages (${pageCount}):`);
    lines.push("");
    link.foundOnPages.forEach((page) => {
      lines.push(`   • ${page}`);
      lines.push("");
    });
  });

  lines.push(SEP_LIGHT);
  lines.push("");

  return lines.join("\n");
}

// ── Fleet summary block ───────────────────────────────────────────────────────

/**
 * Builds the final "Overall Summary" block shown at the top of multi-site emails.
 * @param {object[]} reports   Array of CrawlReport objects
 * @returns {string}
 */
function buildFleetSummary(reports) {
  const counts = { healthy: 0, warning: 0, critical: 0 };
  let totalPages  = 0;
  let totalBroken = 0;

  reports.forEach((r) => {
    const tier = getPriorityTier(r.broken.length);
    counts[tier]++;
    totalPages  += r.pagesScanned;
    totalBroken += r.broken.length;
  });

  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const lines = [];
  lines.push(SEP_HEAVY);
  lines.push("     WEBSITE HEALTH REPORT — OVERALL SUMMARY");
  lines.push(SEP_HEAVY);
  lines.push("");
  lines.push(`Scan Date         : ${now}`);
  lines.push(`Total Sites       : ${reports.length}`);
  lines.push(`Total Pages       : ${totalPages}`);
  lines.push(`Total Broken Links: ${totalBroken}`);
  lines.push("");
  lines.push("Site Status Breakdown:");
  lines.push(`  🟢 Healthy   : ${counts.healthy}`);
  lines.push(`  🟡 Warning   : ${counts.warning}`);
  lines.push(`  🔴 Critical  : ${counts.critical}`);
  lines.push("");
  lines.push(SEP_HEAVY);
  lines.push("");

  return lines.join("\n");
}

// ── Full email body builder ───────────────────────────────────────────────────

/**
 * Builds the full email body for ALL sites in one scan run.
 * @param {object[]} reports  Array of CrawlReport objects
 * @returns {string}
 */
function buildEmailBody(reports) {
  const lines = [];

  // Fleet summary at top (always shown, even for a single site)
  lines.push(buildFleetSummary(reports));

  // Individual site blocks
  reports.forEach((r) => {
    lines.push(buildSiteBlock(r));
  });

  lines.push("─".repeat(54));
  lines.push("This report was generated automatically by WebsiteMonitor.");

  return lines.join("\n");
}

// ── HTML email body builder ───────────────────────────────────────────────────

/**
 * Builds the beautifully formatted HTML email body for ALL sites in one scan run.
 * @param {object[]} reports  Array of CrawlReport objects
 * @returns {string}
 */
function buildEmailHtml(reports) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  
  const counts = { healthy: 0, warning: 0, critical: 0 };
  let totalPages = 0;
  let totalBroken = 0;

  reports.forEach((r) => {
    const tier = getPriorityTier(r.broken.length);
    counts[tier]++;
    totalPages  += r.pagesScanned;
    totalBroken += r.broken.length;
  });

  const overallStatus = totalBroken === 0 
    ? { label: "HEALTHY", color: "healthy", badge: "badge-healthy" } 
    : totalBroken <= 10 
      ? { label: "WARNING", color: "warning", badge: "badge-warning" } 
      : { label: "CRITICAL", color: "critical", badge: "badge-critical" };

  let siteRowsHtml = "";
  reports.forEach((r) => {
    const siteBroken = r.broken.length;
    const siteTier = getPriorityTier(siteBroken);
    const badgeClass = siteTier === "healthy" ? "badge-healthy" : siteTier === "warning" ? "badge-warning" : "badge-critical";
    const badgeLabel = siteTier.toUpperCase();
    const respTime = r.responseTimeMs != null ? `${r.responseTimeMs}ms` : "N/A";
    
    siteRowsHtml += `
      <tr>
        <td style="font-weight: 500;"><a href="${r.rootUrl}" target="_blank" style="color: #1e3a8a; text-decoration: none;">${r.rootUrl}</a></td>
        <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
        <td style="font-weight: 600; color: ${siteBroken > 0 ? '#ef4444' : '#10b981'};">${siteBroken} link${siteBroken === 1 ? '' : 's'}</td>
        <td style="color: #64748b; font-family: monospace;">${r.pagesScanned}</td>
        <td style="color: #64748b; font-family: monospace;">${respTime}</td>
      </tr>
    `;
  });

  let detailsHtml = "";
  const sitesWithIssues = reports.filter(r => r.broken.length > 0);
  
  if (sitesWithIssues.length > 0) {
    sitesWithIssues.forEach(r => {
      const siteBroken = r.broken.length;
      const siteTier = getPriorityTier(siteBroken);
      const badgeClass = siteTier === "healthy" ? "badge-healthy" : siteTier === "warning" ? "badge-warning" : "badge-critical";
      
      detailsHtml += `
        <div class="issue-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
          <div class="issue-card-header" style="padding-bottom: 10px; margin-bottom: 14px; border-bottom: 2px solid #f1f5f9;">
            <span style="font-size: 16px; font-weight: 700; color: #1e3a8a;">${r.rootUrl}</span>
            <span class="badge ${badgeClass}" style="float: right; margin-top: 2px;">${siteTier.toUpperCase()}</span>
            <div style="clear: both;"></div>
          </div>
      `;

      r.broken.forEach((link, idx) => {
        const itemClass = link.category === "timeout" || link.category === "forbidden" ? "issue-item warning" : "issue-item";
        const titleClass = link.category === "timeout" || link.category === "forbidden" ? "issue-title warning" : "issue-title";
        const errorLabel = categoryLabel(link.category);
        const emoji = link.category === "timeout" || link.category === "forbidden" ? "🟡" : "🔴";
        
        let aiReasonHtml = "";
        if (link.aiReason) {
          aiReasonHtml = `
            <div class="ai-block" style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 6px; padding: 12px; margin-top: 12px; font-size: 13px; color: #5b21b6; line-height: 1.45;">
              ✨ <strong>Smart AI Analysis:</strong> ${link.aiReason}
            </div>
          `;
        }

        const pagesHtml = link.foundOnPages.map(page => `<li><a href="${page}" target="_blank" style="color: #475569; text-decoration: none;">${toRelativePath(page)}</a></li>`).join('');

        detailsHtml += `
          <div class="${itemClass}" style="margin-bottom: 16px; padding: 14px; border-radius: 0 6px 6px 0; ${
            link.category === "timeout" || link.category === "forbidden"
              ? "background: #fffdf5; border-left: 4px solid #f59e0b;"
              : "background: #fff8f8; border-left: 4px solid #ef4444;"
          }">
            <span class="${titleClass}" style="font-weight: 700; font-size: 13.5px; display: block; margin-bottom: 10px; ${
              link.category === "timeout" || link.category === "forbidden" ? "color: #b5600b;" : "color: #b91c1c;"
            }">${emoji} ${idx + 1}. Broken Connection / Link</span>
            
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="width: 150px; font-weight: 700; color: #475569; padding: 4px 0; vertical-align: top;">Button/Anchor Text</td>
                <td style="color: #0f172a; font-weight: 600; padding: 4px 0; vertical-align: top;">"${link.text}"</td>
              </tr>
              <tr>
                <td style="font-weight: 700; color: #475569; padding: 4px 0; vertical-align: top;">Target Redirect URL</td>
                <td style="padding: 4px 0; vertical-align: top;"><a href="${link.url}" target="_blank" style="color: #b91c1c; text-decoration: underline; font-family: Consolas, Monaco, monospace; word-break: break-all;">${link.url}</a></td>
              </tr>
              <tr>
                <td style="font-weight: 700; color: #475569; padding: 4px 0; vertical-align: top;">Error Response</td>
                <td style="font-weight: 600; color: #b91c1c; padding: 4px 0; vertical-align: top; font-family: Consolas, Monaco, monospace;">${errorLabel}</td>
              </tr>
            </table>

            ${aiReasonHtml}

            <div class="pages-list" style="margin-top: 12px; background: #f8fafc; border: 1px solid #f1f5f9; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #475569;">
              <strong>Discovered on ${link.foundOnPages.length} page(s):</strong>
              <ul style="margin: 6px 0 0; padding-left: 16px;">
                ${pagesHtml}
              </ul>
            </div>
          </div>
        `;
      });

      detailsHtml += `</div>`;
    });
  } else {
    detailsHtml = `
      <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 24px; text-align: center; color: #065f46; margin-top: 16px;">
        <span style="font-size: 48px; display: block; margin-bottom: 8px;">🎉</span>
        <strong style="font-size: 16px; display: block; margin-bottom: 4px;">All Links are Working!</strong>
        No broken buttons, links, or redirects were found across any of the crawled subdomains.
      </div>
    `;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Website Health Report</title>
  <style>
    .badge { display: inline-block; padding: 4px 8px; border-radius: 9999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; text-align: center; }
    .badge-healthy { background: #d1fae5; color: #065f46; }
    .badge-warning { background: #fef3c7; color: #92400e; }
    .badge-critical { background: #fee2e2; color: #991b1b; }
  </style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 20px; -webkit-font-smoothing: antialiased;">
  <div class="container" style="max-width: 750px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div class="header" style="background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); color: #ffffff; padding: 32px 24px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">🕸️ Website Health Report</h1>
      <p style="margin: 8px 0 0; font-size: 13px; opacity: 0.8;">Automated crawler audit results for Somaiya Web Ecosystem</p>
    </div>
    
    <div class="content" style="padding: 24px;">
      
      <!-- Stats Summary -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 8px; margin-bottom: 24px; table-layout: fixed;">
        <tr>
          <td style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 10px; text-align: center; vertical-align: middle;">
            <span style="font-size: 20px; font-weight: 800; display: block; line-height: 1.2; ${
              overallStatus.color === 'healthy' ? 'color: #10b981;' : overallStatus.color === 'warning' ? 'color: #f59e0b;' : 'color: #ef4444;'
            }">${overallStatus.label}</span>
            <span style="font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-top: 4px; display: block; letter-spacing: 0.5px;">Fleet Status</span>
          </td>
          <td style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 10px; text-align: center; vertical-align: middle;">
            <span style="font-size: 22px; font-weight: 800; color: #0f172a; display: block; line-height: 1.2;">${reports.length}</span>
            <span style="font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-top: 4px; display: block; letter-spacing: 0.5px;">Sites Checked</span>
          </td>
          <td style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 10px; text-align: center; vertical-align: middle;">
            <span style="font-size: 22px; font-weight: 800; color: #0f172a; display: block; line-height: 1.2;">${totalPages}</span>
            <span style="font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-top: 4px; display: block; letter-spacing: 0.5px;">Pages Scanned</span>
          </td>
          <td style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 10px; text-align: center; vertical-align: middle;">
            <span style="font-size: 22px; font-weight: 800; display: block; line-height: 1.2; ${totalBroken > 0 ? 'color: #ef4444;' : 'color: #10b981;'}">${totalBroken}</span>
            <span style="font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-top: 4px; display: block; letter-spacing: 0.5px;">Broken Links</span>
          </td>
        </tr>
      </table>

      <div style="font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin: 28px 0 12px; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">Website Summary</div>
      
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
        <thead>
          <tr style="border-bottom: 2px solid #e2e8f0;">
            <th style="background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px;">Website Domain</th>
            <th style="background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; width: 100px;">Status</th>
            <th style="background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; width: 120px;">Broken Links</th>
            <th style="background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; width: 80px;">Pages</th>
            <th style="background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; width: 100px;">Response</th>
          </tr>
        </thead>
        <tbody>
          ${siteRowsHtml}
        </tbody>
      </table>

      <div style="font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin: 28px 0 12px; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">Audit Findings & Issue Details</div>
      ${detailsHtml}
    </div>
    
    <div class="footer" style="background: #f8fafc; color: #64748b; font-size: 12px; text-align: center; padding: 24px; border-top: 1px solid #e2e8f0; line-height: 1.5;">
      This check was executed on <strong>${now}</strong>.<br>
      Report generated automatically by <strong>Somaiya WebsiteMonitor (v2)</strong>.
    </div>
  </div>
</body>
</html>
  `;
}

// ── Email subject helper ──────────────────────────────────────────────────────

/**
 * Generates an appropriate email subject line for the batch.
 * @param {object[]} reports
 * @returns {string}
 */
function buildSubject(reports) {
  const criticalCount = reports.filter((r) => getPriorityTier(r.broken.length) === "critical").length;
  const warningCount  = reports.filter((r) => getPriorityTier(r.broken.length) === "warning").length;
  const totalBroken   = reports.reduce((sum, r) => sum + r.broken.length, 0);

  if (totalBroken === 0) {
    return `✅ All Clear — ${reports.length} site${reports.length > 1 ? "s" : ""} fully healthy`;
  }
  if (criticalCount > 0) {
    return `🔴 ${criticalCount} Critical + ${warningCount} Warning — Website Health Report`;
  }
  return `🟡 ${warningCount} Warning${warningCount > 1 ? "s" : ""} — ${totalBroken} broken link${totalBroken > 1 ? "s" : ""} detected`;
}

// ── Transporter ───────────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends ONE combined email for all sites scanned in a single run.
 * Call this once after ALL crawls are complete.
 *
 * @param {object[]} reports  Array of CrawlReport objects from crawler.crawlDomain()
 */
async function sendBatchReport(reports) {
  // Console summary (clean — no per-page noise)
  console.log("\n" + "═".repeat(54));
  console.log("  SCAN COMPLETE — SUMMARY");
  console.log("═".repeat(54));
  reports.forEach((r) => {
    const tier  = getPriorityTier(r.broken.length);
    const badge = tier === "healthy" ? "🟢" : tier === "warning" ? "🟡" : "🔴";
    console.log(`${badge} ${r.rootUrl}`);
    console.log(`   Pages: ${r.pagesScanned}  |  Broken: ${r.broken.length}  |  Time: ${fmtTime(r.responseTimeMs)}`);
    if (r.broken.length > 0) {
      r.broken.forEach((link, i) => {
        console.log(`   ❌ [${i + 1}] ${link.text} → ${link.url}`);
      });
    }
    console.log("");
  });

  const subject = buildSubject(reports);
  const body    = buildEmailBody(reports);
  const htmlBody = buildEmailHtml(reports);

  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      process.env.ALERT_EMAILS,
      subject,
      text:    body,
      html:    htmlBody,
    });
    console.log(`📩 Report emailed — Subject: ${subject}\n`);
  } catch (err) {
    console.error("❌ Failed to send email:", err.message);
  }
}

/**
 * Legacy single-report sender (kept for backward compatibility).
 * Wraps the new batch sender.
 * @param {object} report
 */
async function sendReport(report) {
  await sendBatchReport([report]);
}

module.exports = { sendReport, sendBatchReport, buildEmailBody, buildSiteBlock, buildEmailHtml };
