import fs from "node:fs/promises";
import path from "node:path";

const [token, rootDir, branch = "main"] = process.argv.slice(2);
if (!token || !rootDir) {
  throw new Error("Usage: node publish_github_contents.mjs <github-token> <root-dir> [branch]");
}

const owner = "aldiprasetya1";
const repo = "weather-data-exporter";
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

async function gh(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codex-weather-data-exporter-fix",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

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
      out.push({ full, rel: rel.replaceAll("\\", "/") });
    }
  }
  return out;
}

async function existingSha(file) {
  try {
    const data = await gh(`${apiBase}/contents/${encodeURIComponent(file).replaceAll("%2F", "/")}?ref=${encodeURIComponent(branch)}`);
    return data.sha;
  } catch (err) {
    if (err.status === 404) return undefined;
    throw err;
  }
}

const files = await walk(rootDir);
let updated = 0;
for (const file of files) {
  const content = (await fs.readFile(file.full)).toString("base64");
  const sha = await existingSha(file.rel);
  await gh(`${apiBase}/contents/${encodeURIComponent(file.rel).replaceAll("%2F", "/")}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `sync: update ${file.rel}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  updated += 1;
  console.log(`updated ${file.rel}`);
}

console.log(JSON.stringify({ branch, updated }, null, 2));
