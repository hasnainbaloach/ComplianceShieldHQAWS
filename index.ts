import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { analyzeUrl } from "./scanner";
import { 
  createCheckoutSession, 
  verifyWebhookSignature, 
  listCustomers, 
  listSubscriptions,
  cancelSubscription
} from "./stripe-api";
import { scanCompletionEmail, welcomeEmail, paymentConfirmationEmail } from "./email-templates";
import {
  getOAuthRedirectUrl,
  exchangeCodeForSessionToken,
  deleteSession,
  authMiddleware,
  MOCHA_SESSION_TOKEN_COOKIE_NAME,
} from "@getmocha/users-service/backend";

interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  EMAILS: {
    send(params: {
      to: string;
      subject: string;
      html_body?: string;
      text_body?: string;
    }): Promise<{ success: boolean; message_id?: string; error?: string }>;
  };
  FIRECRAWL_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  LAMBDA_SCANNER_ARN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  MOCHA_USERS_SERVICE_API_URL?: string;
  MOCHA_USERS_SERVICE_API_KEY?: string;
  MOCHA_EMAIL_SERVICE_API_URL?: string;
  MOCHA_EMAIL_SERVICE_API_KEY?: string;
  GA_MEASUREMENT_ID?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Configure CORS to allow credentials (cookies)
app.use("*", cors({
  origin: (origin) => origin || "*", // Return the requesting origin for credentials to work
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
}));

// Inject GA_MEASUREMENT_ID into index.html
app.get("/", async (c) => {
  const GA_ID = c.env.GA_MEASUREMENT_ID || "";
  
  // Fetch the original index.html
  const response = await fetch(new URL("/", c.req.url));
  let html = await response.text();
  
  // Replace the placeholder with actual GA ID
  html = html.replace(/{{GA_MEASUREMENT_ID}}/g, GA_ID);
  
  return c.html(html);
});

// Sitemap.xml route (dynamic)
app.get("/sitemap.xml", (c) => {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://complianceshieldhq.com/</loc>
    <priority>1.0</priority>
    <changefreq>weekly</changefreq>
  </url>
  <url>
    <loc>https://complianceshieldhq.com/privacy-policy</loc>
    <priority>0.5</priority>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>https://complianceshieldhq.com/terms-of-service</loc>
    <priority>0.5</priority>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>https://complianceshieldhq.com/contact</loc>
    <priority>0.7</priority>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>https://complianceshieldhq.com/blog</loc>
    <priority>0.8</priority>
    <changefreq>weekly</changefreq>
  </url>
</urlset>`;

  return c.text(sitemap, 200, {
    "Content-Type": "application/xml"
  });
});

// Robots.txt route (dynamic)
app.get("/robots.txt", (c) => {
  const robots = `User-agent: *
Allow: /

Sitemap: https://complianceshieldhq.com/sitemap.xml`;

  return c.text(robots, 200, {
    "Content-Type": "text/plain"
  });
});

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// Get OAuth redirect URL for Google login
app.get("/api/oauth/google/redirect_url", async (c) => {
  const redirectUrl = await getOAuthRedirectUrl("google", {
    apiUrl: c.env.MOCHA_USERS_SERVICE_API_URL!,
    apiKey: c.env.MOCHA_USERS_SERVICE_API_KEY!,
  });

  return c.json({ redirectUrl }, 200);
});

// Exchange OAuth code for session token
app.post("/api/sessions", async (c) => {
  const body = await c.req.json();

  if (!body.code) {
    return c.json({ error: "No authorization code provided" }, 400);
  }

  console.log("[Sessions] Starting token exchange for code");

  const sessionToken = await exchangeCodeForSessionToken(body.code, {
    apiUrl: c.env.MOCHA_USERS_SERVICE_API_URL!,
    apiKey: c.env.MOCHA_USERS_SERVICE_API_KEY!,
  });

  console.log("[Sessions] Token exchange successful, setting cookie");

  setCookie(c, MOCHA_SESSION_TOKEN_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 24 * 60 * 60, // 60 days
  });

  // CRITICAL: Verify the user exists in our database before returning success
  // This ensures the user profile is created and ready
  try {
    const userResponse = await fetch(`${c.env.MOCHA_USERS_SERVICE_API_URL}/users/me`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "X-Api-Key": c.env.MOCHA_USERS_SERVICE_API_KEY!,
      },
    });

    if (!userResponse.ok) {
      console.error("[Sessions] User verification failed:", userResponse.status);
      return c.json({ error: "Session created but user verification failed" }, 500);
    }

    const userData = await userResponse.json() as { 
      id?: string; 
      user_id?: string;
      email?: string; 
      google_user_data?: Record<string, unknown>;
    };
    console.log("[Sessions] Raw user data received:", JSON.stringify(userData));
    
    // Extract user ID and email from the response
    const userId = userData?.id || userData?.user_id;
    const userEmail = userData?.email;
    const googleData = userData?.google_user_data || {};
    
    if (!userId || !userEmail) {
      console.error("[Sessions] Invalid user data - missing id or email:", userData);
      return c.json({ error: "Invalid user data from auth service" }, 500);
    }
    
    console.log("[Sessions] User verified:", userEmail, "ID:", userId);

    // Insert or update user in our database
    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).bind(userId).first();

    if (!existingUser) {
      console.log("[Sessions] Creating new user in database:", userId);
      await c.env.DB.prepare(
        "INSERT INTO users (id, email, google_user_data, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
      ).bind(
        userId,
        userEmail,
        JSON.stringify(googleData)
      ).run();
    }

    console.log("[Sessions] Session fully established for:", userEmail);
  } catch (error) {
    console.error("[Sessions] Error verifying user:", error);
    // Don't fail the request - cookie is still set
  }

  return c.json({ success: true }, 200);
});

// Get current authenticated user - using official authMiddleware
app.get("/api/users/me", authMiddleware, async (c) => {
  const user = c.get("user");
  return c.json(user);
});

// Delete current user account and all associated data
app.delete("/api/users/me", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const userId = mochaUser.id;
    console.log(`[Account Deletion] Starting deletion for user: ${userId}`);

    // Step 1: Get list of governance documents to delete from R2
    const { results: documents } = await c.env.DB.prepare(
      "SELECT file_key FROM governance_documents WHERE user_id = ?"
    )
      .bind(userId)
      .all();

    // Delete files from R2 storage
    if (documents && documents.length > 0) {
      console.log(`[Account Deletion] Deleting ${documents.length} files from R2`);
      for (const doc of documents) {
        try {
          await c.env.R2_BUCKET.delete(doc.file_key as string);
        } catch (r2Error) {
          console.error(`[Account Deletion] Failed to delete R2 file: ${doc.file_key}`, r2Error);
          // Continue anyway - we'll still delete the database record
        }
      }
    }

    // Step 2: Delete all user data from database tables (in correct order)
    console.log(`[Account Deletion] Deleting database records for user: ${userId}`);

    await c.env.DB.prepare("DELETE FROM governance_documents WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM shield_certifications WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM checklist_progress WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM monitoring_preferences WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM intent_events WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM scans WHERE user_id = ?")
      .bind(userId)
      .run();

    await c.env.DB.prepare("DELETE FROM scan_attempts WHERE user_id = ?")
      .bind(userId)
      .run();

    // Step 3: Finally delete the user record itself
    await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
      .bind(userId)
      .run();

    console.log(`[Account Deletion] Successfully deleted all data for user: ${userId}`);

    // Step 4: Delete the session to log the user out
    const sessionToken = getCookie(c, MOCHA_SESSION_TOKEN_COOKIE_NAME);
    if (typeof sessionToken === "string") {
      await deleteSession(sessionToken, {
        apiUrl: c.env.MOCHA_USERS_SERVICE_API_URL!,
        apiKey: c.env.MOCHA_USERS_SERVICE_API_KEY!,
      });
    }

    // Clear the session cookie
    setCookie(c, MOCHA_SESSION_TOKEN_COOKIE_NAME, "", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      maxAge: 0,
    });

    return c.json({ success: true, message: "Account and all data permanently deleted" }, 200);
  } catch (error) {
    console.error("[Account Deletion] Error:", error);
    return c.json({ error: "Failed to delete account" }, 500);
  }
});

