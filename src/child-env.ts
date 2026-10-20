/**
 * Construction of the environment handed to the child processes this Action
 * starts: `cargo` (both the `--version` probe and `cargo install`) and the
 * Protocol Canary engine itself.
 *
 * Those children compile and run arbitrary code from every crate in the
 * engine's dependency tree. If they inherited the job environment, a
 * compromised build script could read `GITHUB_TOKEN`, the Actions runtime
 * tokens, or any secret a workflow exported with `env:` while the job holds
 * write permissions. So each child receives an explicit allow-list instead
 * of a copy of `process.env`; the Action process itself keeps its full
 * environment, because it needs `INPUT_*`, `GITHUB_*`, and `ACTIONS_*`.
 *
 * The lists below are a maintained compromise, not a security boundary the
 * Action can prove: a missing variable can break an unusual toolchain, and
 * no list makes a malicious dependency safe — it only deprives it of the
 * job's secrets. See README.md and SECURITY.md.
 */

/**
 * Exact names a child always receives. Grouped by why they are needed.
 */
export const ALLOWED_ENV_NAMES: readonly string[] = [
  // Process and locale: every process needs to find executables and dynamic
  // libraries, know where home and temporary files are, and format output.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "CI",
  // Windows system: without these, `spawn` cannot resolve executables,
  // locate the system directory, or find the command processor at all.
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  // Rust and Cargo: where the toolchain and its registry live, how rustc is
  // invoked, and the flags a project may pin for its own build.
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "RUSTFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS",
  "RUST_BACKTRACE",
  "RUST_LOG",
  // Native build toolchain: crates with `build.rs` compile C/C++ and query
  // pkg-config/cmake, and the MSVC toolchain additionally needs the
  // installer's INCLUDE/LIB/LIBPATH and SDK paths.
  "CC",
  "CXX",
  "AR",
  "LD",
  "CFLAGS",
  "CXXFLAGS",
  "LDFLAGS",
  "CPPFLAGS",
  "PKG_CONFIG",
  "PKG_CONFIG_PATH",
  "PKG_CONFIG_SYSROOT_DIR",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "VCINSTALLDIR",
  "VCToolsInstallDir",
  "VSINSTALLDIR",
  "WindowsSdkDir",
  "WindowsSDKVersion",
  "UCRTVersion",
  "Platform",
  // Network and certificates: runners behind a proxy, or with a private CA
  // bundle, cannot download crates without these.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

/**
 * Prefixes a child always receives (in addition to {@link ALLOWED_ENV_NAMES}).
 * Each one names a family of configuration a real Rust build depends on:
 *
 * - `LC_*` — locale categories.
 * - `RUSTUP_*` — rustup's override, dist-server, and proxy configuration.
 * - `CARGO_*` — Cargo's own configuration (target dirs, jobs, incremental,
 *   registry mirrors, …). Credential-bearing names are still denied by
 *   {@link DENIED_ENV_NAMES} / {@link DENIED_ENV_PREFIXES} first.
 * - `CMAKE_*` — CMake configuration used by `cmake`-based build scripts.
 */
export const ALLOWED_ENV_PREFIXES: readonly string[] = ["LC_", "RUSTUP_", "CARGO_", "CMAKE_"];

/**
 * Exact names never passed to a child, even when a prefix above would match.
 *
 * - `CARGO_REGISTRY_TOKEN` and the `CARGO_REGISTRIES_*` family below hold
 *   crates.io / mirror credentials.
 * - `GIT_ASKPASS` and `SSH_AUTH_SOCK` hand a child live credential agents.
 * - `NODE_AUTH_TOKEN` is the npm equivalent of a registry token.
 */
export const DENIED_ENV_NAMES: readonly string[] = [
  "CARGO_REGISTRY_TOKEN",
  "GIT_ASKPASS",
  "SSH_AUTH_SOCK",
  "NODE_AUTH_TOKEN",
];

/**
 * Prefixes never passed to a child: the Action's own runtime variables, the
 * workflow's `env:` values (`INPUT_*`, `GITHUB_*`), runner metadata
 * (`RUNNER_*`), Cargo registry credentials, and cloud/npm credential
 * families.
 */
export const DENIED_ENV_PREFIXES: readonly string[] = [
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
];

/**
 * Case-insensitive substrings that disqualify a name, whatever else matches.
 * This is the backstop that keeps an allow-list prefix (for example
 * `CARGO_*`) from smuggling a credential through a name nobody enumerated.
 */
export const DENIED_ENV_SUBSTRINGS: readonly string[] = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "API_KEY",
  "ACCESS_KEY",
  "SESSION",
];

