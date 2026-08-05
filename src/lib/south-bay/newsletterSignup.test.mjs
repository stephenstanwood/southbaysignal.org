import assert from "node:assert/strict";
import test from "node:test";

process.env.NEWSLETTER_CONFIRM_SECRET ||= "test-secret-for-newsletter-confirm";

const {
  CONFIRM_TTL_MS,
  clientIp,
  createConfirmToken,
  isValidEmail,
  rateLimited,
  readConfirmToken,
} = await import("./newsletterSignup.ts");

test("a fresh token round-trips to the address it was minted for", () => {
  const token = createConfirmToken("reader@example.com");
  assert.equal(readConfirmToken(token), "reader@example.com");
});

test("an expired token is rejected", () => {
  const issued = Date.now() - CONFIRM_TTL_MS - 1000;
  const token = createConfirmToken("reader@example.com", issued);
  assert.equal(readConfirmToken(token), null);
});

test("a tampered payload is rejected", () => {
  // Swap the payload for one naming a different address, keeping the signature.
  const token = createConfirmToken("reader@example.com");
  const [, sig] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ e: "attacker@example.com", x: Date.now() + CONFIRM_TTL_MS }),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(readConfirmToken(`${forgedPayload}.${sig}`), null);
});

test("malformed tokens are rejected rather than throwing", () => {
  for (const bad of ["", "nodot", "a.b", ".", "....", "x".repeat(500)]) {
    assert.equal(readConfirmToken(bad), null);
  }
});

test("email validation accepts real addresses and rejects junk", () => {
  assert.equal(isValidEmail("reader@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail(""), false);
});

test("per-IP throttle allows a handful then blocks the burst", () => {
  const ip = "203.0.113.7";
  for (let i = 0; i < 5; i++) {
    assert.equal(rateLimited(ip), false, `signup ${i + 1} should pass`);
  }
  assert.equal(rateLimited(ip), true);
});

test("an unknown client IP is never throttled", () => {
  assert.equal(rateLimited(""), false);
});

test("client IP prefers the first x-forwarded-for hop", () => {
  const request = new Request("https://southbaytoday.org/api/newsletter/subscribe", {
    headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
  });
  assert.equal(clientIp(request), "198.51.100.4");
});
