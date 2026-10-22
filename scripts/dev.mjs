// Runs the Vidya MCP server and the Alexa+ simulator together: `npm run dev`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader so API keys can live in a local .env file.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const procs = [
  ["mcp", "\x1b[33m", ["run", "start", "-w", "@studybuddy/mcp-server"]],
  ["sim", "\x1b[36m", ["run", "start", "-w", "@studybuddy/simulator"]],
].map(([name, color, args]) => {
  const p = spawn("npm", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const out = (buf) => {
    for (const line of buf.toString().split("\n")) if (line.trim() && !line.startsWith(">")) console.log(`${color}${name}\x1b[0m │ ${line}`);
  };
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  p.on("exit", (code) => {
    console.log(`${name} exited (${code})`);
    for (const q of procs) q.kill();
    process.exit(code ?? 0);
  });
  return p;
});

process.on("SIGINT", () => {
  for (const p of procs) p.kill("SIGINT");
});
