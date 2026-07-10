import fs from "node:fs/promises";
import path from "node:path";

const [token, rootDir, branch = "main"] = process.argv.slice(2);
if (!token || !rootDir) {
  throw new Error("Usage: node publish_github.mjs <github-token> <root-dir> [branch]");
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
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
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
      out.push({ full, rel });
    }
  }
  return out;
}

const ref = await gh(`${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`);
const baseCommitSha = ref.object.sha;
const baseCommit = await gh(`${apiBase}/git/commits/${baseCommitSha}`);
const baseTreeSha = baseCommit.tree.sha;

const files = await walk(rootDir);
const tree = [];
for (const file of files) {
  const data = await fs.readFile(file.full);
  const blob = await gh(`${apiBase}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: data.toString("base64"),
      encoding: "base64",
    }),
  });
  tree.push({
    path: file.rel.replaceAll("\\", "/"),
    mode: "100644",
    type: "blob",
    sha: blob.sha,
  });
}

const newTree = await gh(`${apiBase}/git/trees`, {
  method: "POST",
  body: JSON.stringify({
    base_tree: baseTreeSha,
    tree,
  }),
});

const newCommit = await gh(`${apiBase}/git/commits`, {
  method: "POST",
  body: JSON.stringify({
    message: "feat: add separate admin page and improve token UX",
    tree: newTree.sha,
    parents: [baseCommitSha],
  }),
});

await gh(`${apiBase}/git/refs/heads/${encodeURIComponent(branch)}`, {
  method: "PATCH",
  body: JSON.stringify({
    sha: newCommit.sha,
    force: false,
  }),
});

console.log(JSON.stringify({
  branch,
  files: files.length,
  commit: newCommit.sha,
}, null, 2));
