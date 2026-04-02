import { describe, test, expect, beforeEach } from "bun:test";
import { validateCfAccess, resetKeyCache } from "../src/api/auth.ts";
import type { AuthDeps } from "../src/api/types.ts";

beforeEach(() => {
  resetKeyCache();
});

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", { headers });
}

describe("validateCfAccess", () => {
  test("bypasses auth when teamDomain is empty", async () => {
    const deps: AuthDeps = { teamDomain: "", audienceTag: "" };
    const result = await validateCfAccess(makeRequest(), deps);
    expect(result).toBe(true);
  });

  test("returns false when no JWT header present", async () => {
    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "aud123",
      fetchFn: async () => new Response("{}"),
    };
    const result = await validateCfAccess(makeRequest(), deps);
    expect(result).toBe(false);
  });

  test("returns false for malformed JWT (wrong number of parts)", async () => {
    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "aud123",
      fetchFn: async () => new Response("{}"),
    };
    const req = makeRequest({ "cf-access-jwt-assertion": "not.a.valid.jwt" });
    const result = await validateCfAccess(req, deps);
    expect(result).toBe(false);
  });

  test("returns false for expired JWT", async () => {
    // Create a JWT with expired timestamp
    const header = { kid: "key1", alg: "RS256" };
    const payload = { exp: Math.floor(Date.now() / 1000) - 3600, email: "test@example.com" };
    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const fakeJwt = `${headerB64}.${payloadB64}.fakesignature`;

    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "",
      fetchFn: async () => new Response(JSON.stringify({ keys: [] })),
    };
    const req = makeRequest({ "cf-access-jwt-assertion": fakeJwt });
    const result = await validateCfAccess(req, deps);
    expect(result).toBe(false);
  });

  test("returns false when audience tag doesn't match", async () => {
    const header = { kid: "key1", alg: "RS256" };
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ["wrong-aud"],
      email: "test@example.com",
    };
    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const fakeJwt = `${headerB64}.${payloadB64}.fakesignature`;

    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "correct-aud",
      fetchFn: async () => new Response(JSON.stringify({ keys: [] })),
    };
    const req = makeRequest({ "cf-access-jwt-assertion": fakeJwt });
    const result = await validateCfAccess(req, deps);
    expect(result).toBe(false);
  });

  test("returns false when email doesn't match allowedEmail", async () => {
    const header = { kid: "key1", alg: "RS256" };
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ["aud123"],
      email: "wrong@example.com",
    };
    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const fakeJwt = `${headerB64}.${payloadB64}.fakesignature`;

    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "aud123",
      allowedEmail: "correct@example.com",
      fetchFn: async () => new Response(JSON.stringify({ keys: [] })),
    };
    const req = makeRequest({ "cf-access-jwt-assertion": fakeJwt });
    const result = await validateCfAccess(req, deps);
    expect(result).toBe(false);
  });

  test("verifies JWT signature with real key pair", async () => {
    // Generate a test RSA key pair
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );

    // Export public key as JWK
    const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    // Create JWT
    const header = { kid: "test-key", alg: "RS256" };
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ["test-aud"],
      email: "eric@example.com",
    };

    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const headerB64 = encode(header);
    const payloadB64 = encode(payload);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, signingInput);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const jwt = `${headerB64}.${payloadB64}.${sigB64}`;

    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "test-aud",
      allowedEmail: "eric@example.com",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            keys: [{ kid: "test-key", kty: "RSA", n: pubJwk.n, e: pubJwk.e, alg: "RS256" }],
          }),
        ),
    };

    const req = makeRequest({ "cf-access-jwt-assertion": jwt });
    const result = await validateCfAccess(req, deps);
    expect(result).toBe(true);
  });

  test("caches JWKS keys across calls", async () => {
    let fetchCount = 0;
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const header = { kid: "cache-key", alg: "RS256" };
    const payload = { exp: Math.floor(Date.now() / 1000) + 3600, aud: ["aud"], email: "e@x.com" };
    const headerB64 = encode(header);
    const payloadB64 = encode(payload);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, signingInput);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${headerB64}.${payloadB64}.${sigB64}`;

    const deps: AuthDeps = {
      teamDomain: "example",
      audienceTag: "aud",
      fetchFn: async () => {
        fetchCount++;
        return new Response(
          JSON.stringify({ keys: [{ kid: "cache-key", kty: "RSA", n: pubJwk.n, e: pubJwk.e, alg: "RS256" }] }),
        );
      },
    };

    const req1 = makeRequest({ "cf-access-jwt-assertion": jwt });
    await validateCfAccess(req1, deps);
    const req2 = makeRequest({ "cf-access-jwt-assertion": jwt });
    await validateCfAccess(req2, deps);

    expect(fetchCount).toBe(1); // Only fetched once, second call used cache
  });
});
