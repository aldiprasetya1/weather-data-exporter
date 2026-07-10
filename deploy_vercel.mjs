import fs from "node:fs/promises";
import path from "node:path";

const [token, rootDir] = process.argv.slice(2);
if (!token || !rootDir) {
  throw new Error("Usage: node deploy_vercel.mjs <vercel-token> <root-dir>");
}

const teamId = "team_kE0CDuXwWY1G24HkaJuihG7O";
const projectName = "weather-data-exporter";

async function walk(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "__pycache__" ||
      entry.name === ".venv" ||
      entry.name === "offline-data" ||
      entry.name === "node_modules"
    ) continue;
    if (entry.name.endsWith(".pyc")) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await walk(full, rel));
    } else if (entry.isFile()) {
      const data = await fs.readFile(full);
      out.push({
        file: rel.replaceAll("\\", "/"),
        data: data.toString("base64"),
        encoding: "base64",
      });
    }
  }
  return out;
}

async function vercel(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const files = await walk(rootDir);
const deployment = await vercel(`https://api.vercel.com/v13/deployments?teamId=${teamId}`, {
  method: "POST",
  body: JSON.stringify({
    name: projectName,
    project: projectName,
    target: "production",
    files,
    meta: {
      source: "codex-api",
      note: "separate admin page and token UX fixes",
    },
  }),
});

console.log(JSON.stringify({
  id: deployment.id,
  url: deployment.url,
  readyState: deployment.readyState,
  files: files.length,
}, null, 2));
