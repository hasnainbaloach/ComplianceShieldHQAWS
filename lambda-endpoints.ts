/**
 * Mocha API endpoints for Lambda integration
 * 
 * These endpoints are called by AWS Lambda functions
 * to write scan results and send alerts back to the Mocha database
 */

import { Context } from "hono";

const LAMBDA_SECRET = "shield-2026-secure-browski";

export function validateLambdaRequest(c: Context): boolean {
  const secret = c.req.header("X-Lambda-Secret");
  if (secret !== LAMBDA_SECRET) {
    console.error("[Lambda API] Invalid or missing Lambda secret");
    return false;
  }
  return true;
}

export async function handleSaveScan(c: Context) {
  if (!validateLambdaRequest(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const { userId, url, result } = await c.req.json();

    // Save scan to database
    const scanResult = await c.env.DB.prepare(
      `INSERT INTO scans (
        user_id, url, risk_score, ada_issues, ai_retention_issues, 
        gdpr_issues, shadow_ai_issues, has_cookie_banner, 
        has_privacy_policy, has_ai_features, detected_issues, scan_data, scan_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(
        userId,
        url,
        result.riskScore,
        result.adaIssues ? 1 : 0,
        result.aiRetentionIssues ? 1 : 0,
        result.gdprIssues ? 1 : 0,
        result.shadowAiIssues ? 1 : 0,
        result.hasCookieBanner ? 1 : 0,
        result.hasPrivacyPolicy ? 1 : 0,
        result.hasAiFeatures ? 1 : 0,
        JSON.stringify(result.detectedIssues),
        result.scanData
      )
      .run();

    // Update user's last scan info
    await c.env.DB.prepare(
      `UPDATE users 
       SET last_scan_date = datetime('now'), 
           last_risk_score = ?
       WHERE id = ?`
    )
      .bind(result.riskScore, userId)
      .run();

    console.log(`[Lambda API] ✓ Saved scan for user ${userId}, score: ${result.riskScore}`);

    return c.json({ success: true, scanId: scanResult.meta.last_row_id });
  } catch (error: any) {
    console.error("[Lambda API] Error saving scan:", error);
    return c.json({ error: error.message }, 500);
  }
}

export async function handleGetActiveUsers(c: Context) {
  if (!validateLambdaRequest(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    // Fetch users with active shield AND a last scan URL
    const { results } = await c.env.DB.prepare(
      `SELECT 
        u.id, 
        u.email, 
        u.last_risk_score,
        u.is_shield_active,
        s.url as last_scan_url
       FROM users u
       LEFT JOIN scans s ON s.user_id = u.id
       WHERE u.is_subscribed = 1 
         AND u.is_shield_active = 1
         AND s.url IS NOT NULL
       GROUP BY u.id
       HAVING MAX(s.scan_date)`
    ).all();

    console.log(`[Lambda API] Found ${results?.length || 0} active shield users`);

    return c.json({ 
      users: results || [],
      count: results?.length || 0 
    });
  } catch (error: any) {
    console.error("[Lambda API] Error fetching active users:", error);
    return c.json({ error: error.message }, 500);
  }
}

export async function handleSendAlert(c: Context) {
  if (!validateLambdaRequest(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const { userId, email, alertType, oldScore, newScore, url } = await c.req.json();

    // Save alert to database
    await c.env.DB.prepare(
      `INSERT INTO compliance_alerts (
        user_id, alert_type, old_score, new_score, alert_data, email_sent
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        alertType,
        oldScore,
        newScore,
        JSON.stringify({ url, timestamp: new Date().toISOString() }),
        0 // Will be set to 1 after email sends
      )
      .run();

    // Send email alert
    const emailSent = await sendComplianceDriftEmail(
      c.env,
      email,
      url,
      oldScore,
      newScore
    );

    // Mark email as sent
    if (emailSent) {
      await c.env.DB.prepare(
        `UPDATE compliance_alerts 
         SET email_sent = 1 
         WHERE user_id = ? 
           AND alert_type = ? 
           AND triggered_at = (
             SELECT MAX(triggered_at) 
             FROM compliance_alerts 
             WHERE user_id = ?
           )`
      )
        .bind(userId, alertType, userId)
        .run();
    }

    console.log(`[Lambda API] ✓ Alert created for ${email}, email sent: ${emailSent}`);

    return c.json({ success: true, emailSent });
  } catch (error: any) {
    console.error("[Lambda API] Error sending alert:", error);
    return c.json({ error: error.message }, 500);
  }
}

async function sendComplianceDriftEmail(
  env: any,
  email: string,
  url: string,
  oldScore: number,
  newScore: number
): Promise<boolean> {
  try {
    const scoreChange = newScore - oldScore;
    const percentChange = Math.round((scoreChange / oldScore) * 100);

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .alert-box { background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin: 20px 0; border-radius: 4px; }
          .score-change { font-size: 48px; font-weight: bold; color: #ef4444; text-align: center; margin: 20px 0; }
          .btn { display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
          .footer { text-align: center; color: #6b7280; font-size: 12px; margin-top: 30px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">🚨 Compliance Drift Alert</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Your Active Shield detected changes</p>
          </div>
          <div class="content">
            <div class="alert-box">
              <strong>⚠️ Compliance Risk Increased</strong>
              <p style="margin: 10px 0 0 0;">Your website's compliance score changed significantly during this week's automated scan.</p>
            </div>

            <h2>What Changed:</h2>
            <div class="score-change">+${scoreChange} points</div>
            <p style="text-align: center; color: #6b7280;">
              Risk score: <strong>${oldScore}</strong> → <strong>${newScore}</strong> 
              <span style="color: #ef4444;">(+${percentChange}%)</span>
            </p>

            <h3>Affected Website:</h3>
            <p style="background: white; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 14px;">
              ${url}
            </p>

            <h3>Possible Causes:</h3>
            <ul>
              <li>New AI chatbot added without Texas HB 149 disclosure</li>
              <li>Privacy policy link removed or broken</li>
              <li>Cookie consent banner disabled or malfunctioning</li>
              <li>New data collection forms without proper notices</li>
              <li>Accessibility regressions in recent code changes</li>
            </ul>

            <div style="text-align: center;">
              <a href="https://complianceshieldhq.mocha.app/dashboard" class="btn">
                View Full Report →
              </a>
            </div>

            <div class="footer">
              <p>This is an automated alert from your Compliance Shield Active Monitoring.</p>
              <p>You're receiving this because compliance drift was detected during your weekly scan.</p>
              <p>To stop these alerts, cancel your subscription in Settings.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const response = await fetch(
      `${env.MOCHA_USERS_SERVICE_API_URL}/v1/send-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.MOCHA_USERS_SERVICE_API_KEY}`,
        },
        body: JSON.stringify({
          to: email,
          subject: `🚨 Compliance Alert: Risk score increased by ${scoreChange} points`,
          html: emailHtml,
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("[Email] Failed to send compliance drift alert:", error);
    return false;
  }
}
