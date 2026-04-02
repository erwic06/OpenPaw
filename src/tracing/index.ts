export { scrubSecrets } from "./sanitize.ts";

export interface TracingDeps {
  laminarApiKey?: string;
  secretValues: Set<string>;
}

let initialized = false;
let secretValues: Set<string> = new Set();

export function initTracing(deps: TracingDeps): void {
  secretValues = deps.secretValues;

  if (!deps.laminarApiKey) {
    console.log("[tracing] no laminar_api_key — tracing disabled");
    return;
  }

  try {
    const { Laminar } = require("@lmnr-ai/lmnr");
    Laminar.initialize({ projectApiKey: deps.laminarApiKey });
    initialized = true;
    console.log("[tracing] Laminar initialized");
  } catch (err) {
    console.error("[tracing] failed to initialize Laminar:", err);
  }
}

export async function traceSession<T>(
  name: string,
  metadata: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!initialized) return fn();

  try {
    const { observe } = require("@lmnr-ai/lmnr");
    return await observe({ name, ...metadata }, fn);
  } catch {
    return fn();
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!initialized) return;

  try {
    const { Laminar } = require("@lmnr-ai/lmnr");
    await Laminar.shutdown();
    initialized = false;
    console.log("[tracing] Laminar shut down");
  } catch (err) {
    console.error("[tracing] shutdown error:", err);
  }
}

export function isTracingInitialized(): boolean {
  return initialized;
}

export function getSecretValues(): Set<string> {
  return secretValues;
}
