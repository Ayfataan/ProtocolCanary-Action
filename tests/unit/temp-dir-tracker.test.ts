import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TempDirTracker } from "./helpers";

describe("TempDirTracker (#501)", () => {
  const tracker = new TempDirTracker();

  afterEach(() => {
    tracker.cleanup();
  });

  it("tracks and removes directories on cleanup", () => {
    const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-test-")));
    expect(fs.existsSync(dir)).toBe(true);
    expect(tracker.has(dir)).toBe(true);
    expect(tracker.size).toBe(1);

    tracker.cleanup();

    expect(fs.existsSync(dir)).toBe(false);
    expect(tracker.has(dir)).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("never deletes a directory that was not tracked", () => {
    const callerOwnedDir = fs.mkdtempSync(path.join(os.tmpdir(), "caller-owned-"));
    const trackedDir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracked-")));

    try {
      expect(tracker.has(callerOwnedDir)).toBe(false);
      expect(tracker.has(trackedDir)).toBe(true);

      tracker.cleanup();

      // Tracked directory must be deleted, caller-owned must survive
      expect(fs.existsSync(trackedDir)).toBe(false);
      expect(fs.existsSync(callerOwnedDir)).toBe(true);
    } finally {
      fs.rmSync(callerOwnedDir, { recursive: true, force: true });
    }
  });

  it("handles cleanup gracefully when a directory was already removed manually", () => {
    const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-manual-")));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);

    expect(() => tracker.cleanup()).not.toThrow();
    expect(tracker.size).toBe(0);
  });
});
