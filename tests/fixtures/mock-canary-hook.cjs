/*
 * A preload hook for issue #436 (Windows mock-engine scenarios).
 *
 * Windows cannot execute a plain Node script as `stellar-canary.exe`: the
 * Action looks for a real executable there, and a `.cjs` file is not one.
 * The workaround this file enables: the test copies the Node executable
 * itself (`process.execPath`) to `<CARGO_HOME>/bin/stellar-canary.exe` and
 * points `NODE_OPTIONS=--require <this file>` at this hook, so the copied
 * binary becomes a Node runtime that executes the mock engine the moment it
 * starts. Nothing is compiled and no real engine is needed on any platform.
 *
 * How it works, precisely:
 *
 * 1. Node treats `--require` files as preloads and runs them BEFORE the
 *    main module — including before it attempts to resolve `argv[1]` as a
 *    script. The Action spawns the binary with the engine's real argument
 *    array (`check --format json`, or `version`), so `argv[1]` names `check`,
 *    which Node itself would reject ("Cannot find module 'check'").
 *    Preload execution order short-circuits that: the hook runs first.
 *
 * 2. The hook re-normalizes `process.argv` from
 *      [<node copy>, check, --format, json]
 *    to what `mock-canary.cjs` expects,
 *      [<node copy>, <script name>, check, --format, json]
 *    then `require`s the real mock engine. `mock-canary.cjs` is executed at
 *    require time exactly as its header comment documents: it reads
 *    `MOCK_CANARY_SCENARIO`, writes its report or diagnostic, and exits with
 *    the scenario's contract code — so control never returns here and the
 *    unresolvable `argv[1]` is never even looked at.
 *
 * The hook (and therefore the binary it fakes) never contacts the network.
 *
 * One wrinkle found while running this for the first time: Node resolves
 * `argv[1]` to an absolute path (module resolution relative to the child's
 * working directory) BEFORE preload hooks execute — a run of
 * `stellar-canary version` shows up here as argv = [<node>, <cwd>/version].
 * So the bare subcommand has to be recovered from `path.basename(argv[1])`,
 * not read directly.
 */
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- this hook must stay CommonJS: Node loads it
 * through `--require` (which has no ESM equivalent) before the child can
 * pick a module system, and its whole purpose is a synchronous preload. */

const path = require("node:path");

const engineArgs = process.argv.slice(1);
engineArgs[0] = path.basename(engineArgs[0] ?? "");
process.argv = [process.argv[0], require.resolve("./mock-canary.cjs")].concat(engineArgs);
require("./mock-canary.cjs");
