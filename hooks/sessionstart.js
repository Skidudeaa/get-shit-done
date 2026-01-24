const intel = require("../lib/intel");

async function readStdinJson() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      try {
        resolve(input ? JSON.parse(input) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function runSessionStart() {
  const root = process.cwd();
  const data = await readStdinJson();
  const src = data.source;
  if (src && !["startup", "resume"].includes(src)) process.exit(0);

  await intel.init(root);
  const summary = intel.readSummary(root);
  if (!summary || !summary.trim()) process.exit(0);

  process.stdout.write(`<codebase-intelligence>\n${summary.trim()}\n</codebase-intelligence>`);
  process.exit(0);
}

module.exports = { runSessionStart };

if (require.main === module) {
  runSessionStart().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}

