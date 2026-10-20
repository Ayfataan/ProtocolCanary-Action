#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ALLOWLIST_FILE = ".licenses-allowlist.json";

function loadAllowlist() {
  const allowlistPath = path.resolve(process.cwd(), ALLOWLIST_FILE);
  if (!fs.existsSync(allowlistPath)) {
    console.error(`Error: Allowlist file not found at ${allowlistPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

function findPackageJson(name, fromDir) {
  let curr = fromDir;
  while (curr && curr !== path.dirname(curr)) {
    const candidate = path.join(curr, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    curr = path.dirname(curr);
  }
  return null;
}

function getDependencyTree() {
  const stdout = execFileSync("npm", ["ls", "--omit=dev", "--json", "--all"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function checkLicenses() {
  const allowlist = loadAllowlist();
  const allowedSet = new Set(allowlist.allowedLicenses || []);
  const packageExceptions = allowlist.packageExceptions || {};

  const tree = getDependencyTree();
  const violations = [];
  const checked = new Map();

  function walk(node, parentDir, pathChain) {
    if (!node || !node.dependencies) return;

    for (const [name, dep] of Object.entries(node.dependencies)) {
      // Skip uninstalled optional or peer dependencies (they have no version/resolved in npm ls)
      if (!dep || (!dep.version && !dep.resolved)) {
        continue;
      }

      const currentChain = [...pathChain, `${name}@${dep.version || "unknown"}`];
      const pkgJsonPath = findPackageJson(name, parentDir);

      if (!pkgJsonPath) {
        // If it's an optional dependency not present, ignore
        if (dep.optional) {
          continue;
        }
        violations.push({
          package: name,
          version: dep.version,
          license: "NOT_FOUND",
          chain: currentChain.join(" -> "),
          reason: "package.json could not be located in node_modules",
        });
        continue;
      }

      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const version = pkg.version || dep.version;
      const pkgId = `${name}@${version}`;

      if (!checked.has(pkgId)) {
        let license = pkg.license;
        if (!license && Array.isArray(pkg.licenses)) {
          license = pkg.licenses.map((l) => (typeof l === "object" ? l.type : l)).join(" OR ");
        }

        const exception = packageExceptions[pkgId] || packageExceptions[name];
        if (exception) {
          license = exception.license;
        }

        const isAllowed = license && allowedSet.has(license);

        checked.set(pkgId, {
          name,
          version,
          license: license || "UNKNOWN",
          allowed: isAllowed,
          path: pkgJsonPath,
        });

        if (!isAllowed) {
          violations.push({
            package: name,
            version,
            license: license || "UNKNOWN",
            chain: currentChain.join(" -> "),
            reason: license
              ? `License "${license}" is not in ${ALLOWLIST_FILE}`
              : "No license field defined in package.json",
          });
        }
      }

      walk(dep, path.dirname(pkgJsonPath), currentChain);
    }
  }

  walk(tree, process.cwd(), [tree.name || "root"]);

  console.log(`Audited licenses across ${checked.size} production dependencies:`);
  const licenseCounts = new Map();
  for (const item of checked.values()) {
    licenseCounts.set(item.license, (licenseCounts.get(item.license) || 0) + 1);
  }
  for (const [lic, count] of licenseCounts.entries()) {
    console.log(`  - ${lic}: ${count} package(s)`);
  }

  if (violations.length > 0) {
    console.error(`\n❌ Found ${violations.length} license violation(s) in production dependencies:`);
    for (const v of violations) {
      console.error(`  - ${v.package}@${v.version} (License: ${v.license})`);
      console.error(`    Chain: ${v.chain}`);
      console.error(`    ${v.reason}`);
    }
    process.exit(1);
  }

  console.log("\n✅ All production dependencies comply with the license allow-list.");
}

checkLicenses();
