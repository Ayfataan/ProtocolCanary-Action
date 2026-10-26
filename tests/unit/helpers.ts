import * as fs from "node:fs";
import type { CanaryReport, CanaryResult } from "../../src/output";

/**
 * Tracks temporary directories created during test runs and ensures
 * they are removed cleanly afterwards with Windows-compatible retry options.
 */
export class TempDirTracker {
  private readonly dirs = new Set<string>();

  /**
   * Records a temporary directory path to be cleaned up.
   */
  track(dirPath: string): string {
    this.dirs.add(dirPath);
    return dirPath;
  }

  /**
   * Removes all tracked directories.
   */
  cleanup(): void {
    for (const dir of Array.from(this.dirs)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Ignore errors if directory is already removed
      }
      this.dirs.delete(dir);
    }
  }

  /**
   * Checks if a directory is tracked.
   */
  has(dirPath: string): boolean {
    return this.dirs.has(dirPath);
  }

  /**
   * Returns the count of tracked directories.
   */
  get size(): number {
    return this.dirs.size;
  }
}

/**
 * Shared builders for CanaryReport/CanaryResult test fixtures.
 *
 * Previously each of annotations.test.ts, summary.test.ts, and
 * output.test.ts defined its own near-identical local copy; a schema change
 * (e.g. a new required top-level field) meant updating three places that
 * could silently drift. Import these instead.
 */
export function result(overrides: Partial<CanaryResult> = {}): CanaryResult {
  return {
    testId: "t",
    protocol: 28,
    surface: "xdr",
    status: "pass",
    summary: "ok",
    durationMs: 1,
    fixtureId: "t",
    ...overrides,
  };
}

export function report(resultsOrOverrides: CanaryResult[] | Partial<CanaryReport> = {}): CanaryReport {
  const defaults: CanaryReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    targetProtocol: 28,
    project: { name: "example-project", type: "soroban" },
    status: "pass",
    counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [],
    git: { commit: null, branch: null, isDirty: null },
  };
  if (Array.isArray(resultsOrOverrides)) {
    const results = resultsOrOverrides;
    return {
      ...defaults,
      counts: { total: results.length, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results,
    };
  }
  return { ...defaults, ...resultsOrOverrides };
}
