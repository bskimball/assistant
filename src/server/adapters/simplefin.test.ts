import { describe, expect, it } from "vitest";
import { decodeSetupToken, openSecret, sealSecret } from "./simplefin";

describe("simplefin adapter", () => {
  it("decodes setup tokens to HTTPS claim URLs", () => {
    const token = Buffer.from("https://bridge.simplefin.org/simplefin/claim/demo", "utf8").toString(
      "base64",
    );

    expect(decodeSetupToken(token)).toBe("https://bridge.simplefin.org/simplefin/claim/demo");
  });

  it("rejects non-HTTPS setup tokens", () => {
    const token = Buffer.from("http://bridge.simplefin.org/simplefin/claim/demo", "utf8").toString(
      "base64",
    );

    expect(() => decodeSetupToken(token)).toThrow(/HTTPS/);
  });

  it("seals and opens a secret with AES-GCM", async () => {
    const key = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    const sealed = await sealSecret("https://demo:demo@beta-bridge.simplefin.org/simplefin", key);

    expect(sealed).not.toContain("demo");
    await expect(openSecret(sealed, key)).resolves.toBe(
      "https://demo:demo@beta-bridge.simplefin.org/simplefin",
    );
  });
});
