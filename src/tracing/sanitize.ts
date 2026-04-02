export function scrubSecrets(text: string, secrets: Set<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4 && result.includes(secret)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}
