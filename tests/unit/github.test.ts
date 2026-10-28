import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:https", () => ({
  get: vi.fn(),
}));

import * as https from "node:https";
import { GitHubRequestError, githubFetch } from "../../src/github";

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  complete = true;
  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
  destroy(): void {
    this.emit("close");
  }
  pause(): void {}
  setEncoding(): void {}
  resume(): void {}
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error !== undefined) {
      this.emit("error", error);
    }
    return this;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("githubFetch", () => {
  it("retries after a timeout and returns the successful body", async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      call += 1;
      const request = new FakeRequest();
      if (call === 1) {
        queueMicrotask(() => request.emit("timeout"));
        return request as unknown as ReturnType<typeof https.get>;
      }
      const response = new FakeResponse(200);
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        queueMicrotask(() => {
          response.emit("data", "success-body");
          response.emit("end");
        });
      });
      return request as unknown as ReturnType<typeof https.get>;
    });

    const pending = githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary/tags");
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;

    expect(result.body).toBe("success-body");
    expect(vi.mocked(https.get)).toHaveBeenCalledTimes(2);
  });

  it("aborts a continuously streaming response at the overall deadline", async () => {
    vi.useFakeTimers();
    let requestInstance: FakeRequest | undefined;
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      const request = new FakeRequest();
      requestInstance = request;
      const destroySpy = vi.spyOn(request, "destroy");
      const response = new FakeResponse(200);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = (): void => {
        timer = setTimeout(() => {
          if (request.destroyed) return;
          response.emit("data", Buffer.from("chunk"));
          schedule();
        }, 1000);
      };
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        schedule();
      });
      // keep timer referenced
      void timer;
      void destroySpy;
      return request as unknown as ReturnType<typeof https.get>;
    });

    const pending = githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary/tags");
    const rejected = expect(pending).rejects.toBeInstanceOf(GitHubRequestError);

    await vi.advanceTimersByTimeAsync(25_000);

    await rejected;
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(GitHubRequestError);
    expect((err as GitHubRequestError).kind).toBe("timeout");
    expect(requestInstance?.destroyed).toBe(true);
  });
});
