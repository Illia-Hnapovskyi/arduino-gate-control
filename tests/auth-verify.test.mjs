import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test, { after, beforeEach } from "node:test";

import {
  __setJwksForTesting,
  verifySupabaseToken,
} from "../dist/api-test/server/authVerify.js";

const ISSUER = "https://vullhduhswcnlpgnlrtp.supabase.co/auth/v1";

const ecKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherEcKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ecJwk = {
  ...ecKeyPair.publicKey.export({ format: "jwk" }),
  kid: "ec-key",
};
const rsaJwk = {
  ...rsaKeyPair.publicKey.export({ format: "jwk" }),
  kid: "rsa-key",
};
const octJwk = {
  kty: "oct",
  kid: "oct-key",
  k: Buffer.from("not-a-public-key").toString("base64url"),
};

const TEST_JWKS = { keys: [ecJwk, rsaJwk, octJwk] };
const SUBJECT = randomUUID();
const SESSION_ID = randomUUID();

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function makeToken({
  header = {},
  payload = {},
  signWith = "ec",
  corruptSignature = false,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fullHeader = { alg: "ES256", typ: "JWT", kid: "ec-key", ...header };
  const fullPayload = {
    iss: ISSUER,
    aud: "authenticated",
    exp: now + 3_600,
    iat: now,
    sub: SUBJECT,
    role: "authenticated",
    is_anonymous: false,
    session_id: SESSION_ID,
    ...payload,
  };
  const signingInput = `${base64urlJson(fullHeader)}.${base64urlJson(fullPayload)}`;
  let signature;
  if (signWith === "rsa") {
    signature = sign("sha256", Buffer.from(signingInput), rsaKeyPair.privateKey);
  } else if (signWith === "hmac") {
    signature = createHmac("sha256", "shared-secret")
      .update(signingInput)
      .digest();
  } else {
    signature = sign("sha256", Buffer.from(signingInput), {
      key: signWith === "other-ec" ? otherEcKeyPair.privateKey : ecKeyPair.privateKey,
      dsaEncoding: "ieee-p1363",
    });
  }
  if (corruptSignature) signature[0] ^= 0xff;
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

beforeEach(() => {
  __setJwksForTesting(TEST_JWKS);
});

after(() => {
  __setJwksForTesting(null);
});

test("a valid ES256 token passes and yields userId plus sessionId", async () => {
  const result = await verifySupabaseToken(makeToken());
  assert.deepEqual(result, {
    ok: true,
    auth: { userId: SUBJECT, sessionId: SESSION_ID },
  });
});

test("a valid RS256 token passes, including an array audience", async () => {
  const result = await verifySupabaseToken(
    makeToken({
      header: { alg: "RS256", kid: "rsa-key" },
      payload: { aud: ["authenticated", "other"] },
      signWith: "rsa",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.auth.userId, SUBJECT);
});

test("a token without session_id verifies with a null sessionId", async () => {
  const result = await verifySupabaseToken(
    makeToken({ payload: { session_id: undefined } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.auth.sessionId, null);
});

test("an expired token is rejected with AUTH_TOKEN_EXPIRED", async () => {
  const now = Math.floor(Date.now() / 1000);
  const result = await verifySupabaseToken(
    makeToken({ payload: { exp: now - 3_600 } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "AUTH_TOKEN_EXPIRED");
});

test("a token expired within the 60s skew window still passes", async () => {
  const now = Math.floor(Date.now() / 1000);
  const result = await verifySupabaseToken(
    makeToken({ payload: { exp: now - 30 } }),
  );
  assert.equal(result.ok, true);
});

test("a corrupted signature is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ corruptSignature: true }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("a token signed by a different P-256 key is rejected", async () => {
  const result = await verifySupabaseToken(makeToken({ signWith: "other-ec" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("a wrong issuer is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ payload: { iss: "https://evil.example/auth/v1" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("an audience without authenticated is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ payload: { aud: "public" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("alg HS256 is rejected before any key lookup", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { alg: "HS256" }, signWith: "hmac" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("alg none is rejected", async () => {
  const header = base64urlJson({ alg: "none", kid: "ec-key" });
  const payload = base64urlJson({ iss: ISSUER, sub: SUBJECT });
  const result = await verifySupabaseToken(`${header}.${payload}.AA`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("an RS256 header pointing at the EC key is rejected (algorithm confusion)", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { alg: "RS256", kid: "ec-key" }, signWith: "rsa" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("an ES256 header pointing at the RSA key is rejected (algorithm confusion)", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { alg: "ES256", kid: "rsa-key" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("a symmetric oct JWK is rejected outright", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { kid: "oct-key" }, signWith: "hmac" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("anonymous sessions are rejected even with role authenticated", async () => {
  const result = await verifySupabaseToken(
    makeToken({ payload: { is_anonymous: true } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");

  const truthy = await verifySupabaseToken(
    makeToken({ payload: { is_anonymous: "false" } }),
  );
  assert.equal(truthy.ok, false);
});

test("a header without kid is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { kid: undefined } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("an unknown kid is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ header: { kid: "missing-key" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("a non-UUID subject is rejected", async () => {
  const result = await verifySupabaseToken(
    makeToken({ payload: { sub: "service_role" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTH_TOKEN_INVALID");
});

test("structurally malformed tokens are rejected without a key fetch", async () => {
  __setJwksForTesting(null);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch must not run for malformed tokens");
  };
  try {
    for (const token of ["", "abc", "a.b", "a.b.c.d", "?.?.?"]) {
      const result = await verifySupabaseToken(token);
      assert.equal(result.ok, false);
      assert.equal(result.code, "AUTH_TOKEN_INVALID");
    }
  } finally {
    globalThis.fetch = previousFetch;
    __setJwksForTesting(TEST_JWKS);
  }
});

test("an unavailable JWKS endpoint maps to 503 AUTH_KEYS_UNAVAILABLE", async () => {
  __setJwksForTesting(null);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  try {
    const result = await verifySupabaseToken(makeToken());
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "AUTH_KEYS_UNAVAILABLE");
  } finally {
    globalThis.fetch = previousFetch;
    __setJwksForTesting(TEST_JWKS);
  }
});

test("a JWKS fetch timeout maps to 503 AUTH_KEYS_UNAVAILABLE", async () => {
  __setJwksForTesting(null);
  const previousFetch = globalThis.fetch;
  let receivedSignal;
  // The fetch must carry an abort signal; rejecting the way an aborted fetch
  // does proves the timeout path surfaces as a bounded 503 instead of hanging.
  globalThis.fetch = async (_url, options) => {
    receivedSignal = options?.signal;
    throw Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
  };
  try {
    const result = await verifySupabaseToken(makeToken());
    assert.ok(
      receivedSignal instanceof AbortSignal,
      "the JWKS fetch must pass an AbortSignal timeout",
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "AUTH_KEYS_UNAVAILABLE");

    // A timed-out fetch must not poison the cache: the next call retries.
    const retry = await verifySupabaseToken(makeToken());
    assert.equal(retry.ok, false);
    assert.equal(retry.code, "AUTH_KEYS_UNAVAILABLE");
  } finally {
    globalThis.fetch = previousFetch;
    __setJwksForTesting(TEST_JWKS);
  }
});

test("concurrent cache misses share a single JWKS fetch", async () => {
  __setJwksForTesting(null);
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify(TEST_JWKS), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const results = await Promise.all([
      verifySupabaseToken(makeToken()),
      verifySupabaseToken(makeToken()),
      verifySupabaseToken(makeToken()),
    ]);
    for (const result of results) {
      assert.equal(result.ok, true);
      assert.equal(result.auth.userId, SUBJECT);
    }
    assert.equal(fetchCount, 1);

    // The successful document is cached, so no further fetch is issued.
    const cached = await verifySupabaseToken(makeToken());
    assert.equal(cached.ok, true);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    __setJwksForTesting(TEST_JWKS);
  }
});
