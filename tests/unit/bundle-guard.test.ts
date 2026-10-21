import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FreshBuildResult } from "../helpers/fresh-build";
import { freshBuild } from "../helpers/fresh-build";
import bundleGuardFixture from "../fixtures/bundle-guard.json";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMMITTED_BUNDLE = path.join(REPO_ROOT, "dist", "index.js");

// Patterns that would change the bundle's risk profile. `eval(` (with the
// call paren) deliberately ignores identifiers such as `retrieval()`, and
// `new Function(` ignores the unrelated bare `Function("return this")()`
// get-global-this polyfill already present in the bundle.

interface BundleGuardFixture {
  readonly measuredAt: string;
  readonly committedBundleBytes: number;
  readonly sizeBudgetBytes: number;
  readonly sizeBudgetNote: string;
  readonly allowedUrlHosts: readonly { readonly host: string; readonly from: string }[];
}
const fixture = bundleGuardFixture as unknown as BundleGuardFixture;
const allowedHosts = new Set(fixture.allowedUrlHosts.map((entry) => entry.host));

const URL_RE = /https?:\/\/[^\s"'`()\[\]<]+/g;

function extractUrlHosts(bundle: string): string[] {
  const hosts = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(bundle)) !== null) {
    try {
      const hostname = new URL(match[0]).hostname;
      // Ignore template-literal placeholders (e.g. `http://${r}`) and other
      // non-host hostnames; only real domain/IP hosts are reviewed.
      if (/^[A-Za-z0-9.-]+$/.test(hostname)) {
        hosts.add(hostname);
      }
    } catch {
      // Ignore malformed URL fragments; only real hosts matter.
    }
  }
  return [...hosts];
}

