require("dotenv").config();
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "uptime-state.json");

const URLS = (process.env.URLS || "").split(/[,\r\n]+/).map((u) => u.trim()).filter(Boolean);

if (URLS.length === 0) {
  console.error("❌ No URLs configured.");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("⚠️ Error reading state file:", err.message);
  }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("⚠️ Error writing state file:", err.message);
  }
}

function buildAlertHtml(alertQueue) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const cooldownHours = parseFloat(process.env.UPTIME_ALERT_COOLDOWN_HOURS || "6", 10);
  
  let rowsHtml = "";
  alertQueue.forEach((alert) => {
    const typeLabel = alert.type === "NEW_DOWNTIME" 
      ? "🚨 NEW DOWNTIME" 
      : alert.type === "REMINDER" 
        ? "⚠️ STILL DOWN" 
        : "🟢 RECOVERED (UP)";
    
    const labelColor = alert.type === "NEW_DOWNTIME" 
      ? "#dc2626" 
      : alert.type === "REMINDER" 
        ? "#d97706" 
        : "#16a34a";
        
    const badgeBg = alert.type === "NEW_DOWNTIME" 
      ? "#fee2e2" 
      : alert.type === "REMINDER" 
        ? "#fef3c7" 
        : "#d1fae5";

    rowsHtml += `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px; font-weight: 700; color: #1e3a8a;"><a href="${alert.url}" target="_blank" style="color: #1e3a8a; text-decoration: underline;">${alert.url}</a></td>
        <td style="padding: 12px;"><span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: ${badgeBg}; color: ${labelColor};">${typeLabel}</span></td>
        <td style="padding: 12px; font-family: monospace; color: #b91c1c; font-weight: 600;">${alert.code}</td>
        <td style="padding: 12px; color: #475569; font-size: 13px;">${alert.message}</td>
      </tr>
    `;
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Website Status Update Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fcfcfd; color: #1e293b; margin: 0; padding: 20px;">
  <div style="max-width: 700px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #fee2e2; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color: #ffffff; padding: 24px; text-align: center;">
      <span style="font-size: 40px; display: block; margin-bottom: 8px;">📡</span>
      <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">Website Status Update</h1>
      <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.85;">Aggregated status changes and down reminders from the uptime check</p>
    </div>
    
    <div style="padding: 24px;">
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 2px solid #cbd5e1; text-align: left;">
            <th style="padding: 10px 12px; font-weight: 700; color: #475569;">Website</th>
            <th style="padding: 10px 12px; font-weight: 700; color: #475569; width: 180px;">Event</th>
            <th style="padding: 10px 12px; font-weight: 700; color: #475569; width: 100px;">Code</th>
            <th style="padding: 10px 12px; font-weight: 700; color: #475569;">Error/Message</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      
      <div style="margin-top: 24px; padding: 16px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 12.5px; color: #64748b; line-height: 1.6;">
        💡 <strong>Notification Settings:</strong>
        <ul style="margin: 6px 0 0; padding-left: 20px;">
          <li>Notifications are aggregated so you receive exactly one email per check run.</li>
          <li>Repeat alerts for down sites are throttled to once every <strong>${cooldownHours} hours</strong> (configurable via <code>UPTIME_ALERT_COOLDOWN_HOURS</code> in your settings).</li>
        </ul>
      </div>
    </div>
    
    <div style="background: #f8fafc; color: #94a3b8; font-size: 11px; text-align: center; padding: 18px; border-top: 1px solid #e2e8f0; line-height: 1.4;">
      Somaiya UptimeMonitor • Run executed on ${now}<br>
      Automated status tracking system (v2)
    </div>
  </div>
</body>
</html>
  `;
}

async function sendEmail(subject, alertQueue) {
  try {
    const htmlBody = buildAlertHtml(alertQueue);
    const textBody = alertQueue.map(a => `${a.type}: ${a.url} (${a.code}) - ${a.message}`).join('\n');
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ALERT_EMAILS,
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log(`📩 Aggregated email sent: "${subject}"`);
  } catch (err) {
    console.error("❌ Email error:", err.message);
  }
}

function buildSubject(alertQueue) {
  const downNew = alertQueue.filter(a => a.type === "NEW_DOWNTIME").length;
  const reminders = alertQueue.filter(a => a.type === "REMINDER").length;
  const recovered = alertQueue.filter(a => a.type === "RECOVERY").length;
  
  const parts = [];
  if (downNew > 0) parts.push(`🔴 ${downNew} NEW DOWN`);
  if (recovered > 0) parts.push(`🟢 ${recovered} RECOVERED`);
  if (reminders > 0) parts.push(`⚠️ ${reminders} STILL DOWN`);
  
  return `Website Status: ${parts.join(" | ") || "Uptime Update"}`;
}

async function checkWebsite(url) {
  console.log(`🔍 Checking: ${url}`);
  try {
    const res = await axios.get(url, { timeout: 15000 });
    if (res.status >= 200 && res.status < 400) {
      console.log(`✅ ${url} is UP`);
      return { url, status: "UP", message: `HTTP ${res.status}`, code: res.status };
    } else {
      console.log(`🚨 ${url} is DOWN (Status: ${res.status})`);
      return { url, status: "DOWN", message: `HTTP Status ${res.status}`, code: res.status };
    }
  } catch (err) {
    console.log(`🚨 ${url} is DOWN (Error: ${err.message})`);
    return { url, status: "DOWN", message: err.message, code: err.response?.status ?? "TIMEOUT/ERROR" };
  }
}

async function runOnce() {
  console.log("🚀 Starting Uptime Check...");
  
  const state = loadState();
  const cooldownHours = parseFloat(process.env.UPTIME_ALERT_COOLDOWN_HOURS || "6", 10);
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  
  const results = [];
  for (let url of URLS) {
    const res = await checkWebsite(url);
    results.push(res);
  }
  
  const now = Date.now();
  const alertQueue = [];
  
  for (const res of results) {
    const { url, status, message, code } = res;
    const siteState = state[url] || { status: "UP", lastAlertTime: 0 };
    
    if (status === "DOWN") {
      if (siteState.status === "UP") {
        // Newly down
        alertQueue.push({ url, type: "NEW_DOWNTIME", message, code });
        state[url] = { status: "DOWN", lastAlertTime: now, message, code };
      } else {
        // Still down - check cooldown
        if (now - siteState.lastAlertTime >= cooldownMs) {
          alertQueue.push({ url, type: "REMINDER", message, code });
          state[url] = { status: "DOWN", lastAlertTime: now, message, code };
        } else {
          console.log(`⏳ Throttling repeat alert for ${url} (Cooldown active)`);
        }
      }
    } else {
      // status === "UP"
      if (siteState.status === "DOWN") {
        // Recovered
        alertQueue.push({ url, type: "RECOVERY", message, code });
      }
      state[url] = { status: "UP", lastAlertTime: 0, message, code };
    }
  }
  
  if (alertQueue.length > 0) {
    const subject = buildSubject(alertQueue);
    await sendEmail(subject, alertQueue);
  } else {
    console.log("🤫 No status changes or reminders due. No email sent.");
  }
  
  saveState(state);
  console.log("🏁 Check complete.");
}

runOnce().catch(console.error);
