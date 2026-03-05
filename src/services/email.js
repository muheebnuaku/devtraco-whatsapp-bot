import config from "../config/index.js";

/**
 * Email service — sends viewing confirmation emails via SMTP (Nodemailer).
 * Gracefully no-ops when SMTP is not configured.
 */

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;
  if (!config.email?.host) {
    return null;
  }

  try {
    // Dynamic import so nodemailer is optional
    const nodemailer = await import("nodemailer");
    transporter = nodemailer.default.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
    console.log("[Email] SMTP transporter ready");
    return transporter;
  } catch (err) {
    console.warn("[Email] Nodemailer not available:", err.message);
    return null;
  }
}

/**
 * Send a viewing confirmation email to the client.
 */
export async function sendViewingConfirmationEmail(toEmail, viewing) {
  const mailer = await getTransporter();

  if (!mailer) {
    console.log(`[Email] SMTP not configured — skipping email to ${toEmail} for viewing ${viewing.viewingId}`);
    return { sent: false, reason: "SMTP not configured" };
  }

  try {
    const dateStr = viewing.preferredDate || "To be confirmed";
    const timeStr = viewing.preferredTime || "To be confirmed";
    const propertyName = viewing.propertyName || "Not specified";
    const clientName = viewing.name || "Valued Client";
    const ref = viewing.viewingId || viewing.id;

    const subject = `Viewing Confirmed — ${propertyName} | ${ref}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 0; }
    .header { background: #000; color: #fff; padding: 24px 32px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; letter-spacing: 1px; }
    .header .gold { color: #C8A765; }
    .body { padding: 32px; background: #fff; }
    .body h2 { color: #000; margin-top: 0; font-size: 20px; }
    .details { background: #f8f8f8; border-left: 4px solid #C8A765; padding: 16px 20px; margin: 20px 0; }
    .details table { width: 100%; border-collapse: collapse; }
    .details td { padding: 6px 0; vertical-align: top; }
    .details td:first-child { font-weight: bold; width: 130px; color: #555; }
    .note { background: #fffbe6; border: 1px solid #f0e6a0; padding: 14px; margin: 20px 0; border-radius: 4px; font-size: 14px; }
    .footer { padding: 20px 32px; background: #f5f5f5; text-align: center; font-size: 13px; color: #888; }
    .footer a { color: #C8A765; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span class="gold">DEVTRACO</span> PLUS</h1>
    </div>
    <div class="body">
      <h2>Viewing Confirmed ✓</h2>
      <p>Dear <strong>${clientName}</strong>,</p>
      <p>Your property viewing has been confirmed. Here are the details:</p>
      <div class="details">
        <table>
          <tr><td>Reference:</td><td><strong>${ref}</strong></td></tr>
          <tr><td>Property:</td><td><strong>${propertyName}</strong></td></tr>
          <tr><td>Date:</td><td><strong>${dateStr}</strong></td></tr>
          <tr><td>Time:</td><td><strong>${timeStr}</strong></td></tr>
        </table>
      </div>
      <div class="note">
        <strong>📌 Important Reminders:</strong><br>
        • Please arrive on time — a 15-minute grace period applies<br>
        • Provide at least 3 hours' notice for cancellations or rescheduling<br>
        • You may be asked to present valid ID (National ID, Passport, or Driver's License)<br>
        • Please wear appropriate footwear on site
      </div>
      <p>Your assigned Sales Executive will contact you shortly with further details.</p>
      <p>If you have any questions, please don't hesitate to reach out:</p>
      <p>
        📞 <strong>${config.company.cellPhone}</strong><br>
        📧 <strong>${config.company.email}</strong>
      </p>
      <p>Thank you for choosing Devtraco Plus!</p>
    </div>
    <div class="footer">
      <p><strong>Devtraco Plus</strong></p>
      <p>${config.company.address}</p>
      <p><a href="${config.company.website}">${config.company.website}</a></p>
      <p style="margin-top:12px; font-size:11px; color:#aaa;">
        This is an automated message from the Devtraco Plus Property Assistant.
      </p>
    </div>
  </div>
</body>
</html>`;

    const textBody = [
      `VIEWING CONFIRMED`,
      ``,
      `Dear ${clientName},`,
      ``,
      `Your property viewing has been confirmed:`,
      `Reference: ${ref}`,
      `Property: ${propertyName}`,
      `Date: ${dateStr}`,
      `Time: ${timeStr}`,
      ``,
      `Reminders:`,
      `- Arrive on time (15-min grace period)`,
      `- 3 hours' notice for cancellations`,
      `- Valid ID may be required`,
      `- Wear appropriate footwear`,
      ``,
      `Your Sales Executive will contact you shortly.`,
      ``,
      `Contact: ${config.company.cellPhone} | ${config.company.email}`,
      ``,
      `Thank you for choosing Devtraco Plus!`,
      `${config.company.address}`,
    ].join("\n");

    const info = await mailer.sendMail({
      from: `"Devtraco Plus" <${config.email.from || config.email.user}>`,
      to: toEmail,
      subject,
      text: textBody,
      html,
    });

    console.log(`[Email] Confirmation sent to ${toEmail} — messageId: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Failed to send to ${toEmail}:`, err.message);
    return { sent: false, reason: err.message };
  }
}
