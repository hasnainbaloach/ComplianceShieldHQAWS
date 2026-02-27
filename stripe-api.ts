// Lightweight Stripe API client - direct fetch calls instead of heavy SDK

export async function createCheckoutSession(
  apiKey: string,
  params: {
    customer_email: string;
    success_url: string;
    cancel_url: string;
    user_id?: string;
    scan_url?: string;
    scan_id?: string;
  }
): Promise<{ url: string | null }> {
  // Build metadata object
  const metadata: Record<string, string> = {};
  if (params.user_id) metadata.user_id = params.user_id;
  if (params.scan_url) metadata.scan_url = params.scan_url;
  if (params.scan_id) metadata.scan_id = params.scan_id;

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2023-10-16",
    },
    body: new URLSearchParams({
      "payment_method_types[0]": "card",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Compliance Shield - Monthly Subscription",
      "line_items[0][price_data][product_data][description]": "Includes: AI compliance scanner • Self-service remediation checklist • AI & Privacy policy templates • Weekly automated monitoring with email alerts • Cancel anytime",
      "line_items[0][price_data][unit_amount]": "4900",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][quantity]": "1",
      "mode": "subscription",
      "success_url": params.success_url,
      "cancel_url": params.cancel_url,
      "customer_email": params.customer_email,
      "allow_promotion_codes": "true",
      "billing_address_collection": "auto",
      "subscription_data[description]": "Recurring monthly subscription - $49/month billed automatically. Cancel anytime from your dashboard.",
      ...Object.entries(metadata).reduce((acc, [key, value]) => ({
        ...acc,
        [`metadata[${key}]`]: value,
      }), {}),
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Stripe checkout error:", error);
    throw new Error(`Stripe API error: ${response.status}`);
  }

  const data = await response.json() as { url: string | null };
  return data;
}

export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  // Parse the signature header
  const elements = signature.split(',');
  const timestamp = elements.find(e => e.startsWith('t='))?.split('=')[1];
  const signatures = elements.filter(e => e.startsWith('v1='));

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  // Construct the signed payload
  const signedPayload = `${timestamp}.${payload}`;

  // Compute HMAC SHA256 signature using Web Crypto API
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const expectedSignature = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Compare with provided signatures
  for (const sig of signatures) {
    const providedSignature = sig.split('=')[1];
    if (providedSignature === expectedSignature) {
      return true;
    }
  }

  return false;
}

export async function listCustomers(
  apiKey: string,
  email: string
): Promise<Array<{ id: string; email: string }>> {
  const response = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Stripe-Version": "2023-10-16",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Stripe API error: ${response.status}`);
  }

  const data = await response.json() as {
    data: Array<{ id: string; email: string }>;
  };
  
  return data.data;
}

export async function listSubscriptions(
  apiKey: string,
  customerId: string
): Promise<Array<{ id: string; status: string }>> {
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${customerId}&limit=10`,
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Stripe-Version": "2023-10-16",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Stripe API error: ${response.status}`);
  }

  const data = await response.json() as {
    data: Array<{ id: string; status: string }>;
  };
  
  return data.data;
}

export async function cancelSubscription(
  apiKey: string,
  subscriptionId: string
): Promise<boolean> {
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
    {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Stripe-Version": "2023-10-16",
      },
    }
  );

  return response.ok;
}
