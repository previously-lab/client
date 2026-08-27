#!/usr/bin/env node
/**
 * check-release.mjs — fail fast on inconsistent release state before publish.
 *
 * Usage: node scripts/check-release.mjs <tag>     (e.g. v0.9.0)
 *
 * Checks:
 *  1. package.json "version" matches the pushed tag.
 *  2. previously.kernelVersion matches dependencies["previously-kernel"]
 *     (the exact 1:1 binding from design §10.2).
 *  3. All versions are valid semver.
 *
 * The release workflow runs this before building; a mismatch means someone
 * tagged without bumping package.json (or forgot to re-pin the kernel).
 */

import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/check-release.mjs <tag> (e.g. v0.9.0)");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tagVersion = tag.replace(/^v/, "");
const semver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const failures = [];

if (pkg.version !== tagVersion) {
  failures.push(`package.json version is "${pkg.version}" but the tag is "${tag}" — bump version before tagging.`);
}
for (const [label, v] of [
  ["package.json version", pkg.version],
  ["previously.kernelVersion", pkg.previously?.kernelVersion],
  ['dependencies["previously-kernel"]', pkg.dependencies?.["previously-kernel"]],
]) {
  if (typeof v !== "string" || !semver.test(v)) failures.push(`${label} is missing or not semver: ${JSON.stringify(v)}`);
}
const pinned = pkg.previously?.kernelVersion;
const dep = pkg.dependencies?.["previously-kernel"];
if (pinned && dep && pinned !== dep) {
  failures.push(
    `kernel pin mismatch: previously.kernelVersion is "${pinned}" but dependencies["previously-kernel"] is "${dep}" — they must be exactly equal (design §10.2).`
  );
}

if (failures.length > 0) {
  console.error("release check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`release check OK: previously-client@${pkg.version} with previously-kernel@${pinned} (tag ${tag})`);
