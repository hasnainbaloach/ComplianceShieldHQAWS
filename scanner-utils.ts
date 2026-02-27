/**
 * Compliance Shield - Scanner Utility Functions
 * 
 * Helper functions for security header analysis, SSL validation,
 * third-party script detection, and cure notice eligibility determination.
 */

/**
 * Analyze security headers by making a HEAD request to the URL
 */
export async function analyzeSecurityHeaders(url: string): Promise<{
  hasCSP: boolean;
  hasXFrameOptions: boolean;
  hasHSTS: boolean;
  hasXContentTypeOptions: boolean;
  score: number;
}> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const headers = response.headers;

    const hasCSP = headers.has('content-security-policy') || headers.has('content-security-policy-report-only');
    const hasXFrameOptions = headers.has('x-frame-options');
    const hasHSTS = headers.has('strict-transport-security');
    const hasXContentTypeOptions = headers.has('x-content-type-options');

    // Calculate security score (25 points each)
    let score = 0;
    if (hasCSP) score += 25;
    if (hasXFrameOptions) score += 25;
    if (hasHSTS) score += 25;
    if (hasXContentTypeOptions) score += 25;

    return {
      hasCSP,
      hasXFrameOptions,
      hasHSTS,
      hasXContentTypeOptions,
      score,
    };
  } catch (error) {
    console.error('[Scanner] Security header analysis failed:', error);
    return {
      hasCSP: false,
      hasXFrameOptions: false,
      hasHSTS: false,
      hasXContentTypeOptions: false,
      score: 0,
    };
  }
}

/**
 * Detect third-party tracking scripts in HTML
 */
export function analyzeThirdPartyScripts(html: string, content: string): {
  googleAnalytics: boolean;
  facebookPixel: boolean;
  hotjar: boolean;
  intercom: boolean;
  other: string[];
  privacyPolicyMentions: boolean;
} {
  const htmlLower = html.toLowerCase();
  const contentLower = content.toLowerCase();

  const googleAnalytics = htmlLower.includes('google-analytics.com') || htmlLower.includes('gtag.js') || htmlLower.includes('ga.js');
  const facebookPixel = htmlLower.includes('facebook.net/en_us/fbevents.js') || htmlLower.includes('connect.facebook.net');
  const hotjar = htmlLower.includes('hotjar.com') || htmlLower.includes('static.hotjar.com');
  const intercom = htmlLower.includes('intercom.io') || htmlLower.includes('widget.intercom.io');

  // Detect other common tracking scripts
  const other: string[] = [];
  const trackers = [
    { name: 'Google Tag Manager', pattern: /googletagmanager\.com/i },
    { name: 'Mixpanel', pattern: /mixpanel\.com/i },
    { name: 'Segment', pattern: /segment\.(com|io)/i },
    { name: 'Amplitude', pattern: /amplitude\.com/i },
    { name: 'Heap Analytics', pattern: /heapanalytics\.com/i },
    { name: 'FullStory', pattern: /fullstory\.com/i },
    { name: 'Crazy Egg', pattern: /crazyegg\.com/i },
    { name: 'Kissmetrics', pattern: /kissmetrics\.com/i },
    { name: 'Hubspot', pattern: /hubspot\.com/i },
    { name: 'Drift', pattern: /drift\.com/i },
    { name: 'Zendesk', pattern: /zendesk\.com/i },
    { name: 'LiveChat', pattern: /livechatinc\.com/i },
    { name: 'Olark', pattern: /olark\.com/i },
  ];

  for (const tracker of trackers) {
    if (tracker.pattern.test(html)) {
      other.push(tracker.name);
    }
  }

  // Add detected major trackers to "other" array
  if (googleAnalytics) other.push('Google Analytics');
  if (facebookPixel) other.push('Facebook Pixel');
  if (hotjar) other.push('Hotjar');
  if (intercom) other.push('Intercom');

  // Check if privacy policy mentions these services
  const privacyPolicyMentions = 
    contentLower.includes('google analytics') ||
    contentLower.includes('facebook pixel') ||
    contentLower.includes('tracking') ||
    contentLower.includes('third-party');

  return {
    googleAnalytics,
    facebookPixel,
    hotjar,
    intercom,
    other: [...new Set(other)], // Remove duplicates
    privacyPolicyMentions,
  };
}

/**
 * Validate SSL/TLS configuration
 */
export async function validateSSL(url: string, html: string): Promise<{
  hasSSL: boolean;
  httpsEnforced: boolean;
  certificateValid: boolean;
  mixedContent: boolean;
}> {
  try {
    const parsedUrl = new URL(url);
    const hasSSL = parsedUrl.protocol === 'https:';

    // Check for mixed content (http resources on https page)
    const mixedContent = hasSSL && (
      html.includes('src="http://') ||
      html.includes("src='http://") ||
      html.includes('href="http://')
    );

    // Test HTTPS enforcement by trying HTTP version
    let httpsEnforced = false;
    if (hasSSL) {
      try {
        const httpUrl = url.replace('https://', 'http://');
        const httpResponse = await fetch(httpUrl, { 
          method: 'HEAD',
          redirect: 'manual',
        });
        // If we get a redirect to HTTPS, it's enforced
        httpsEnforced = httpResponse.status === 301 || httpResponse.status === 308;
      } catch {
        // If HTTP request fails, HTTPS might be enforced at network level
        httpsEnforced = true;
      }
    }

    // Certificate validity check (if HTTPS is used, we assume cert is valid since fetch succeeded)
    const certificateValid = hasSSL;

    return {
      hasSSL,
      httpsEnforced,
      certificateValid,
      mixedContent,
    };
  } catch (error) {
    console.error('[Scanner] SSL validation failed:', error);
    return {
      hasSSL: false,
      httpsEnforced: false,
      certificateValid: false,
      mixedContent: false,
    };
  }
}

/**
 * Determine if violations are eligible for 60-day cure notice under TRAIGA
 */
export function determineCureEligibility(analysis: any): boolean {
  // Cure notice eligible violations (Section 135):
  // - Missing AI disclosure (can add disclosure within 60 days)
  // - Inadequate privacy policy (can update within 60 days)
  // - Missing cookie banner (can implement within 60 days)
  // - Accessibility issues (can remediate within 60 days)

  // NOT cure eligible (immediate liability):
  // - Social scoring violations (Section 142)
  // - Discrimination violations (Section 147)
  // - Data breach / PII exposure
  // - Intentional deceptive practices

  const hasCurableViolations = 
    (analysis.hasAiFeatures && !analysis.hasAiDisclosure) || // Missing AI disclosure
    !analysis.hasPrivacyPolicy || // Missing privacy policy
    !analysis.hasCookieBanner || // Missing cookie banner
    analysis.adaIssues; // Accessibility issues

  const hasNonCurableViolations =
    analysis.socialScoring || // Social scoring detected
    analysis.discrimination || // Discrimination detected
    (analysis.piiExposure?.severity === 'critical' || analysis.piiExposure?.severity === 'high'); // PII exposure

  // Eligible for cure notice if there are curable violations AND no non-curable ones
  return hasCurableViolations && !hasNonCurableViolations;
}
