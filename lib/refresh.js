#!/usr/bin/env node
/**
 * Mid-session refresh: re-inject summary only if it changed since last injection.
 * 
 * Intended for UserPromptSubmit hook. Reads JSON from stdin (Claude Code protocol),
 * compares summary hash to cached value, emits if different.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = process.cwd();
const summaryPath = path.join(root, ".planning", "intel", "summary.md");
const cachePath = path.join(root, ".planning", "intel", ".last_injected_hash");

function hash(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    // Parse stdin (Claude Code sends JSON context)
    JSON.parse(input || "{}");

    if (!fs.existsSync(summaryPath)) process.exit(0);

    const summary = fs.readFileSync(summaryPath, "utf8").trim();
    if (!summary) process.exit(0);

    const h = hash(summary);
    const last = fs.existsSync(cachePath)
      ? fs.readFileSync(cachePath, "utf8").trim()
      : "";

    // Only inject if changed
    if (last === h) process.exit(0);

    fs.writeFileSync(cachePath, h);
    process.stdout.write(
      `<codebase-intelligence-refresh>\n${summary}\n</codebase-intelligence-refresh>`
    );
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
