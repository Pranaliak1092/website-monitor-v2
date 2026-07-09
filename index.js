require("dotenv").config();
const axios = require("axios");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const URLS = (process.env.URLS || "").split(/[,\r\n]+/).map((u) => u.trim()).filter(Boolean);

// Store status + last alert time
let websiteData = {};

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
        🔴 WEBSITE STATUS: <a href="${detailMessage.split('\n')[0].split(' ')[0]}" target="_blank" style="color: #991b1b; text-decoration: underline;">${detailMessage.split('\n')[0].split(' ')[0]}</a>
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
  try {
    const res = await axios.get(url, { timeout: 10000 });

    if (res.status >= 200 && res.status < 400) {
      await handleStatus(url, "UP");
    } else {
      await handleStatus(url, "DOWN");
    }
  } catch {
    await handleStatus(url, "DOWN");
  }
}

async function handleStatus(url, currentStatus) {
  const now = Date.now();
  const data = websiteData[url] || {};

  // First time
  if (!data.status) {
    websiteData[url] = { status: currentStatus, lastAlert: now };

    await sendEmail(
      `ℹ️ Initial Status: ${currentStatus}`,
      `${url}\nStatus: ${currentStatus}\nTime: ${new Date()}`
    );

    console.log(`🔔 First check: ${url} → ${currentStatus}`);
    return;
  }

  // Status changed
  if (data.status !== currentStatus) {
    websiteData[url] = { status: currentStatus, lastAlert: now };

    await sendEmail(
      `🔄 Status Changed: ${currentStatus}`,
      `${url}\nNew Status: ${currentStatus}\nTime: ${new Date()}`
    );

    console.log(`🚨 Change detected: ${url} → ${currentStatus}`);
    return;
  }

  // If still DOWN → send reminder every 1 hour
  if (currentStatus === "DOWN") {
    const oneHour = 5 * 60 * 60 * 1000;

    if (!data.lastAlert || now - data.lastAlert >= oneHour) {
      websiteData[url].lastAlert = now;

      await sendEmail(
        `⏰ Reminder: Still DOWN`,
        `${url} is still DOWN\nTime: ${new Date()}`
      );

      console.log(`⏰ Reminder sent: ${url} still DOWN`);
    } else {
      console.log(`⏳ Waiting for reminder: ${url}`);
    }
  } else {
    console.log(`✅ No change: ${url} → UP`);
  }
}

async function runChecks() {
  console.log("\n⏳ Checking all websites...\n");

  for (let url of URLS) {
    await checkWebsite(url);
  }
}

// Every 15 minutes
cron.schedule("*/15 * * * *", runChecks);

// Run immediately
runChecks();