function assertNoEval(bundle: string): void {
  expect(bundle).not.toMatch(/\beval\(/);
}
function assertNoNewFunction(bundle: string): void {
  expect(bundle).not.toMatch(/new Function\(/);
}

function assertAllowedUrlHosts(bundle: string): void {
  const hosts = extractUrlHosts(bundle);
  for (const host of hosts) {
    expect(allowedHosts.has(host)).toBe(true);
  }
}

function assertSizeBudget(bundle: string): void {
  const bytes = Buffer.byteLength(bundle, "utf8");
  expect(bytes).toBeLessThanOrEqual(fixture.sizeBudgetBytes);
}

function assertFreshMapSourcesAreRelative(mapText: string): void {
  let map: { sources?: unknown };
  try {
    map = JSON.parse(mapText);
  } catch (error) {
    throw new Error(`Fresh source map does not parse as JSON: ${String(error)}`);
  }
  const sources = map.sources;
  expect(Array.isArray(sources)).toBe(true);
  for (const source of sources as string[]) {
    expect(typeof source).toBe("string");
    expect(path.isAbsolute(source)).toBe(false);
    expect(/^[a-zA-Z]:[\\/]/.test(source)).toBe(false);
    expect(source === "/tmp" || source.startsWith("/tmp/")).toBe(false);
    expect(looksLikeHomeDirectory(source)).toBe(false);
  }
}

function looksLikeHomeDirectory(source: string): boolean {
  const home = os.homedir();
  if (home && source.includes(home)) {
    return true;
  }
  return /^\/home\//.test(source) || /^\/Users\//.test(source) || /^\/root\//.test(source);
}

/** Builds in a temp directory, runs assertions, and always removes the temp directory. */
async function withFreshBuild(test: (result: FreshBuildResult) => Promise<void> | void): Promise<void> {
  let result: FreshBuildResult | undefined;
  try {
    result = freshBuild();
    await test(result);
  } finally {
    if (result !== undefined) {
      result.cleanup();
    }
  }
}

describe("bundle guard", () => {
  const committed = fs.readFileSync(COMMITTED_BUNDLE, "utf8");

  it("contains no eval(", () => {
    assertNoEval(committed);
  });

  it("contains no new Function(", () => {
    assertNoNewFunction(committed);
  });

  it("only references reviewed URL hosts", () => {
    assertAllowedUrlHosts(committed);
  });

  it("stays below the documented size budget", () => {
    assertSizeBudget(committed);
  });

  it("matches the committed bundle size recorded in the fixture", () => {
    expect(Buffer.byteLength(committed, "utf8")).toBe(fixture.committedBundleBytes);
  });

  it("fresh build is byte-identical to the committed bundle", async () => {
    await withFreshBuild((result) => {
      const fresh = fs.readFileSync(result.bundlePath, "utf8");
      expect(fresh).toBe(committed);
      expect(Buffer.byteLength(fresh, "utf8")).toBe(fixture.committedBundleBytes);
    });
  });

  describe("freshly generated source map", () => {
    it("parses and only references relative sources", async () => {
      await withFreshBuild((result) => {
        const mapText = fs.readFileSync(result.mapPath, "utf8");
        assertFreshMapSourcesAreRelative(mapText);
      });
    });
  });

  describe("synthetic negative cases (each check catches its pattern)", () => {
    it("catches eval(", () => {
      const bundle = `const x = 1;\neval("code");\n`;
      expect(() => {
        assertNoEval(bundle);
      }).toThrow();
    });

    it("catches new Function(", () => {
      const bundle = `const x = new Function("a", "return a");\n`;
      expect(() => {
        assertNoNewFunction(bundle);
      }).toThrow();
    });

    it("ignores the unrelated bare Function polyfill", () => {
      // `Function("return this")()` and `isAsyncFunction(...)` are present in
      // the committed bundle and must not trip the `new Function(` guard.
      expect(committed).toMatch(/Function\("return this"\)\(\)/);
      expect(() => {
        assertNoEval(committed);
        assertNoNewFunction(committed);
      }).not.toThrow();
    });

    it("catches a URL host not in the allow-list", () => {
      const bundle = `const u = "https://evil.example.com/steal";\n`;
      expect(() => {
        assertAllowedUrlHosts(bundle);
      }).toThrow();
    });

    it("catches a bundle over the size budget", () => {
      const bundle = "x".repeat(fixture.sizeBudgetBytes + 1);
      expect(() => {
        assertSizeBudget(bundle);
      }).toThrow();
    });

    it("fails a broken build with the build output instead of hanging", async () => {
      const brokenSrc = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-guard-broken-src-"));
      try {
        fs.cpSync(path.join(REPO_ROOT, "src"), path.join(brokenSrc, "src"), { recursive: true });
        fs.appendFileSync(
          path.join(brokenSrc, "src", "main.ts"),
          "\n;;; not valid TypeScript :::\n",
        );
        let error: unknown;
        try {
          freshBuild({ srcDir: path.join(brokenSrc, "src") });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeDefined();
        expect(String(error)).toContain("Fresh build");
        expect(String(error)).toContain("failed");
      } finally {
        fs.rmSync(brokenSrc, { recursive: true, force: true });
      }
    });

    it("catches absolute, home-directory, drive-letter and /tmp sources in a map", () => {
      const map = JSON.stringify({
        version: 3,
        sources: [
          "src/inputs.ts", // relative: fine
          "/home/user/project/src/inputs.ts", // home directory
          "C:\\Users\\builder\\src\\inputs.ts", // drive letter
          "/tmp/build/src/inputs.ts", // /tmp prefix
        ],
        mappings: "",
      });
      expect(() => {
        assertFreshMapSourcesAreRelative(map);
      }).toThrow();
    });
  });

  describe("freshBuild helper", () => {
    const tempPrefix = "bundle-guard-build-";

    function countTempBuilds(): number {
      return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tempPrefix)).length;
    }

    it("removes the temporary build directory afterwards", async () => {
      let result: FreshBuildResult | undefined;
      try {
        result = freshBuild();
        expect(fs.existsSync(result.tmpDir)).toBe(true);
      } finally {
        if (result !== undefined) {
          result.cleanup();
        }
      }
      expect(fs.existsSync(result!.tmpDir)).toBe(false);
    });

    it("does not leak a temporary build directory when the build fails", async () => {
      const before = countTempBuilds();
      const brokenSrc = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-guard-broken-src-"));
      try {
        fs.cpSync(path.join(REPO_ROOT, "src"), path.join(brokenSrc, "src"), { recursive: true });
        fs.appendFileSync(
          path.join(brokenSrc, "src", "main.ts"),
          "\n;;; not valid TypeScript :::\n",
        );
        let threw = false;
        try {
          freshBuild({ srcDir: path.join(brokenSrc, "src") });
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      } finally {
        fs.rmSync(brokenSrc, { recursive: true, force: true });
      }
      expect(countTempBuilds()).toBe(before);
    });
  });
});
