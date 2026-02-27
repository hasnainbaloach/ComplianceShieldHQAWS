// Email template helpers for customer communications

const emailTemplate = (content: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 40px 20px; background-color: #f4f4f5; font-family: Arial, Helvetica, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px;">
    ${content}
  </div>
</body>
</html>
`;

const emailHeader = (title: string) => `
<div style="padding: 32px 40px 24px 40px; border-bottom: 1px solid #e4e4e7;">
  <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #18181b;">${title}</h1>
</div>
`;

const emailBody = (content: string) => `
<div style="padding: 32px 40px;">
  ${content}
</div>
`;

const emailButton = (text: string, url: string) => `
<a href="${url}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background-color: #18181b; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 500; border-radius: 6px;">${text}</a>
`;

const emailFooter = (text: string) => `
<div style="padding: 24px 40px; border-top: 1px solid #e4e4e7;">
  <p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">${text}</p>
</div>
`;

// Welcome email after first subscription
export function welcomeEmail(appUrl: string) {
  return {
    subject: "Welcome to Compliance Shield - Your Protection Starts Now",
    html_body: emailTemplate(`
      ${emailHeader("Welcome to Compliance Shield!")}
      ${emailBody(`
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          Thank you for subscribing to Compliance Shield. You've taken an important step in protecting your business from compliance risks.
        </p>
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          <strong>What happens next:</strong>
        </p>
        <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 16px; line-height: 24px; color: #3f3f46;">
          <li style="margin-bottom: 8px;">Your website will be scanned weekly for compliance vulnerabilities</li>
          <li style="margin-bottom: 8px;">You'll receive email alerts if new issues are detected</li>
          <li style="margin-bottom: 8px;">Access legal templates, document vault, and public certification in your dashboard</li>
        </ul>
        ${emailButton("Go to Dashboard", `${appUrl}/dashboard`)}
        <p style="margin: 24px 0 0 0; font-size: 14px; line-height: 20px; color: #71717a;">
          Questions? Reply to this email - we're here to help.
        </p>
      `)}
      ${emailFooter("© 2025 Compliance Shield. All rights reserved.")}
    `),
    text_body: `Welcome to Compliance Shield! Thank you for subscribing. Your website will be scanned weekly for compliance vulnerabilities. You'll receive email alerts if new issues are detected. Visit ${appUrl}/dashboard to get started.`,
  };
}

// Scan completion notification (only sent if high risk)
export function scanCompletionEmail(url: string, riskScore: number, issueCount: number, appUrl: string) {
  const riskLevel = riskScore >= 85 ? "Low" : riskScore >= 65 ? "Medium" : "High";
  const riskColor = riskScore >= 85 ? "#22c55e" : riskScore >= 65 ? "#f59e0b" : "#ef4444";

  return {
    subject: `Compliance Alert: ${issueCount} ${issueCount === 1 ? "Issue" : "Issues"} Detected on ${new URL(url).hostname}`,
    html_body: emailTemplate(`
      ${emailHeader("Compliance Scan Complete")}
      ${emailBody(`
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          Your weekly compliance scan has detected vulnerabilities that need attention.
        </p>
        <div style="margin: 24px 0; padding: 20px; background-color: #f4f4f5; border-radius: 8px; border-left: 4px solid ${riskColor};">
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">Scanned URL</p>
          <p style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #18181b;">${url}</p>
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">Risk Level</p>
          <p style="margin: 0; font-size: 24px; font-weight: 700; color: ${riskColor};">${riskLevel} Risk (${riskScore}/100)</p>
        </div>
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          <strong>${issueCount} ${issueCount === 1 ? "vulnerability" : "vulnerabilities"} detected</strong> including potential ADA, GDPR, or AI disclosure gaps.
        </p>
        ${emailButton("View Full Report", `${appUrl}/dashboard`)}
        <p style="margin: 24px 0 0 0; font-size: 14px; line-height: 20px; color: #71717a;">
          Use the Remediation Checklist in your dashboard to fix these issues step-by-step.
        </p>
      `)}
      ${emailFooter("You received this because you have active monitoring enabled. © 2025 Compliance Shield.")}
    `),
    text_body: `Compliance scan complete for ${url}. Risk Level: ${riskLevel} (${riskScore}/100). ${issueCount} vulnerabilities detected. View full report at ${appUrl}/dashboard`,
  };
}

// Payment confirmation
export function paymentConfirmationEmail(amount: number, appUrl: string) {
  const formattedAmount = (amount / 100).toFixed(2);
  
  return {
    subject: "Payment Confirmed - Compliance Shield Pro Active",
    html_body: emailTemplate(`
      ${emailHeader("Payment Confirmed")}
      ${emailBody(`
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          Your payment has been processed successfully. Your Compliance Shield Pro subscription is now active.
        </p>
        <div style="margin: 24px 0; padding: 20px; background-color: #f4f4f5; border-radius: 8px;">
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">Amount Charged</p>
          <p style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #18181b;">$${formattedAmount}</p>
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">Billing Cycle</p>
          <p style="margin: 0; font-size: 16px; color: #3f3f46;">Monthly (renews automatically)</p>
        </div>
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #3f3f46;">
          <strong>Your subscription includes:</strong>
        </p>
        <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 16px; line-height: 24px; color: #3f3f46;">
          <li style="margin-bottom: 8px;">Automated weekly compliance scans</li>
          <li style="margin-bottom: 8px;">Legal templates (AI Disclosure, Privacy Policy)</li>
          <li style="margin-bottom: 8px;">Secure document vault</li>
          <li style="margin-bottom: 8px;">Public shield certification</li>
        </ul>
        ${emailButton("Access Dashboard", `${appUrl}/dashboard`)}
      `)}
      ${emailFooter("Manage your subscription in Settings. © 2025 Compliance Shield.")}
    `),
    text_body: `Payment confirmed! Your Compliance Shield Pro subscription ($${formattedAmount}/month) is now active. Access your dashboard at ${appUrl}/dashboard`,
  };
}