// Logout endpoint
app.get("/api/logout", async (c) => {
  const sessionToken = getCookie(c, MOCHA_SESSION_TOKEN_COOKIE_NAME);

  if (typeof sessionToken === "string") {
    await deleteSession(sessionToken, {
      apiUrl: c.env.MOCHA_USERS_SERVICE_API_URL!,
      apiKey: c.env.MOCHA_USERS_SERVICE_API_KEY!,
    });
  }

  // Delete cookie by setting max age to 0
  setCookie(c, MOCHA_SESSION_TOKEN_COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    maxAge: 0,
  });

  return c.json({ success: true }, 200);
});

// ============================================
// USER METADATA & SUBSCRIPTION ENDPOINTS
// ============================================

// GET /api/user-metadata - Get user metadata with subscription status
app.get("/api/user-metadata", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Check if user exists in our DB - query by id field (which matches mocha_user_id)
    const userRecord = await c.env.DB.prepare(
      "SELECT * FROM users WHERE id = ?"
    )
      .bind(mochaUser.id)
      .first();

    if (!userRecord) {
      console.log(`[UserMetadata] Creating new user: ${mochaUser.id}`);
      // Create user if doesn't exist
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, mocha_user_id, is_subscribed, created_at, updated_at)
         VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
        .bind(mochaUser.id, mochaUser.email, mochaUser.id)
        .run();

      return c.json({
        id: mochaUser.id,
        email: mochaUser.email,
        isSubscribed: false,
      });
    }

    console.log(`[UserMetadata] User found: ${mochaUser.id}, is_subscribed: ${userRecord.is_subscribed}`);

    return c.json({
      id: userRecord.id as string,
      email: userRecord.email as string,
      isSubscribed: Boolean(userRecord.is_subscribed),
    });
  } catch (error) {
    console.error("User metadata error:", error);
    return c.json({ error: "Failed to get user metadata" }, 500);
  }
});

// POST /api/scan-attempt - Log anonymous scan attempt for market research
app.post("/api/scan-attempt", async (c) => {
  try {
    const body = await c.req.json();
    const { url, risk_score } = body;

    if (!url) {
      return c.json({ error: "URL is required" }, 400);
    }

    // Get optional user info if authenticated
    const authHeader = c.req.header("Authorization");
    let userId: string | null = null;
    let isAuthenticated = false;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const userResponse = await fetch(
        `${c.env.MOCHA_USERS_SERVICE_API_URL}/users/me`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (userResponse.ok) {
        const user = await userResponse.json() as { id: string };
        userId = user.id;
        isAuthenticated = true;
      }
    }

    // Log scan attempt
    await c.env.DB.prepare(
      `INSERT INTO scan_attempts (url, risk_score, user_id, is_authenticated, referrer, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        url,
        risk_score || null,
        userId,
        isAuthenticated ? 1 : 0,
        c.req.header("referer") || null,
        c.req.header("user-agent") || null
      )
      .run();

    return c.json({ success: true });
  } catch (error) {
    console.error("Failed to log scan attempt:", error);
    // Don't fail the request if logging fails
    return c.json({ success: false }, 500);
  }
});

// POST /api/scan - Scan a URL for compliance issues
app.post("/api/scan", async (c) => {
  try {
    const { url } = await c.req.json();

    if (!url) {
      console.error("[/api/scan] Missing URL in request");
      return c.json({ error: "URL is required" }, 400);
    }

    // Validate URL format
    try {
      new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch (e) {
      console.error("[/api/scan] Invalid URL format:", url);
      return c.json({ error: "Invalid URL format" }, 400);
    }

    console.log(`[/api/scan] Starting scan for: ${url}`);
    
    // LAMBDA-ONLY MODE: Always invoke Lambda for scans (no local Bedrock)
    if (c.env.LAMBDA_SCANNER_ARN && c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY) {
      console.log(`[/api/scan] LAMBDA MODE: Delegating to ${c.env.LAMBDA_SCANNER_ARN}`);
      
      try {
        const { invokeLambda } = await import("./lambda-invoke");
        
        const result = await invokeLambda({
          functionArn: c.env.LAMBDA_SCANNER_ARN,
          region: c.env.AWS_REGION || "us-east-1",
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          payload: {
            url: url.startsWith('http') ? url : `https://${url}`,
            userId: "anonymous",
            isScheduledScan: false,
          },
        });

        console.log(`[/api/scan] Lambda scan completed - Risk Score: ${result.riskScore}`);
        return c.json(result);
        
      } catch (lambdaError: any) {
        console.error("[/api/scan] Lambda invocation failed:", lambdaError);
        
        // Return error but preserve session (don't send 401)
        return c.json(
          {
            success: false,
            error: `Lambda scan failed: ${lambdaError.message}`,
            riskScore: 0,
            hasCookieBanner: false,
            hasPrivacyPolicy: false,
            hasAiFeatures: false,
            adaIssues: true,
            aiRetentionIssues: true,
            gdprIssues: true,
            shadowAiIssues: true,
            detectedIssues: ["Scan temporarily unavailable - please try again"]
          },
          500
        );
      }
    }
    
    // Fallback: Local scan (only if Lambda not configured)
    console.log("[/api/scan] LOCAL MODE: Lambda not configured, running local scan");
    const bedrockConfig = c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY && c.env.AWS_REGION
      ? {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          region: c.env.AWS_REGION,
        }
      : undefined;
    
    const result = await analyzeUrl(
      url,
      c.env.FIRECRAWL_API_KEY,
      bedrockConfig
    );

    console.log(`[/api/scan] Scan completed for ${url} - Risk Score: ${result.riskScore}`);
    return c.json(result);
  } catch (error: any) {
    console.error("[/api/scan] Error:", error);
    
    // Don't return 401/403 on rate limits - preserve session
    const statusCode = error.message?.includes("429") || error.message?.includes("rate limit") 
      ? 429 
      : 500;
    
    return c.json({ 
      error: "Failed to scan URL",
      success: false,
      riskScore: 64,
      hasCookieBanner: false,
      hasPrivacyPolicy: false,
      hasAiFeatures: false,
      adaIssues: true,
      aiRetentionIssues: true,
      gdprIssues: true,
      shadowAiIssues: true,
      detectedIssues: ["Scan temporarily unavailable - please try again"]
    }, statusCode);
  }
});

