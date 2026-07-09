require("dotenv").config();
const axios = require("axios");
const nodemailer = require("nodemailer");

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

function buildAlertHtml(title, detailMessage) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Website Downtime Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fcfcfd; color: #1e293b; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #fee2e2; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="background: linear-gradient(135deg, #991b1b 0%, #dc2626 100%); color: #ffffff; padding: 24px; text-align: center;">
      <span style="font-size: 40px; display: block; margin-bottom: 8px;">🚨</span>
      <h1 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.5px;">Downtime Alert</h1>
      <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.85;">One of your monitored websites is currently unreachable</p>
    </div>
    <div style="padding: 24px;">
      <div style="background: #fee2e2; color: #991b1b; border-radius: 6px; padding: 12px 16px; font-size: 14px; font-weight: 700; margin-bottom: 20px; text-align: center;">
        🔴 WEBSITE DOWN: <a href="${detailMessage.split('\n')[0].split(' ')[0]}" target="_blank" style="color: #991b1b; text-decoration: underline;">${detailMessage.split('\n')[0].split(' ')[0]}</a>
      </div>
      
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr>
          <td style="width: 140px; font-weight: 700; color: #475569; padding: 8px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top;">Check Date</td>
          <td style="color: #0f172a; padding: 8px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top;">${now}</td>
        </tr>
        <tr>
          <td style="font-weight: 700; color: #475569; padding: 8px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top;">Details</td>
          <td style="color: #b91c1c; padding: 8px 0; border-bottom: 1px solid #f1f5f9; white-space: pre-wrap; font-family: Consolas, Monaco, monospace; vertical-align: top;">${detailMessage}</td>
        </tr>
      </table>
      
      <div style="margin-top: 24px; padding: 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0; font-size: 12px; color: #64748b; line-height: 1.5; text-align: center;">
        This monitor runs automatically every 15 minutes. You will receive another notification if a site's status changes.
      </div>
    </div>
    <div style="background: #f8fafc; color: #94a3b8; font-size: 11px; text-align: center; padding: 16px; border-top: 1px solid #e2e8f0;">
      Somaiya UptimeMonitor • Automated Alert System
    </div>
  </div>
</body>
</html>
  `;
}

async function sendEmail(subject, message) {
  try {
    const htmlBody = buildAlertHtml(subject, message);
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ALERT_EMAILS,
      subject,
      text: message,
      html: htmlBody,
    });
    console.log("📩 Email sent:", subject);
  } catch (err) {
    console.error("❌ Email error:", err.message);
  }
}

async function checkWebsite(url) {
  console.log(`🔍 Checking: ${url}`);
  try {
    const res = await axios.get(url, { timeout: 15000 });
    if (res.status >= 200 && res.status < 400) {
      console.log(`✅ ${url} is UP`);
    } else {
      console.log(`🚨 ${url} is DOWN (Status: ${res.status})`);
      await sendEmail(`🔴 WEBSITE DOWN: ${url}`, `${url} is DOWN.\nStatus: ${res.status}\nURL: ${url}`);
    }
  } catch (err) {
    console.log(`🚨 ${url} is DOWN (Error: ${err.message})`);
    await sendEmail(`🔴 WEBSITE DOWN: ${url}`, `${url} is DOWN or Unreachable.\nError: ${err.message}\nURL: ${url}`);
  }
}

async function runOnce() {
  console.log("🚀 Starting Uptime Check...");
  for (let url of URLS) {
    await checkWebsite(url);
  }
  console.log("🏁 Check complete.");
}

runOnce().catch(console.error);
