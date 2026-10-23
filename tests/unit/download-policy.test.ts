import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_REDIRECT_HOSTS,
  MAX_REDIRECT_HOPS,
  evaluateRedirectHop,
  getHeadersForUrl,
} from "../../src/download-policy";

const GH = "https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.2.0/SHA256SUMS";
const CDN = "https://release-assets.githubusercontent.com/some/path?token=abc";
const API = "https://api.github.com/repos/StellarCanary/Protocol-Canary/releases/tags/v0.2.0";

interface HopCase {
  name: string;
  from: string;
  to: string;
  hop?: number;
  allowed: boolean;
  reasonIncludes?: string;
}

const cases: HopCase[] = [
  { name: "api -> github allowed", from: API, to: GH, allowed: true },
  { name: "github -> cdn allowed", from: GH, to: CDN, allowed: true },
  { name: "cdn -> github allowed", from: CDN, to: GH, allowed: true },
  { name: "github -> github allowed (self)", from: GH, to: GH, allowed: true },
  { name: "https -> http rejected", from: GH, to: "http://github.com/x", allowed: false, reasonIncludes: "https" },
  { name: "https -> http on cdn rejected", from: CDN, to: "http://release-assets.githubusercontent.com/x", allowed: false, reasonIncludes: "https" },
  { name: "file: scheme rejected", from: GH, to: "file:///etc/passwd", allowed: false, reasonIncludes: "https" },
  { name: "data: scheme rejected", from: GH, to: "data:text/plain,hi", allowed: false, reasonIncludes: "https" },
  { name: "javascript: scheme rejected", from: GH, to: "javascript:alert(1)", allowed: false, reasonIncludes: "https" },
  { name: "unknown host rejected", from: GH, to: "https://evil.example/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "look-alike github.com.evil.example rejected", from: GH, to: "https://github.com.evil.example/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "look-alike evilgithub.com rejected", from: GH, to: "https://evilgithub.com/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "subdomain of github.com rejected", from: GH, to: "https://raw.github.com/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "IPv4 literal rejected", from: GH, to: "https://192.168.0.1/x", allowed: false, reasonIncludes: "IP literal" },
  { name: "IPv6 literal rejected", from: GH, to: "https://[2001:db8::1]/x", allowed: false, reasonIncludes: "IP literal" },
  { name: "userinfo rejected", from: GH, to: "https://user:pass@github.com/x", allowed: false, reasonIncludes: "userinfo" },
  { name: "source with userinfo rejected", from: "https://user:pass@github.com/x", to: GH, allowed: false, reasonIncludes: "userinfo" },
  { name: "non-default port rejected", from: GH, to: "https://github.com:8443/x", allowed: false, reasonIncludes: "port" },
  { name: "source non-default port rejected", from: "https://github.com:8443/x", to: GH, allowed: false, reasonIncludes: "port" },
  { name: "trailing dot host rejected", from: GH, to: "https://github.com./x", allowed: false, reasonIncludes: "allow-list" },
  { name: "uppercase host allowed", from: GH, to: "https://GITHUB.COM/x", allowed: true },
  { name: "percent-encoded host rejected", from: GH, to: "https://%67ithub.com/x", allowed: false, reasonIncludes: "percent-encoded" },
  { name: "relative target resolved and allowed", from: GH, to: "/foo/bar", allowed: true },
  { name: "protocol-relative target allowed", from: GH, to: "//release-assets.githubusercontent.com/x", allowed: true },
  { name: "protocol-relative to evil rejected", from: GH, to: "//evil.example/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "hop at limit bound (== max) rejected", from: GH, to: CDN, hop: MAX_REDIRECT_HOPS, allowed: false, reasonIncludes: "maximum" },
  { name: "hop above limit rejected", from: GH, to: CDN, hop: MAX_REDIRECT_HOPS + 1, allowed: false, reasonIncludes: "maximum" },
  { name: "hop 0 allowed", from: GH, to: CDN, hop: 0, allowed: true },
  { name: "negative hop rejected", from: GH, to: CDN, hop: -1, allowed: false, reasonIncludes: "hop index" },
];

describe("evaluateRedirectHop", () => {
  it.each(cases)("$name", ({ from, to, hop, allowed, reasonIncludes }) => {
    const result = evaluateRedirectHop(from, to, hop ?? 0);
    expect(result.allowed).toBe(allowed);
    if (reasonIncludes !== undefined) {
      expect(result.reason.toLowerCase()).toContain(reasonIncludes.toLowerCase());
    }
  });

  it("does not throw on unknown schemes", () => {
    expect(() => evaluateRedirectHop(GH, "gopher://github.com/x", 0)).not.toThrow();
  });
});

describe("getHeadersForUrl", () => {
  it("attaches Authorization for api.github.com when token present", () => {
    const h = getHeadersForUrl(API, { token: "secret" });
    expect(h.Authorization).toBe("Bearer secret");
  });
  it("never attaches Authorization for github.com", () => {
    const h = getHeadersForUrl(GH, { token: "secret" });
    expect(h.Authorization).toBeUndefined();
  });
  it("never attaches Authorization for the CDN host", () => {
    const h = getHeadersForUrl(CDN, { token: "secret" });
    expect(h.Authorization).toBeUndefined();
  });
  it("omits Authorization when token empty", () => {
    const h = getHeadersForUrl(API, { token: "" });
    expect(h.Authorization).toBeUndefined();
  });
  it("omits Authorization when no token", () => {
    const h = getHeadersForUrl(API, {});
    expect(h.Authorization).toBeUndefined();
  });
  it("includes a User-Agent always", () => {
    expect(getHeadersForUrl(API, { token: "x" })["User-Agent"]).toBeDefined();
    expect(getHeadersForUrl(GH, {})["User-Agent"]).toBeDefined();
  });
});

describe("policy constants", () => {
  it("exposes an explicit allow-list", () => {
    expect(ALLOWED_REDIRECT_HOSTS).toEqual([
      "api.github.com",
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
  });
  it("caps hops at 3", () => {
    expect(MAX_REDIRECT_HOPS).toBe(3);
  });
});

describe("module isolation (#425)", () => {
  it("is imported by no runtime file other than the module itself", () => {
    const srcDir = path.join(__dirname, "..", "..", "src");
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const violations: string[] = [];
    for (const f of files) {
      if (f === "download-policy.ts") continue;
      const content = fs.readFileSync(path.join(srcDir, f), "utf8");
      if (/download-policy/.test(content)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });

  it("imports no network module", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "download-policy.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/from\s+["']https["']/);
    expect(content).not.toMatch(/from\s+["']http["']/);
    expect(content).not.toMatch(/from\s+["']node:https["']/);
    expect(content).not.toMatch(/from\s+["']node:http["']/);
    expect(content).not.toMatch(/require\(["']net["']\)/);
    expect(content).not.toMatch(/\bfetch\(/);
  });
});