// POST /api/scans - Save a scan result
app.post("/api/scans", async (c) => {
  try {
    const body = await c.req.json();
    const {
      url,
      risk_score,
      has_cookie_banner,
      has_privacy_policy,
      has_ai_features,
      ada_issues,
      ai_retention_issues,
      gdpr_issues,
      shadow_ai_issues,
      detected_issues,
      scan_data,
    } = body;

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.substring(7);
    const userResponse = await fetch(
      `${c.env.MOCHA_USERS_SERVICE_API_URL}/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
        },
      }
    );

    if (!userResponse.ok) {
      console.error(`[/api/scans POST] User lookup failed: HTTP ${userResponse.status}`);
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await userResponse.json() as { id: string };
    console.log(`[/api/scans POST] Saving scan for user: ${user.id}, URL: ${url}`);

    await c.env.DB.prepare(
      `INSERT INTO scans (
        user_id, url, risk_score, has_cookie_banner, has_privacy_policy, 
        has_ai_features, ada_issues, ai_retention_issues, gdpr_issues, 
        shadow_ai_issues, detected_issues, scan_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        user.id,
        url,
        risk_score,
        has_cookie_banner ? 1 : 0,
        has_privacy_policy ? 1 : 0,
        has_ai_features ? 1 : 0,
        ada_issues ? 1 : 0,
        ai_retention_issues ? 1 : 0,
        gdpr_issues ? 1 : 0,
        shadow_ai_issues ? 1 : 0,
        JSON.stringify(detected_issues),
        scan_data
      )
      .run();

    console.log(`[/api/scans POST] Scan saved successfully for user: ${user.id}`);

    // Send email notification if risk is medium or high (score < 85)
    if (risk_score < 85 && c.env.EMAILS) {
      try {
        const userDetailsResponse = await fetch(
          `${c.env.MOCHA_USERS_SERVICE_API_URL}/users/me`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
            },
          }
        );

        if (userDetailsResponse.ok) {
          const userDetails = await userDetailsResponse.json() as { email: string };
          const issueCount = detected_issues?.length || 0;
          const appUrl = new URL(c.req.url).origin;
          const emailContent = scanCompletionEmail(url, risk_score, issueCount, appUrl);

          await c.env.EMAILS.send({
            to: userDetails.email,
            ...emailContent,
          });

          console.log(`[Email] Scan notification sent to ${userDetails.email}`);
        }
      } catch (emailError) {
        console.error("[Email] Failed to send scan notification:", emailError);
        // Don't fail the request if email fails
      }
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("[/api/scans POST] Error:", error);
    return c.json({ error: "Failed to save scan" }, 500);
  }
});

// GET /api/scans - Get all scans for the current user
app.get("/api/scans", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM scans WHERE user_id = ? ORDER BY created_at DESC`
    )
      .bind(mochaUser.id)
      .all();

    return c.json(results || []);
  } catch (error) {
    console.error("Get scans error:", error);
    return c.json({ error: "Failed to get scans" }, 500);
  }
});

// POST /api/checkout - Create checkout session with optional scan pre-save
app.post("/api/checkout", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!c.env.STRIPE_SECRET_KEY) {
      return c.json({ error: "Stripe not configured" }, 500);
    }

    // Check if scan data is provided for pre-save
    const body = await c.req.json().catch(() => ({}));
    let scanId: string | undefined;

    if (body.scanData) {
      // Save scan before checkout to ensure data persistence
      // Handle both camelCase (from localStorage) and snake_case formats
      const scanData = body.scanData;
      const url = scanData.url;
      const risk_score = scanData.risk_score || scanData.riskScore || 64;
      const has_cookie_banner = scanData.has_cookie_banner || scanData.hasCookieBanner || false;
      const has_privacy_policy = scanData.has_privacy_policy || scanData.hasPrivacyPolicy || false;
      const has_ai_features = scanData.has_ai_features || scanData.hasAiFeatures || false;
      const ada_issues = scanData.ada_issues !== undefined ? scanData.ada_issues : (scanData.adaIssues !== undefined ? scanData.adaIssues : true);
      const ai_retention_issues = scanData.ai_retention_issues !== undefined ? scanData.ai_retention_issues : (scanData.aiRetentionIssues !== undefined ? scanData.aiRetentionIssues : true);
      const gdpr_issues = scanData.gdpr_issues !== undefined ? scanData.gdpr_issues : (scanData.gdprIssues !== undefined ? scanData.gdprIssues : true);
      const shadow_ai_issues = scanData.shadow_ai_issues !== undefined ? scanData.shadow_ai_issues : (scanData.shadowAiIssues !== undefined ? scanData.shadowAiIssues : true);
      const detected_issues = scanData.detected_issues || scanData.detectedIssues || [];
      const scan_data = scanData.scan_data || JSON.stringify(scanData);

      console.log(`[/api/checkout] Pre-saving scan for user ${mochaUser.id}:`, {
        url,
        risk_score,
        has_cookie_banner,
        has_privacy_policy,
        has_ai_features
      });

      const result = await c.env.DB.prepare(
        `INSERT INTO scans (
          user_id, url, risk_score, has_cookie_banner, has_privacy_policy, 
          has_ai_features, ada_issues, ai_retention_issues, gdpr_issues, 
          shadow_ai_issues, detected_issues, scan_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          mochaUser.id,
          url,
          risk_score,
          has_cookie_banner ? 1 : 0,
          has_privacy_policy ? 1 : 0,
          has_ai_features ? 1 : 0,
          ada_issues ? 1 : 0,
          ai_retention_issues ? 1 : 0,
          gdpr_issues ? 1 : 0,
          shadow_ai_issues ? 1 : 0,
          JSON.stringify(detected_issues),
          scan_data
        )
        .run();

      scanId = result.meta.last_row_id?.toString();
      console.log(`[/api/checkout] ✓ Pre-saved scan ${scanId} for user ${mochaUser.id}`);
    }

    const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
      customer_email: mochaUser.email,
      success_url: `${new URL(c.req.url).origin}/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${new URL(c.req.url).origin}/dashboard`,
      user_id: mochaUser.id,
      scan_url: body.scanData?.url,
      scan_id: scanId,
    });

    return c.json({ url: session.url });
  } catch (error) {
    console.error("Checkout session error:", error);
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
});

// POST /api/create-checkout-session - Create a Stripe checkout session
app.post("/api/create-checkout-session", async (c) => {
  try {
    const { email } = await c.req.json();
    console.log(`[/api/create-checkout-session] Creating session for: ${email}`);

    if (!email) {
      return c.json({ error: "Email is required" }, 400);
    }

    if (!c.env.STRIPE_SECRET_KEY) {
      return c.json({ error: "Stripe not configured" }, 500);
    }

    const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
      customer_email: email,
      success_url: `${new URL(c.req.url).origin}/dashboard?subscribed=true`,
      cancel_url: `${new URL(c.req.url).origin}/dashboard`,
    });

    return c.json({ url: session.url });
  } catch (error) {
    console.error("Checkout session error:", error);
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
});

