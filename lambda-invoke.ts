/**
 * AWS Lambda Invocation Helper
 * 
 * Properly signs and invokes Lambda functions from Cloudflare Workers
 * using AWS Signature Version 4
 */

import { AwsClient } from "aws4fetch";

export interface LambdaInvokeOptions {
  functionArn: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload: any;
}

export async function invokeLambda(options: LambdaInvokeOptions): Promise<any> {
  const { functionArn, region, accessKeyId, secretAccessKey, payload } = options;
  
  // Extract function name from ARN
  // ARN format: arn:aws:lambda:us-east-1:123456789012:function:FunctionName
  const functionName = functionArn.split(":").pop() || functionArn;
  
  // Lambda invoke endpoint
  const lambdaUrl = `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${functionName}/invocations`;
  
  console.log(`[Lambda Invoke] Calling ${functionName} in ${region}`);
  
  // Create AWS4 client for signing
  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region,
    service: "lambda",
  });
  
  // Sign and send request
  const response = await aws.fetch(lambdaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Lambda Invoke] Failed: ${response.status} - ${errorText}`);
    throw new Error(`Lambda invocation failed: ${response.status}`);
  }
  
  const result = await response.json();
  console.log(`[Lambda Invoke] Success:`, result);
  
  return result;
}