/** Maximum number of names accepted by `engine-env-passthrough`. */
export const MAX_PASSTHROUGH_NAMES = 16;

/** A passthrough entry must be a bare environment-variable name. */
export const PASSTHROUGH_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True when `name` is on the deny list. Matching is case-insensitive on every
 * platform: environment names are case-insensitive on Windows, and a
 * conservative match can only *remove* a variable, never leak one.
 */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_ENV_NAMES.includes(upper)) {
    return true;
  }
  for (const prefix of DENIED_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return true;
    }
  }
  return DENIED_ENV_SUBSTRINGS.some((substring) => upper.includes(substring));
}

/**
 * True when `name` appears in the default allow-list. Names are compared
 * case-sensitively except on Windows (`platform === "win32"`), where the
 * environment is case-insensitive.
 */
export function isAllowedEnvName(name: string, platform: NodeJS.Platform): boolean {
  const candidate = normalizeName(name, platform);
  if (ALLOWED_ENV_NAMES.some((allowed) => normalizeName(allowed, platform) === candidate)) {
    return true;
  }
  return ALLOWED_ENV_PREFIXES.some((prefix) => candidate.startsWith(normalizeName(prefix, platform)));
}

function normalizeName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * A fully-defined environment (no `undefined` values) ready to hand to
 * `spawn`/`exec`. Deliberately not `NodeJS.ProcessEnv`, which permits
 * `undefined` values and therefore does not fit `@actions/exec`'s options.
 */
export type ChildProcessEnvironment = Readonly<Record<string, string>>;

/** Result of {@link buildChildEnvironment}. */
export interface ChildEnvironment {
  /** The environment to hand to `spawn`/`exec`; never contains denied names. */
  readonly env: ChildProcessEnvironment;
  /**
   * Names that reached the child only because `engine-env-passthrough` asked
   * for them, spelled exactly as they appear in the source environment. Log
   * these names — never their values — so the job log shows what left the
   * Action.
   */
  readonly forwarded: readonly string[];
}

/**
 * Builds the environment for a child process from an explicit allow-list.
 *
 * Pure: it reads `source` and returns a new object, never mutating the
 * caller's environment. Values are copied verbatim (an embedded newline is
 * legal in an environment value and is preserved), and `undefined` entries
 * are skipped, which is what `process.env` looks like when a variable was
 * deleted on some Node versions.
 *
 * `passthrough` holds already-validated names from `engine-env-passthrough`
 * (see `parseEngineEnvPassthrough` in `src/inputs.ts`). Denied names are
 * refused here as well, so a future caller that skips validation cannot
 * re-open the hole the allow-list closes.
 */
export function buildChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  passthrough: readonly string[] = [],
): ChildEnvironment {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !isAllowedEnvName(name, platform) || isDeniedEnvName(name)) {
      continue;
    }
    // Keep the spelling the source environment used (on Windows this is the
    // spelling `spawn` will see, and `SystemRoot` vs `SYSTEMROOT` matters to
    // some tools that read the variable directly).
    env[name] = value;
  }

  const forwarded: string[] = [];
  for (const requested of passthrough) {
    if (isDeniedEnvName(requested)) {
      continue;
    }
    const key = findSourceName(source, requested, platform);
    if (key === undefined) {
      continue;
    }
    const value = source[key];
    if (value === undefined || key in env) {
      continue;
    }
    env[key] = value;
    forwarded.push(key);
  }

  return { env, forwarded };
}

/**
 * Finds the key `requested` names in `source`, preserving its spelling. On
 * Windows the lookup is case-insensitive, matching how the environment
 * itself behaves there.
 */
function findSourceName(
  source: Readonly<NodeJS.ProcessEnv>,
  requested: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(source, requested) && source[requested] !== undefined) {
    return requested;
  }
  if (platform !== "win32") {
    return undefined;
  }
  const wanted = requested.toUpperCase();
  return Object.keys(source).find((key) => key.toUpperCase() === wanted && source[key] !== undefined);
}