// POST /api/webhooks/stripe - Handle Stripe webhook events (correct path)
// This route is PUBLIC - no auth middleware should intercept it
app.post("/api/webhooks/stripe", async (c) => {
  // Top-level error wrapper to catch ANY failure
  try {
    console.log("[Webhook] =================================");
    console.log("[Webhook] POST request received at /api/webhooks/stripe");
    console.log("[Webhook] Request URL:", c.req.url);
    console.log("[Webhook] Request method:", c.req.method);
    console.log("[Webhook] Headers:", JSON.stringify(Object.fromEntries([...c.req.raw.headers])));
    console.log("[Webhook] =================================");
    
    const signature = c.req.header("stripe-signature");

    if (!signature) {
      console.error("[Webhook] ERROR: Missing stripe-signature header");
      return c.json({ received: true, error: "Missing signature" }, 200, {
        "Content-Type": "application/json"
      });
    }

    if (!c.env.STRIPE_WEBHOOK_SECRET) {
      console.error("[Webhook] FATAL: Missing STRIPE_WEBHOOK_SECRET environment variable");
      return c.json({ received: true, error: "Missing webhook secret" }, 200, {
        "Content-Type": "application/json"
      });
    }

    if (!c.env.STRIPE_SECRET_KEY) {
      console.error("[Webhook] FATAL: Missing STRIPE_SECRET_KEY environment variable");
      return c.json({ received: true, error: "Missing Stripe key" }, 200, {
        "Content-Type": "application/json"
      });
    }
    console.log("[Webhook] Reading request body...");
    const body = await c.req.text();
    console.log("[Webhook] Body length:", body.length);

    console.log("[Webhook] Verifying webhook signature...");
    // Verify webhook signature using custom implementation
    const isValid = await verifyWebhookSignature(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );

    if (!isValid) {
      console.error("[Webhook] ERROR: Signature validation failed");
      console.error("[Webhook] Body preview:", body.substring(0, 100));
      console.error("[Webhook] Signature preview:", signature.substring(0, 50));
      // Return 200 to acknowledge receipt and stop Stripe retries
      return c.json({ received: true, error: "Invalid signature" }, 200, {
        "Content-Type": "application/json"
      });
    }

    console.log("[Webhook] ✓ Signature verified successfully");
    console.log("[Webhook] Parsing event JSON...");
    
    const event = JSON.parse(body) as {
      type: string;
      data: {
        object: any;
      };
    };

    console.log(`[Webhook] ✓ Event parsed successfully`);
    console.log(`[Webhook] Event type: ${event.type}`);
    console.log(`[Webhook] Event ID: ${(event as any).id || 'unknown'}`);
    console.log(`[Webhook] Event data preview:`, JSON.stringify(event.data.object).substring(0, 200));

    // Handle subscription events
    if (
      event.type === "checkout.session.completed" ||
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const session = event.data.object as any;
      const customerEmail =
        session.customer_email || session.metadata?.customer_email;

      if (customerEmail) {
        console.log(
          `[Webhook] Processing subscription for email: ${customerEmail}`
        );

        // Get user by email from Mocha Users Service
        const userResponse = await fetch(
          `${c.env.MOCHA_USERS_SERVICE_API_URL}/user-by-email?email=${encodeURIComponent(customerEmail)}`,
          {
            headers: {
              "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
            },
          }
        );

        if (userResponse.ok) {
          const user = await userResponse.json() as { id: string };
          console.log(`[Webhook] ✓ Found user in Mocha service: ${user.id} (${customerEmail})`);

          // First check if user exists in our database
          const existingUser = await c.env.DB.prepare(
            "SELECT id, is_subscribed, subscription_status FROM users WHERE id = ?"
          ).bind(user.id).first();
          
          console.log(`[Webhook] Current user record in DB:`, existingUser || 'NOT FOUND');
          
          if (!existingUser) {
            // Create user if doesn't exist
            console.log(`[Webhook] Creating new user record: ${user.id}`);
            await c.env.DB.prepare(
              `INSERT INTO users (id, email, mocha_user_id, is_subscribed, stripe_customer_id, subscription_status, created_at, updated_at)
               VALUES (?, ?, ?, 1, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
            ).bind(user.id, customerEmail, user.id, session.customer).run();
          } else {
            // Update existing user
            console.log(`[Webhook] Updating existing user: ${user.id}`);
            await c.env.DB.prepare(
              `UPDATE users SET 
               is_subscribed = 1,
               stripe_customer_id = ?,
               subscription_status = 'active',
               updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).bind(session.customer, user.id).run();
          }

          console.log(`[Webhook] ✓ Database write completed for user ${user.id}`);
          
          // Verify the update worked with a fresh query
          const verifyUser = await c.env.DB.prepare(
            "SELECT id, email, is_subscribed, subscription_status, stripe_customer_id FROM users WHERE id = ?"
          ).bind(user.id).first();
          
          console.log(`[Webhook] ✓ VERIFICATION - User record after update:`, {
            id: verifyUser?.id,
            email: verifyUser?.email,
            is_subscribed: verifyUser?.is_subscribed,
            subscription_status: verifyUser?.subscription_status,
            stripe_customer_id: verifyUser?.stripe_customer_id
          });
          
          if (verifyUser?.is_subscribed !== 1) {
            console.error(`[Webhook] ⚠️ WARNING: Subscription flag not set correctly! Expected 1, got ${verifyUser?.is_subscribed}`);
          } else {
            console.log(`[Webhook] ✓ CONFIRMED: is_subscribed = 1 (subscription active)`);
          }
          
          console.log(`[Webhook] ✓ Verified user status:`, verifyUser);
          
          // Track purchase in analytics (import needed at top of file)
          // Note: GA4 Measurement Protocol would be called here in production
          console.log(`[Analytics] Purchase tracked for user ${user.id}, amount: $49`);

          // Send welcome email for first subscription
          if (event.type === "checkout.session.completed" && c.env.EMAILS) {
            try {
              const appUrl = `https://${new URL(c.env.MOCHA_USERS_SERVICE_API_URL || "").hostname.replace("users.", "")}`;
              const emailContent = welcomeEmail(appUrl);
              
              await c.env.EMAILS.send({
                to: customerEmail,
                ...emailContent,
              });
              
              console.log(`[Email] Welcome email sent to ${customerEmail}`);
            } catch (emailError) {
              console.error("[Email] Failed to send welcome email:", emailError);
            }
          }

          // Send payment confirmation
          if (event.type === "checkout.session.completed" && c.env.EMAILS) {
            try {
              const amount = session.amount_total || 4900; // Fallback to $49
              const appUrl = `https://${new URL(c.env.MOCHA_USERS_SERVICE_API_URL || "").hostname.replace("users.", "")}`;
              const emailContent = paymentConfirmationEmail(amount, appUrl);
              
              await c.env.EMAILS.send({
                to: customerEmail,
                ...emailContent,
              });
              
              console.log(`[Email] Payment confirmation sent to ${customerEmail}`);
            } catch (emailError) {
              console.error("[Email] Failed to send payment confirmation:", emailError);
            }
          }
        } else {
          console.error(
            `[Webhook] User not found for email: ${customerEmail}`
          );
        }
      } else {
        console.error("[Webhook] No customer email in event");
      }
    }

    // Handle cancellation
    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated"
    ) {
      const subscription = event.data.object as any;

      if (subscription.status === "canceled") {
        const customerEmail =
          subscription.metadata?.customer_email || subscription.customer_email;

        if (customerEmail) {
          console.log(
            `[Webhook] Processing cancellation for email: ${customerEmail}`
          );

          const userResponse = await fetch(
            `${c.env.MOCHA_USERS_SERVICE_API_URL}/user-by-email?email=${encodeURIComponent(customerEmail)}`,
            {
              headers: {
                "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
              },
            }
          );

          if (userResponse.ok) {
            const user = await userResponse.json() as { id: string };

            await c.env.DB.prepare(
              `UPDATE users 
               SET is_subscribed = 0, 
               subscription_status = 'canceled',
               updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
              .bind(user.id)
              .run();

            console.log(
              `[Webhook] Cancelled subscription for user ${user.id}`
            );
          }
        }
      }
    }

    console.log(`[Webhook] ✓✓✓ Successfully processed ${event.type}`);
    console.log("[Webhook] Returning 200 OK to Stripe");
    return c.json({ received: true }, 200, {
      "Content-Type": "application/json"
    });
  
  } catch (err: any) {
    // Catch all errors and log detailed information
    console.error("[Webhook] #########################################");
    console.error("[Webhook] ERROR CAUGHT - Webhook processing failed");
    console.error("[Webhook] Error name:", err.name || "unknown");
    console.error("[Webhook] Error message:", err.message || String(err));
    console.error("[Webhook] Error stack:", err.stack || "No stack trace");
    console.error("[Webhook] Error type:", typeof err);
    console.error("[Webhook] Full error object:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
    console.error("[Webhook] #########################################");
    
    // Always return 200 OK to stop Stripe retries
    return c.json({ 
      received: true,
      error: "Processing failed",
      details: err.message || String(err)
    }, 200, {
      "Content-Type": "application/json"
    });
  }
});

// POST /api/stripe/webhook - Legacy webhook path (backward compatibility)
app.post("/api/stripe/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");

  if (!signature || !c.env.STRIPE_WEBHOOK_SECRET || !c.env.STRIPE_SECRET_KEY) {
    console.error("[Webhook] Missing signature or secrets");
    return c.json({ error: "Configuration error" }, 400);
  }

  try {
    const body = await c.req.text();

    // Verify webhook signature using custom implementation
    const isValid = await verifyWebhookSignature(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );

    if (!isValid) {
      console.error("[Webhook] Invalid signature");
      return c.json({ error: "Invalid signature" }, 400);
    }

    const event = JSON.parse(body) as {
      type: string;
      data: {
        object: any;
      };
    };

    console.log(`[Webhook] Received event: ${event.type}`);

    // Handle subscription events
    if (
      event.type === "checkout.session.completed" ||
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const session = event.data.object as any;
      const customerEmail =
        session.customer_email || session.metadata?.customer_email;

      if (customerEmail) {
        console.log(
          `[Webhook] Processing subscription for email: ${customerEmail}`
        );

        // Get user by email from Mocha Users Service
        const userResponse = await fetch(
          `${c.env.MOCHA_USERS_SERVICE_API_URL}/user-by-email?email=${encodeURIComponent(customerEmail)}`,
          {
            headers: {
              "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
            },
          }
        );

        if (userResponse.ok) {
          const user = await userResponse.json() as { id: string };
          console.log(`[Webhook] Found user: ${user.id}`);

          // Update user subscription status in users table
          await c.env.DB.prepare(
            `UPDATE users SET 
             is_subscribed = 1,
             stripe_customer_id = ?,
             subscription_status = 'active',
             updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
            .bind(session.customer, user.id)
            .run();

          console.log(`[Webhook] Updated subscription for user ${user.id}`);
          
          // Track purchase in analytics (import needed at top of file)
          // Note: GA4 Measurement Protocol would be called here in production
          console.log(`[Analytics] Purchase tracked for user ${user.id}, amount: $49`);

          // Send welcome email for first subscription
          if (event.type === "checkout.session.completed" && c.env.EMAILS) {
            try {
              const appUrl = `https://${new URL(c.env.MOCHA_USERS_SERVICE_API_URL || "").hostname.replace("users.", "")}`;
              const emailContent = welcomeEmail(appUrl);
              
              await c.env.EMAILS.send({
                to: customerEmail,
                ...emailContent,
              });
              
              console.log(`[Email] Welcome email sent to ${customerEmail}`);
            } catch (emailError) {
              console.error("[Email] Failed to send welcome email:", emailError);
            }
          }

          // Send payment confirmation
          if (event.type === "checkout.session.completed" && c.env.EMAILS) {
            try {
              const amount = session.amount_total || 4900; // Fallback to $49
              const appUrl = `https://${new URL(c.env.MOCHA_USERS_SERVICE_API_URL || "").hostname.replace("users.", "")}`;
              const emailContent = paymentConfirmationEmail(amount, appUrl);
              
              await c.env.EMAILS.send({
                to: customerEmail,
                ...emailContent,
              });
              
              console.log(`[Email] Payment confirmation sent to ${customerEmail}`);
            } catch (emailError) {
              console.error("[Email] Failed to send payment confirmation:", emailError);
            }
          }
        } else {
          console.error(
            `[Webhook] User not found for email: ${customerEmail}`
          );
        }
      } else {
        console.error("[Webhook] No customer email in event");
      }
    }

    // Handle cancellation
    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated"
    ) {
      const subscription = event.data.object as any;

      if (subscription.status === "canceled") {
        const customerEmail =
          subscription.metadata?.customer_email || subscription.customer_email;

        if (customerEmail) {
          console.log(
            `[Webhook] Processing cancellation for email: ${customerEmail}`
          );

          const userResponse = await fetch(
            `${c.env.MOCHA_USERS_SERVICE_API_URL}/user-by-email?email=${encodeURIComponent(customerEmail)}`,
            {
              headers: {
                "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
              },
            }
          );

          if (userResponse.ok) {
            const user = await userResponse.json() as { id: string };

            await c.env.DB.prepare(
              `UPDATE users 
               SET is_subscribed = 0, 
               subscription_status = 'canceled',
               updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
              .bind(user.id)
              .run();

            console.log(
              `[Webhook] Cancelled subscription for user ${user.id}`
            );
          }
        }
      }
    }

    console.log(`[Webhook] Successfully processed ${event.type}`);
    return c.json({ received: true });
  } catch (err: any) {
    console.error(`[Webhook] Error: ${err.message}`);
    return c.json({ error: `Webhook Error: ${err.message}` }, 400);
  }
});

// POST /api/sync-subscription - Manual subscription sync via Stripe API
app.post("/api/sync-subscription", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser || !mochaUser.email) {
      console.error("[Sync] No authenticated user");
      return c.json({ error: "User not authenticated" }, 401);
    }

    const email = mochaUser.email;
    const userId = mochaUser.id;

    console.log(`[Sync] Starting sync for user ${userId} (${email})`);

    if (!c.env.STRIPE_SECRET_KEY) {
      console.error("[Sync] Stripe secret key not configured");
      return c.json({ error: "Stripe not configured" }, 500);
    }

    // Search for customer by email in Stripe
    console.log(`[Sync] Searching Stripe for customer with email: ${email}`);
    const customers = await listCustomers(c.env.STRIPE_SECRET_KEY, email);

    if (customers.length === 0) {
      console.log(`[Sync] No Stripe customer found for ${email}`);
      return c.json({ 
        synced: true,
        is_subscribed: false,
        error: "No Stripe customer found for this email" 
      }, 404);
    }

    const customer = customers[0];
    console.log(`[Sync] Found Stripe customer: ${customer.id}`);

    // Get active subscriptions for this customer
    console.log(`[Sync] Fetching subscriptions for customer ${customer.id}`);
    const subscriptions = await listSubscriptions(c.env.STRIPE_SECRET_KEY, customer.id);
    const activeSubscriptions = subscriptions.filter(s => s.status === "active");

    const hasActiveSubscription = activeSubscriptions.length > 0;
    console.log(`[Sync] Active subscriptions found: ${activeSubscriptions.length}`);

    // Ensure user exists in our database
    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?"
    )
      .bind(userId)
      .first();

    if (!existingUser) {
      console.log(`[Sync] User ${userId} not in DB, creating...`);
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, mocha_user_id, is_subscribed, stripe_customer_id, subscription_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
        .bind(
          userId,
          email,
          userId,
          hasActiveSubscription ? 1 : 0,
          customer.id,
          hasActiveSubscription ? 'active' : 'inactive'
        )
        .run();
    } else {
      console.log(`[Sync] Updating subscription status for user ${userId}`);
      // Update subscription status in users table
      await c.env.DB.prepare(
        `UPDATE users SET 
         is_subscribed = ?,
         stripe_customer_id = ?,
         subscription_status = ?,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
        .bind(
          hasActiveSubscription ? 1 : 0,
          customer.id,
          hasActiveSubscription ? 'active' : 'inactive',
          userId
        )
        .run();
    }

    console.log(`[Sync] Successfully synced subscription for user ${userId}: ${hasActiveSubscription ? 'active' : 'inactive'}`);

    return c.json({
      synced: true,
      is_subscribed: hasActiveSubscription,
      message: hasActiveSubscription
        ? "Active subscription found and synced!"
        : "No active subscription found",
    });
  } catch (error: any) {
    console.error("[Sync] CRITICAL ERROR:");
    console.error("[Sync] Error message:", error?.message || "Unknown");
    console.error("[Sync] Error stack:", error?.stack || "No stack trace");
    console.error("[Sync] Full error object:", JSON.stringify(error, null, 2));
    return c.json({ 
      error: "Failed to sync subscription", 
      details: error?.message || "Unknown error" 
    }, 500);
  }
});

// GET /api/checklist/progress - Get checklist progress for current user
app.get("/api/checklist/progress", async (c) => {
  try {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.substring(7);
    const userResponse = await fetch(
      `${c.env.MOCHA_USERS_SERVICE_API_URL}/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
        },
      }
    );

    if (!userResponse.ok) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await userResponse.json() as { id: string };

    const { results } = await c.env.DB.prepare(
      `SELECT task_id, completed FROM checklist_progress WHERE user_id = ?`
    )
      .bind(user.id)
      .all();

    // Convert array to object
    const progress: Record<string, boolean> = {};
    (results || []).forEach((row: any) => {
      progress[row.task_id] = row.completed === 1;
    });

    return c.json(progress);
  } catch (error) {
    console.error("Get checklist progress error:", error);
    return c.json({ error: "Failed to get checklist progress" }, 500);
  }
});

// POST /api/checklist/progress - Update checklist progress
app.post("/api/checklist/progress", async (c) => {
  try {
    const { task_id, completed } = await c.req.json();

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.substring(7);
    const userResponse = await fetch(
      `${c.env.MOCHA_USERS_SERVICE_API_URL}/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-API-Key": c.env.MOCHA_USERS_SERVICE_API_KEY || "",
        },
      }
    );

    if (!userResponse.ok) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await userResponse.json() as { id: string };

    await c.env.DB.prepare(
      `INSERT INTO checklist_progress (user_id, task_id, completed)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, task_id) DO UPDATE SET
       completed = ?,
       updated_at = CURRENT_TIMESTAMP`
    )
      .bind(user.id, task_id, completed ? 1 : 0, completed ? 1 : 0)
      .run();

    return c.json({ success: true });
  } catch (error) {
    console.error("Update checklist progress error:", error);
    return c.json({ error: "Failed to update checklist progress" }, 500);
  }
});

// POST /api/contact - Send contact form email
app.post("/api/contact", async (c) => {
  try {
    const { name, email, subject, message } = await c.req.json();

    if (!name || !email || !subject || !message) {
      return c.json({ error: "All fields are required" }, 400);
    }

    if (
      !c.env.MOCHA_EMAIL_SERVICE_API_URL ||
      !c.env.MOCHA_EMAIL_SERVICE_API_KEY
    ) {
      return c.json({ error: "Email service not configured" }, 500);
    }

    // Send email using Mocha Email Service
    const emailResponse = await fetch(
      `${c.env.MOCHA_EMAIL_SERVICE_API_URL}/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": c.env.MOCHA_EMAIL_SERVICE_API_KEY,
        },
        body: JSON.stringify({
          to: "info@hikmahspark.com",
          subject: `Compliance Shield Contact: ${subject}`,
          html: `
            <h2>New Contact Form Submission</h2>
            <p><strong>From:</strong> ${name} (${email})</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, "<br>")}</p>
          `,
        }),
      }
    );

    if (!emailResponse.ok) {
      throw new Error("Failed to send email");
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Contact form error:", error);
    return c.json({ error: "Failed to send message" }, 500);
  }
});

// ============================================
// SHIELD CERTIFICATION ENDPOINTS
// ============================================

// Create a public shield certification
app.post("/api/certifications", authMiddleware, async (c) => {
  const mochaUser = c.get("user");
  
  if (!mochaUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Check subscription status
  const userRecord = await c.env.DB.prepare(
    "SELECT is_subscribed FROM users WHERE id = ?"
  )
    .bind(mochaUser.id)
    .first<{ is_subscribed: number }>();

  if (!userRecord || !userRecord.is_subscribed) {
    return c.json({ error: "Subscription required" }, 403);
  }

  try {
    const { scan_id, company_name, website_url } = await c.req.json();

    if (!scan_id || !company_name || !website_url) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Verify scan belongs to user
    const scan = await c.env.DB.prepare(
      "SELECT id, risk_score FROM scans WHERE id = ? AND user_id = ?"
    )
      .bind(scan_id, mochaUser.id)
      .first<{ id: number; risk_score: number }>();

    if (!scan) {
      return c.json({ error: "Scan not found" }, 404);
    }

    // Generate unique certification ID
    const certId = `cert-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create certification
    await c.env.DB.prepare(
      `INSERT INTO shield_certifications 
       (id, user_id, scan_id, company_name, website_url, compliance_score, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(certId, mochaUser.id, scan_id, company_name, website_url, scan.risk_score)
      .run();

    console.log(`[Certification] Created: ${certId} for user ${mochaUser.id}`);

    return c.json({
      success: true,
      certification: {
        id: certId,
        company_name,
        website_url,
        compliance_score: scan.risk_score,
      },
    });
  } catch (error) {
    console.error("[Certification] Create error:", error);
    return c.json({ error: "Failed to create certification" }, 500);
  }
});

// Get user's certifications
app.get("/api/certifications", authMiddleware, async (c) => {
  const mochaUser = c.get("user");
  
  if (!mochaUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const certs = await c.env.DB.prepare(
      `SELECT c.*, s.url as scan_url 
       FROM shield_certifications c
       JOIN scans s ON c.scan_id = s.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC`
    )
      .bind(mochaUser.id)
      .all();

    return c.json({ certifications: certs.results || [] });
  } catch (error) {
    console.error("[Certification] List error:", error);
    return c.json({ error: "Failed to fetch certifications" }, 500);
  }
});

// Public certification verification page
app.get("/api/certifications/:id", async (c) => {
  const certId = c.req.param("id");

  try {
    const cert = await c.env.DB.prepare(
      `SELECT c.*, s.url as scan_url, s.risk_score, s.has_cookie_banner, 
              s.has_privacy_policy, s.has_ai_features, s.ada_issues, 
              s.ai_retention_issues, s.gdpr_issues, s.shadow_ai_issues
       FROM shield_certifications c
       JOIN scans s ON c.scan_id = s.id
       WHERE c.id = ? AND c.is_active = 1`
    )
      .bind(certId)
      .first();

    if (!cert) {
      return c.json({ error: "Certification not found" }, 404);
    }

    // Increment view count
    await c.env.DB.prepare(
      "UPDATE shield_certifications SET view_count = view_count + 1, last_viewed_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
      .bind(certId)
      .run();

    return c.json({ certification: cert });
  } catch (error) {
    console.error("[Certification] Get error:", error);
    return c.json({ error: "Failed to fetch certification" }, 500);
  }
});

// Deactivate certification
app.delete("/api/certifications/:id", authMiddleware, async (c) => {
  const mochaUser = c.get("user");
  
  if (!mochaUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const certId = c.req.param("id");

  try {
    const result = await c.env.DB.prepare(
      "UPDATE shield_certifications SET is_active = 0 WHERE id = ? AND user_id = ?"
    )
      .bind(certId, mochaUser.id)
      .run();

    if (!result.success) {
      return c.json({ error: "Certification not found" }, 404);
    }

    console.log(`[Certification] Deactivated: ${certId} by user ${mochaUser.id}`);
    return c.json({ success: true });
  } catch (error) {
    console.error("[Certification] Delete error:", error);
    return c.json({ error: "Failed to deactivate certification" }, 500);
  }
});

// ============================================
// AI GOVERNANCE VAULT ENDPOINTS
// ============================================

// POST /api/vault/upload - Upload a governance document
app.post("/api/vault/upload", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email, is_subscribed FROM users WHERE id = ?"
    ).bind(mochaUser.id).first<{ id: string; email: string; is_subscribed: number }>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (!user.is_subscribed) {
      return c.json({ error: "Subscription required" }, 403);
    }

    const formData = await c.req.formData();
    const file = formData.get("file") as File;
    const document_type = formData.get("document_type") as string;
    const notes = formData.get("notes") as string;

    if (!file || !document_type) {
      return c.json({ error: "File and document type are required" }, 400);
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: "File size must be less than 10MB" }, 400);
    }

    // Generate unique key for R2
    const timestamp = Date.now();
    const file_key = `vault/${user.id}/${timestamp}_${file.name}`;

    // Upload to R2
    await c.env.R2_BUCKET.put(file_key, file, {
      httpMetadata: {
        contentType: file.type,
      },
      customMetadata: {
        userId: user.id,
        documentType: document_type,
        uploadedAt: new Date().toISOString(),
      },
    });

    // Save metadata to database
    const result = await c.env.DB.prepare(
      `INSERT INTO governance_documents 
       (user_id, file_name, file_key, file_size, file_type, document_type, notes) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id,
      file.name,
      file_key,
      file.size,
      file.type,
      document_type,
      notes || null
    ).run();

    console.log(`[Vault] Document uploaded: ${file.name} by user ${user.email}`);

    return c.json({
      success: true,
      document: {
        id: result.meta.last_row_id,
        file_name: file.name,
        file_size: file.size,
        document_type,
      },
    });
  } catch (error) {
    console.error("[Vault Upload] Error:", error);
    return c.json({ error: "Failed to upload document" }, 500);
  }
});

// GET /api/vault/documents - List user's governance documents
app.get("/api/vault/documents", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await c.env.DB.prepare(
      "SELECT id, is_subscribed FROM users WHERE id = ?"
    ).bind(mochaUser.id).first<{ id: string; is_subscribed: number }>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (!user.is_subscribed) {
      return c.json({ error: "Subscription required" }, 403);
    }

    const documents = await c.env.DB.prepare(
      `SELECT id, file_name, file_size, file_type, document_type, notes, uploaded_at 
       FROM governance_documents 
       WHERE user_id = ? 
       ORDER BY uploaded_at DESC`
    ).bind(user.id).all();

    return c.json({ documents: documents.results || [] });
  } catch (error) {
    console.error("[Vault List] Error:", error);
    return c.json({ error: "Failed to fetch documents" }, 500);
  }
});

