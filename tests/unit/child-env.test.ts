import { describe, expect, it } from "vitest";

import {
  ALLOWED_ENV_NAMES,
  ALLOWED_ENV_PREFIXES,
  DENIED_ENV_NAMES,
  DENIED_ENV_PREFIXES,
  DENIED_ENV_SUBSTRINGS,
  MAX_PASSTHROUGH_NAMES,
  PASSTHROUGH_NAME_PATTERN,
  buildChildEnvironment,
  isAllowedEnvName,
  isDeniedEnvName,
} from "../../src/child-env";

/**
 * Issue #433: every child process (cargo, `cargo install`, and the engine)
 * gets an explicit allow-list instead of a copy of `process.env`. These tests
 * pin the list, the deny rules, and the windows/case handling; the
 * process-level proof that a real `spawn` observes the result lives in
 * runner.test.ts.
 */
describe("buildChildEnvironment: default allow-list", () => {
  it("keeps every representative group a real Rust build needs", () => {
    const source = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/runner",
      USER: "runner",
      LOGNAME: "runner",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      CI: "true",
      CARGO_HOME: "/home/runner/.cargo",
      RUSTUP_HOME: "/home/runner/.rustup",
      RUSTUP_TOOLCHAIN: "stable",
      RUSTFLAGS: "-C target-cpu=native",
      RUSTC: "/home/runner/.cargo/bin/rustc",
      RUST_BACKTRACE: "1",
      CC: "clang",
      CXX: "clang++",
      PKG_CONFIG_PATH: "/usr/lib/pkgconfig",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "localhost",
      http_proxy: "http://proxy.internal:3128",
      SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
      GIT_SSL_CAINFO: "/etc/ssl/certs/git.pem",
    };

    const { env, forwarded } = buildChildEnvironment(source, "linux");

    expect(env).toEqual(source);
    expect(forwarded).toEqual([]);
  });

  it("keeps every LC_*, RUSTUP_*, CARGO_*, and CMAKE_* name", () => {
    const source = {
      LC_TIME: "C",
      RUSTUP_DIST_SERVER: "https://mirror.internal/rustup",
      CARGO_BUILD_JOBS: "4",
      CARGO_NET_RETRY: "10",
      CMAKE_GENERATOR: "Ninja",
      CMAKE_TOOLCHAIN_FILE: "/opt/toolchain.cmake",
    };

    expect(buildChildEnvironment(source, "linux").env).toEqual(source);
  });

  it("drops secrets, the Action's own variables, and arbitrary names", () => {
    const source = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_secret",
      ACTIONS_RUNTIME_TOKEN: "runtime",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-token",
      INPUT_PROTOCOL: "28",
      RUNNER_TEMP: "/tmp",
      MY_SERVICE_TOKEN: "service",
      AWS_SECRET_ACCESS_KEY: "aws",
      AWS_ACCESS_KEY_ID: "aws-id",
      NPM_TOKEN: "npm",
      NODE_AUTH_TOKEN: "node",
      GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
      GIT_ASKPASS: "/usr/bin/askpass",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      FOO: "bar",
    };

    const { env } = buildChildEnvironment(source, "linux");

    expect(env).toEqual({ PATH: "/usr/bin" });
    for (const name of Object.keys(source).filter((key) => key !== "PATH")) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("removes Cargo registry credentials even though they match CARGO_*", () => {
    const source = {
      CARGO_REGISTRY_TOKEN: "cargo-secret",
      CARGO_REGISTRIES_FOO_TOKEN: "mirror-secret",
      CARGO_REGISTRIES_FOO_INDEX: "https://mirror.internal/index",
      CARGO_BUILD_JOBS: "2",
    };

    const { env } = buildChildEnvironment(source, "linux");

    expect(env).toEqual({ CARGO_BUILD_JOBS: "2" });
    expect(env).not.toHaveProperty("CARGO_REGISTRY_TOKEN");
    expect(env).not.toHaveProperty("CARGO_REGISTRIES_FOO_TOKEN");
  });

  it("removes any name containing a sensitive substring, whatever its prefix", () => {
    const source = {
      CARGO_SESSION_ID: "session",
      CMAKE_SECRET_FILE: "/run/secret",
      MY_PASSWORD: "pw",
      MY_PASSWD: "pw",
      SOME_CREDENTIAL: "cred",
      DEPLOY_PRIVATE_KEY: "/key",
      STRIPE_API_KEY: "sk",
      S3_ACCESS_KEY: "ak",
      PATH: "/usr/bin",
    };

    expect(buildChildEnvironment(source, "linux").env).toEqual({ PATH: "/usr/bin" });
  });

  it("skips variables whose value is undefined", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: undefined };
    expect(buildChildEnvironment(source, "linux").env).toEqual({ PATH: "/usr/bin" });
  });

  it("does not mutate the source environment", () => {
    const source = Object.freeze({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret" });
    buildChildEnvironment(source, "linux", ["LD_LIBRARY_PATH"]);
    expect(source).toEqual({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret" });
  });

  it("preserves a value containing a newline verbatim", () => {
    const value = "/opt/lib\n/opt/lib2\r\n/opt/lib3";
    const { env } = buildChildEnvironment({ PATH: value }, "linux");
    expect(env.PATH).toBe(value);
  });
});

describe("buildChildEnvironment: Windows", () => {
  it("keeps Windows system variables regardless of case, preserving spelling", () => {
    const source = {
      SystemRoot: "C:\\Windows",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      USERPROFILE: "C:\\Users\\runner",
    };

    const { env } = buildChildEnvironment(source, "win32");

    expect(env).toEqual(source);
    // ...and the same source on Linux (where only the exact names in the list
    // apply) still keeps them, because every spelling is listed.
    expect(buildChildEnvironment(source, "linux").env).toEqual(source);
  });

  it("matches allow-list names case-insensitively", () => {
    const source = { path: "C:\\tools", cargo_home: "C:\\cargo", lc_all: "C" };
    const { env } = buildChildEnvironment(source, "win32");

    expect(env).toEqual(source);
    // The original spelling is what reaches the child, not the list's casing.
    expect(Object.keys(env)).toEqual(["path", "cargo_home", "lc_all"]);
  });

  it("is case-sensitive on Linux, where the environment is", () => {
    expect(buildChildEnvironment({ path: "/usr/bin" }, "linux").env).toEqual({});
    expect(isAllowedEnvName("path", "linux")).toBe(false);
    expect(isAllowedEnvName("PATH", "linux")).toBe(true);
  });

  it("matches denied names case-insensitively on every platform", () => {
    expect(isDeniedEnvName("github_token")).toBe(true);
    expect(isDeniedEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isDeniedEnvName("Actions_Runtime_Token")).toBe(true);
    expect(isDeniedEnvName("my_secret")).toBe(true);
    expect(isDeniedEnvName("CARGO_BUILD_JOBS")).toBe(false);
  });

  it("never forwards a denied passthrough name, even when it exists in lower case", () => {
    const source = { github_token: "ghp_secret", path: "C:\\tools" };
    const { env, forwarded } = buildChildEnvironment(source, "win32", ["github_token"]);

    expect(env).toEqual({ path: "C:\\tools" });
    expect(forwarded).toEqual([]);
  });
});

describe("buildChildEnvironment: engine-env-passthrough", () => {
  it("forwards a requested name and reports it", () => {
    const source = { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/lib" };
    const { env, forwarded } = buildChildEnvironment(source, "linux", ["LD_LIBRARY_PATH"]);

    expect(env).toEqual(source);
    expect(forwarded).toEqual(["LD_LIBRARY_PATH"]);
  });

  it("accepts several names and reports each one", () => {
    const source = { OPENSSL_DIR: "/opt/openssl", LIBRARY_PATH: "/opt/lib", FOO: "bar" };
    const { env, forwarded } = buildChildEnvironment(source, "linux", ["OPENSSL_DIR", "LIBRARY_PATH"]);

    expect(env).toEqual({ OPENSSL_DIR: "/opt/openssl", LIBRARY_PATH: "/opt/lib" });
    expect([...forwarded].sort()).toEqual(["LIBRARY_PATH", "OPENSSL_DIR"]);
    // A passthrough name that does not exist in the source is simply absent,
    // and a name the default allow-list already covers is not reported.
    expect(forwarded).not.toContain("FOO");
  });

  it("does not report a name that was already forwarding by default", () => {
    const source = { PATH: "/usr/bin" };
    const { env, forwarded } = buildChildEnvironment(source, "linux", ["PATH"]);

    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(forwarded).toEqual([]);
  });

  it("reports the spelling the environment actually used on Windows", () => {
    const source = { Ld_Library_Path: "C:\\lib" };
    const { env, forwarded } = buildChildEnvironment(source, "win32", ["LD_LIBRARY_PATH"]);

    expect(env).toEqual({ Ld_Library_Path: "C:\\lib" });
    expect(forwarded).toEqual(["Ld_Library_Path"]);
  });

  it("is case-sensitive about passthrough names on Linux", () => {
    const { env, forwarded } = buildChildEnvironment({ LD_LIBRARY_PATH: "/opt/lib" }, "linux", [
      "ld_library_path",
    ]);

    expect(env).toEqual({});
    expect(forwarded).toEqual([]);
  });

  it("still refuses denied names when a caller skips input validation", () => {
    const source = {
      GITHUB_TOKEN: "ghp_secret",
      CARGO_REGISTRIES_FOO_TOKEN: "mirror-secret",
      PATH: "/usr/bin",
    };
    const { env, forwarded } = buildChildEnvironment(source, "linux", [
      "GITHUB_TOKEN",
      "CARGO_REGISTRIES_FOO_TOKEN",
    ]);

    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(forwarded).toEqual([]);
  });
});

describe("allow/deny constants", () => {
  it("exposes the documented shape used by the input parser", () => {
    expect(MAX_PASSTHROUGH_NAMES).toBe(16);
    expect(PASSTHROUGH_NAME_PATTERN.test("LD_LIBRARY_PATH")).toBe(true);
    expect(PASSTHROUGH_NAME_PATTERN.test("_PRIVATE")).toBe(true);
    expect(PASSTHROUGH_NAME_PATTERN.test("1INVALID")).toBe(false);
    expect(PASSTHROUGH_NAME_PATTERN.test("HAS SPACE")).toBe(false);
    expect(PASSTHROUGH_NAME_PATTERN.test("HAS=VALUE")).toBe(false);
    expect(PASSTHROUGH_NAME_PATTERN.test("WILD*CARD")).toBe(false);
  });

  it("keeps the documented deny groups", () => {
    for (const name of [
      "GITHUB_",
      "ACTIONS_",
      "INPUT_",
      "RUNNER_",
      "CARGO_REGISTRIES_",
      "AWS_",
      "AZURE_",
      "GCP_",
      "GOOGLE_",
      "NPM_",
    ]) {
      expect(DENIED_ENV_PREFIXES).toContain(name);
    }
    for (const name of ["CARGO_REGISTRY_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "NODE_AUTH_TOKEN"]) {
      expect(DENIED_ENV_NAMES).toContain(name);
    }
    for (const substring of [
      "TOKEN",
      "SECRET",
      "PASSWORD",
      "PASSWD",
      "CREDENTIAL",
      "PRIVATE_KEY",
      "API_KEY",
      "ACCESS_KEY",
      "SESSION",
    ]) {
      expect(DENIED_ENV_SUBSTRINGS).toContain(substring);
    }
    // The allow-list itself must never contain a name the deny rules cover.
    for (const allowed of ALLOWED_ENV_NAMES) {
      expect(isDeniedEnvName(allowed)).toBe(false);
    }
    for (const prefix of ALLOWED_ENV_PREFIXES) {
      expect(isDeniedEnvName(`${prefix}EXAMPLE`)).toBe(false);
    }
  });
});
