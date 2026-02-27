interface EmailParams {
  to: string;
  subject: string;
  html_body?: string;
  text_body?: string;
  reply_to?: string;
  customer_id?: string;
}

interface EmailResult {
  success: boolean;
  message_id?: string;
  error?: string;
}

interface EmailService {
  send(params: EmailParams): Promise<EmailResult>;
}

// Extend the Env interface to add our custom secrets
declare module "cloudflare:workers" {
  interface Env {
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    OPENAI_API_KEY?: string;
    FIRECRAWL_API_KEY?: string;
    EMAILS: EmailService;
    R2_BUCKET: R2Bucket;
  }
}

// Extend the global Env interface
declare global {
  interface Env {
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    OPENAI_API_KEY?: string;
    FIRECRAWL_API_KEY?: string;
    EMAILS: EmailService;
    R2_BUCKET: R2Bucket;
  }
}

export {};
