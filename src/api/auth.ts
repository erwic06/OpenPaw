import type { AuthDeps } from "./types.ts";

interface JwksKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

interface JwtHeader {
  kid: string;
  alg: string;
}

interface JwtPayload {
  email?: string;
  aud?: string[];
  exp?: number;
  iss?: string;
}

let cachedKeys: Map<string, CryptoKey> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 3600_000; // 1 hour

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart<T>(part: string): T {
  const decoded = new TextDecoder().decode(base64UrlDecode(part));
  return JSON.parse(decoded) as T;
}

async function fetchAndCacheKeys(
  teamDomain: string,
  fetchFn: typeof fetch,
): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (cachedKeys && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch CF Access certs: ${res.status}`);
  }

  const jwks: JwksResponse = await res.json();
  const keys = new Map<string, CryptoKey>();

  for (const key of jwks.keys) {
    if (key.kty !== "RSA") continue;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: key.alg || "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(key.kid, cryptoKey);
  }

  cachedKeys = keys;
  cacheTimestamp = now;
  return keys;
}

export async function validateCfAccess(
  req: Request,
  deps: AuthDeps,
): Promise<boolean> {
  // Dev mode bypass
  if (!deps.teamDomain) return true;

  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    const header = decodeJwtPart<JwtHeader>(parts[0]);
    const payload = decodeJwtPart<JwtPayload>(parts[1]);

    // Check expiration
    if (payload.exp && payload.exp < Date.now() / 1000) return false;

    // Check audience
    if (
      deps.audienceTag &&
      (!payload.aud || !payload.aud.includes(deps.audienceTag))
    ) {
      return false;
    }

    // Check allowed email
    if (deps.allowedEmail && payload.email !== deps.allowedEmail) return false;

    // Verify signature
    const fetchFn = deps.fetchFn ?? fetch;
    const keys = await fetchAndCacheKeys(deps.teamDomain, fetchFn);
    const key = keys.get(header.kid);
    if (!key) return false;

    const signatureBytes = base64UrlDecode(parts[2]);
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes.buffer as ArrayBuffer,
      dataBytes.buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** Reset the JWKS cache (for testing). */
export function resetKeyCache(): void {
  cachedKeys = null;
  cacheTimestamp = 0;
}
