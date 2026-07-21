// Sidecar-bundle the agent (improvement-7 1.1). Release builds must not depend
// on this repo checkout, npx, tsx, or a system Node: esbuild folds serve.ts and
// each built-in MCP server into single-file bundles under
// src-tauri/resources/agent/, next to the Claude Code native binary the Agent
// SDK spawns; a pinned node.exe ships as a Tauri sidecar (externalBin) and runs
// them all. Runs from beforeBuildCommand so `tauri build` always bundles fresh.
//
// Layout produced (all git-ignored build artifacts):
//   src-tauri/resources/agent/serve.mjs        the resident agent
//   src-tauri/resources/agent/mcp-<name>.mjs   one per built-in MCP server
//   src-tauri/resources/agent/claude(.exe)     Agent SDK native binary
//   src-tauri/binaries/node-<triple>(.exe)     the sidecar Node runtime
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repo = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repo, "src-tauri", "resources", "agent");
const binDir = join(repo, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const mcpNames = readdirSync(join(repo, "mcp"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const entries = [
  { in: join(repo, "agent", "serve.ts"), out: join(outDir, "serve.mjs") },
  ...mcpNames.map((n) => ({ in: join(repo, "mcp", n, "server.ts"), out: join(outDir, `mcp-${n}.mjs`) })),
];

for (const e of entries) {
  await build({
    entryPoints: [e.in],
    outfile: e.out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // The Agent SDK and MCP SDK mix ESM/CJS; a banner shims require() for any
    // CJS dep esbuild leaves as a dynamic require in ESM output.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });
}

// The Agent SDK spawns a native Claude Code binary resolved from the sibling
// platform package; bundled code can't resolve packages, so ship the binary in
// resources and point pathToClaudeCodeExecutable at it (agent/claude-brain.ts).
const require = createRequire(import.meta.url);
const claudeName = process.platform === "win32" ? "claude.exe" : "claude";
const claudeSrc = require.resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${claudeName}`,
);
copyFileSync(claudeSrc, join(outDir, claudeName));

// The sidecar Node runtime: the Node running this script. Pinned in practice by
// the environment that builds releases (CI installs a fixed version).
const triples = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const triple = triples[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`No target triple mapping for ${process.platform}-${process.arch}`);
const ext = process.platform === "win32" ? ".exe" : "";
copyFileSync(process.execPath, join(binDir, `node-${triple}${ext}`));

console.log(`[bundle-agent] ${entries.length} bundles + ${claudeName} -> ${outDir}`);
console.log(`[bundle-agent] node sidecar -> ${join(binDir, `node-${triple}${ext}`)}`);