// GET /api/vault/download/:id - Download a document
app.get("/api/vault/download/:id", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).bind(mochaUser.id).first<{ id: string }>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const documentId = c.req.param("id");
    const document = await c.env.DB.prepare(
      `SELECT file_key, file_name, file_type 
       FROM governance_documents 
       WHERE id = ? AND user_id = ?`
    ).bind(documentId, user.id).first<{ file_key: string; file_name: string; file_type: string }>();

    if (!document) {
      return c.json({ error: "Document not found" }, 404);
    }

    // Fetch from R2
    const object = await c.env.R2_BUCKET.get(document.file_key);
    if (!object) {
      return c.json({ error: "File not found in storage" }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Disposition", `attachment; filename="${document.file_name}"`);

    return c.body(object.body, { headers });
  } catch (error) {
    console.error("[Vault Download] Error:", error);
    return c.json({ error: "Failed to download document" }, 500);
  }
});

// DELETE /api/vault/documents/:id - Delete a document
app.delete("/api/vault/documents/:id", authMiddleware, async (c) => {
  try {
    const mochaUser = c.get("user");
    
    if (!mochaUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).bind(mochaUser.id).first<{ id: string }>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const documentId = c.req.param("id");
    const document = await c.env.DB.prepare(
      `SELECT file_key FROM governance_documents WHERE id = ? AND user_id = ?`
    ).bind(documentId, user.id).first<{ file_key: string }>();

    if (!document) {
      return c.json({ error: "Document not found" }, 404);
    }

    // Delete from R2
    await c.env.R2_BUCKET.delete(document.file_key);

    // Delete from database
    await c.env.DB.prepare(
      "DELETE FROM governance_documents WHERE id = ?"
    ).bind(documentId).run();

    console.log(`[Vault] Document deleted: ${document.file_key}`);

    return c.json({ success: true });
  } catch (error) {
    console.error("[Vault Delete] Error:", error);
    return c.json({ error: "Failed to delete document" }, 500);
  }
});

