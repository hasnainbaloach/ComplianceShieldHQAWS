// AWS Bedrock client for Claude 3.7 Sonnet using fetch (Cloudflare Workers compatible)
import { AwsClient } from "aws4fetch";

export interface BedrockConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export async function invokeClaudeSonnet(
  config: BedrockConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  // Claude 3.7 Sonnet - 2026 Global Inference Profile (auto-routes to best region)
  const modelId = "us.anthropic.claude-3-7-sonnet-20250219-v1:0";
  
  // Bedrock Converse API endpoint (newer, more stable API)
  const endpoint = `https://bedrock-runtime.${config.region}.amazonaws.com/model/${modelId}/converse`;

  console.log(`[Bedrock] Invoking model: ${modelId}`);
  console.log(`[Bedrock] Region: ${config.region}`);
  console.log(`[Bedrock] Endpoint: ${endpoint}`);
  console.log(`[Bedrock] Access Key ID: ${config.accessKeyId.substring(0, 8)}...`);

  // Create AWS SigV4 signing client for Cloudflare Workers
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "bedrock",
  });

  // Converse API request body (newer format)
  const requestBody = {
    modelId,
    messages: [
      {
        role: "user",
        content: [
          {
            text: userPrompt,
          },
        ],
      },
    ],
    system: [
      {
        text: systemPrompt,
      },
    ],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.3,
    },
  };

  try {
    console.log(`[Bedrock] Sending Converse API request...`);
    
    // Sign and send request using aws4fetch
    const response = await aws.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    console.log(`[Bedrock] Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Bedrock] API Error Response:", errorText);
      
      let errorDetails;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        errorDetails = { message: errorText };
      }

      // Handle specific AWS error types
      if (response.status === 403) {
        throw new Error(
          `AWS Access Denied (403): Check IAM permissions for bedrock:InvokeModel. Error: ${errorDetails.message || errorText}`
        );
      } else if (response.status === 404) {
        throw new Error(
          `Model Not Found (404): Claude 3.7 Sonnet may not be enabled in ${config.region}. Enable it in AWS Bedrock Console. Error: ${errorDetails.message || errorText}`
        );
      } else if (response.status === 429) {
        throw new Error(
          `Rate Limited (429): Too many requests. Wait and retry. Error: ${errorDetails.message || errorText}`
        );
      } else if (response.status === 400) {
        throw new Error(
          `Bad Request (400): Invalid model ID or request format. Error: ${errorDetails.message || errorText}`
        );
      }

      throw new Error(
        `Bedrock API error (${response.status}): ${errorDetails.message || errorText}`
      );
    }

    const responseBody = await response.json() as any;
    console.log(`[Bedrock] ✓ Response received successfully`);

    // Extract text from Converse API response
    if (
      responseBody.output &&
      responseBody.output.message &&
      responseBody.output.message.content &&
      responseBody.output.message.content.length > 0
    ) {
      const contentBlock = responseBody.output.message.content[0];
      if (contentBlock.text) {
        return contentBlock.text;
      }
    }

    throw new Error("No text content in Bedrock Converse response");
  } catch (error: any) {
    // Comprehensive error logging
    console.error("[Bedrock] ==================== ERROR ====================");
    console.error("[Bedrock] Error Type:", error.name);
    console.error("[Bedrock] Error Message:", error.message);
    console.error("[Bedrock] Full Error:", JSON.stringify(error, null, 2));
    console.error("[Bedrock] ==================================================");

    // Re-throw with original error message for troubleshooting
    throw error;
  }
}
