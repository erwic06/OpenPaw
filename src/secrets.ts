import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SECRETS_DIR = "/run/secrets";

export function loadSecrets(): Map<string, string> {
  const secrets = new Map<string, string>();

  let entries: string[];
  try {
    entries = readdirSync(SECRETS_DIR);
  } catch {
    console.warn(
      `[secrets] ${SECRETS_DIR} not found — running without secrets`,
    );
    return secrets;
  }

  for (const name of entries) {
    const value = readFileSync(join(SECRETS_DIR, name), "utf-8").trim();
    secrets.set(name, value);
  }

  console.log(`[secrets] loaded ${secrets.size} secret(s): ${[...secrets.keys()].join(", ")}`);
  return secrets;
}
