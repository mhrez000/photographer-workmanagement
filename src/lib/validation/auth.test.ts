/** Front-door token hygiene: the same mangled link is forgiven on every page and API route. */
import { describe, expect, it } from "vitest";
import { AcceptInviteInput, cleanToken, InviteTokenInput, ResetPasswordInput, TokenSchema } from "./auth";

const TOKEN = "abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_"; // 43 chars, like 32 random bytes in base64url

describe("TokenSchema", () => {
  it("accepts a clean token and trims plain whitespace", () => {
    expect(TokenSchema.parse(TOKEN)).toBe(TOKEN);
    expect(TokenSchema.parse(`  ${TOKEN} `)).toBe(TOKEN);
    expect(TokenSchema.parse(`${TOKEN}\n`)).toBe(TOKEN);
  });

  it("decodes a percent-encoded trailing space (%20) and a percent-encoded token, like the reset page always did", () => {
    expect(TokenSchema.parse(`${TOKEN}%20`)).toBe(TOKEN);
    expect(TokenSchema.parse(`%20${TOKEN}%20%20`)).toBe(TOKEN);
    expect(TokenSchema.parse(encodeURIComponent(` ${TOKEN} `))).toBe(TOKEN);
    expect(InviteTokenInput.parse({ token: `${TOKEN}%20` })).toEqual({ token: TOKEN });
    expect(ResetPasswordInput.parse({ token: `${TOKEN}%20`, password: "a-long-enough-password" }).token).toBe(TOKEN);
    expect(AcceptInviteInput.parse({ token: ` ${TOKEN}`, password: "a-long-enough-password" }).token).toBe(TOKEN);
  });

  it("still rejects truncated, over-long, malformed and non-string tokens", () => {
    expect(TokenSchema.safeParse(TOKEN.slice(0, 10)).success).toBe(false);
    expect(TokenSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(TokenSchema.safeParse(`${TOKEN}%2`).success).toBe(false); // malformed escape → left as is → '%' fails the regex
    expect(TokenSchema.safeParse(`${TOKEN}%2F`).success).toBe(false); // decodes to "/" → not base64url
    expect(TokenSchema.safeParse("").success).toBe(false);
    expect(TokenSchema.safeParse(null).success).toBe(false);
    expect(TokenSchema.safeParse(42).success).toBe(false);
  });

  it("cleanToken never throws", () => {
    expect(cleanToken("%E0%A4%A")).toBe("%E0%A4%A");
    expect(cleanToken(" a ")).toBe("a");
  });
});