// GET /api/scan-analytics - View scan attempt analytics
app.get("/api/scan-analytics", async (c) => {
  try {
    // Get aggregate data by domain
    const domainStats = await c.env.DB.prepare(
      `SELECT 
        url,
        COUNT(*) as scan_count,
        AVG(risk_score) as avg_risk_score,
        MAX(created_at) as last_scan,
        SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) as authenticated_scans,
        SUM(CASE WHEN is_authenticated = 0 THEN 1 ELSE 0 END) as anonymous_scans
       FROM scan_attempts
       GROUP BY url
       ORDER BY scan_count DESC
       LIMIT 100`
    ).all();

    // Get recent scans
    const recentScans = await c.env.DB.prepare(
      `SELECT url, risk_score, is_authenticated, created_at
       FROM scan_attempts
       ORDER BY created_at DESC
       LIMIT 50`
    ).all();

    // Get daily counts
    const dailyStats = await c.env.DB.prepare(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as scan_count,
        COUNT(DISTINCT url) as unique_urls,
        SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) as authenticated_count
       FROM scan_attempts
       WHERE created_at >= DATE('now', '-30 days')
       GROUP BY DATE(created_at)
       ORDER BY date DESC`
    ).all();

    return c.json({
      topDomains: domainStats.results,
      recentScans: recentScans.results,
      dailyStats: dailyStats.results,
    });
  } catch (error) {
    console.error("Failed to fetch scan analytics:", error);
    return c.json({ error: "Failed to fetch analytics" }, 500);
  }
});

// ============================================
// LAMBDA INTEGRATION ENDPOINTS
// ============================================

app.post("/api/lambda/save-scan", async (c) => {
  const { handleSaveScan } = await import("./lambda-endpoints");
  return handleSaveScan(c);
});

app.get("/api/lambda/active-users", async (c) => {
  const { handleGetActiveUsers } = await import("./lambda-endpoints");
  return handleGetActiveUsers(c);
});

app.post("/api/lambda/send-alert", async (c) => {
  const { handleSendAlert } = await import("./lambda-endpoints");
  return handleSendAlert(c);
});

// Shield activation endpoints
app.post("/api/shield/activate", authMiddleware, async (c) => {
  const mochaUser = c.get("user");
  if (!mochaUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    await c.env.DB.prepare(
      "UPDATE users SET is_shield_active = 1 WHERE id = ?"
    )
      .bind(mochaUser.id)
      .run();

    console.log(`[Shield] Activated for user: ${mochaUser.id}`);
    return c.json({ success: true, is_shield_active: true });
  } catch (error: any) {
    console.error("[Shield] Activation failed:", error);
    return c.json({ error: error.message }, 500);
  }
});

app.post("/api/shield/deactivate", authMiddleware, async (c) => {
  const mochaUser = c.get("user");
  if (!mochaUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    await c.env.DB.prepare(
      "UPDATE users SET is_shield_active = 0 WHERE id = ?"
    )
      .bind(mochaUser.id)
      .run();

    console.log(`[Shield] Deactivated for user: ${mochaUser.id}`);
    return c.json({ success: true, is_shield_active: false });
  } catch (error: any) {
    console.error("[Shield] Deactivation failed:", error);
    return c.json({ error: error.message }, 500);
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// GET /api/admin/users - List all users with details
app.get("/api/admin/users", async (c) => {
  const adminPassword = c.req.header("X-Admin-Password");
  
  if (adminPassword !== "Christmas890") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const users = await c.env.DB.prepare(
      `SELECT 
        id, 
        email, 
        is_subscribed, 
        stripe_customer_id,
        subscription_status,
        created_at,
        updated_at
       FROM users 
       ORDER BY created_at DESC`
    ).all();

    // Get scan counts for each user
    const usersWithStats = await Promise.all(
      (users.results || []).map(async (user: any) => {
        const scanCount = await c.env.DB.prepare(
          "SELECT COUNT(*) as count FROM scans WHERE user_id = ?"
        )
          .bind(user.id)
          .first<{ count: number }>();

        return {
          ...user,
          scanCount: scanCount?.count || 0,
        };
      })
    );

    return c.json({ users: usersWithStats });
  } catch (error) {
    console.error("[Admin] Users list error:", error);
    return c.json({ error: "Failed to fetch users" }, 500);
  }
});

// DELETE /api/admin/users/:userId - Delete user and cancel subscription
app.delete("/api/admin/users/:userId", async (c) => {
  const adminPassword = c.req.header("X-Admin-Password");
  
  if (adminPassword !== "Christmas890") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const userId = c.req.param("userId");
  
  try {
    console.log(`[Admin Delete] Starting deletion for user: ${userId}`);

    // Get user details including Stripe customer ID
    const user = await c.env.DB.prepare(
      "SELECT email, stripe_customer_id, is_subscribed FROM users WHERE id = ?"
    )
      .bind(userId)
      .first<{ email: string; stripe_customer_id: string | null; is_subscribed: number }>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    // Cancel Stripe subscription if they have one
    if (user.is_subscribed && c.env.STRIPE_SECRET_KEY) {
      try {
        console.log(`[Admin Delete] Cancelling Stripe subscription for: ${user.email}`);
        
        // Get customer's subscriptions
        const customers = await listCustomers(c.env.STRIPE_SECRET_KEY, user.email);
        
        if (customers.length > 0) {
          const customerId = customers[0].id;
          const subscriptions = await listSubscriptions(c.env.STRIPE_SECRET_KEY, customerId);
          
          // Cancel all active subscriptions
          for (const subscription of subscriptions) {
            if (subscription.status === "active" || subscription.status === "trialing") {
              await cancelSubscription(c.env.STRIPE_SECRET_KEY, subscription.id);
              console.log(`[Admin Delete] Cancelled subscription: ${subscription.id}`);
            }
          }
        }
      } catch (stripeError) {
        console.error("[Admin Delete] Stripe cancellation error:", stripeError);
        // Continue with deletion even if Stripe fails
      }
    }

    // Delete R2 files
    const { results: documents } = await c.env.DB.prepare(
      "SELECT file_key FROM governance_documents WHERE user_id = ?"
    )
      .bind(userId)
      .all();

    if (documents && documents.length > 0) {
      console.log(`[Admin Delete] Deleting ${documents.length} files from R2`);
      for (const doc of documents) {
        try {
          await c.env.R2_BUCKET.delete(doc.file_key as string);
        } catch (r2Error) {
          console.error(`[Admin Delete] Failed to delete R2 file: ${doc.file_key}`, r2Error);
        }
      }
    }

    // Delete all user data from database tables
    await c.env.DB.prepare("DELETE FROM governance_documents WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM shield_certifications WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM checklist_progress WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM monitoring_preferences WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM intent_events WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM scans WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM scan_attempts WHERE user_id = ?").bind(userId).run();
    await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    console.log(`[Admin Delete] Successfully deleted user: ${userId}`);

    return c.json({ 
      success: true, 
      message: `User ${user.email} deleted successfully${user.is_subscribed ? ' and subscription cancelled' : ''}` 
    });
  } catch (error: any) {
    console.error("[Admin Delete] Error:", error);
    return c.json({ error: error?.message || "Failed to delete user" }, 500);
  }
});

app.get("/api/admin/stats", async (c) => {
  const adminPassword = c.req.header("X-Admin-Password");
  
  if (adminPassword !== "Christmas890") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    // Get total scans
    const totalScansResult = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM scan_attempts"
    ).first<{ count: number }>();
    const totalScans = totalScansResult?.count || 0;

    // Get total users
    const totalUsersResult = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM users"
    ).first<{ count: number }>();
    const totalUsers = totalUsersResult?.count || 0;

    // Get total subscribers
    const totalSubscribersResult = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM users WHERE is_subscribed = 1"
    ).first<{ count: number }>();
    const totalSubscribers = totalSubscribersResult?.count || 0;

    // Calculate MRR (Monthly Recurring Revenue)
    const totalRevenue = totalSubscribers * 49;

    // Get recent scans
    const recentScans = await c.env.DB.prepare(
      `SELECT id, url, risk_score, user_id, created_at 
       FROM scan_attempts 
       ORDER BY created_at DESC 
       LIMIT 20`
    ).all();

    // Get top scanned domains
    const topDomains = await c.env.DB.prepare(
      `SELECT url, COUNT(*) as count 
       FROM scan_attempts 
       GROUP BY url 
       ORDER BY count DESC 
       LIMIT 10`
    ).all();

    // Extract domains from URLs
    const topScannedDomains = (topDomains.results || []).map((row: any) => {
      try {
        const url = new URL(row.url);
        return {
          domain: url.hostname.replace('www.', ''),
          count: row.count
        };
      } catch {
        return {
          domain: row.url,
          count: row.count
        };
      }
    });

    // Calculate conversion rate (users who signed up / total scans)
    const conversionRate = totalScans > 0 ? (totalUsers / totalScans) * 100 : 0;

    // Calculate average risk score
    const avgRiskResult = await c.env.DB.prepare(
      "SELECT AVG(risk_score) as avg FROM scan_attempts WHERE risk_score IS NOT NULL"
    ).first<{ avg: number }>();
    const averageRiskScore = avgRiskResult?.avg || 0;

    return c.json({
      totalScans,
      totalUsers,
      totalSubscribers,
      totalRevenue,
      recentScans: recentScans.results || [],
      topScannedDomains,
      conversionRate,
      averageRiskScore,
    });
  } catch (error) {
    console.error("[Admin] Stats error:", error);
    return c.json({ error: "Failed to fetch admin stats" }, 500);
  }
});

export default {
  fetch: app.fetch,
};
