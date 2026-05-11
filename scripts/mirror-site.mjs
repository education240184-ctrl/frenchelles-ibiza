import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceUrl = "https://frenchelles.com/ibiza";
const publicBasePath = (process.env.PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const rootDir = process.cwd();
const assetsDir = path.join(rootDir, "assets");
const indexPath = path.join(rootDir, "index.html");

const resourceHosts = new Set([
  "static.tildacdn.net",
  "thb.tildacdn.net",
  "neo.tildacdn.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "connect.facebook.net",
]);

const localByUrl = new Map();
const queued = [];
const queuedKeys = new Set();
const downloaded = new Set();
const failed = [];

function hash(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function sanitize(segment) {
  return segment
    .replace(/%20/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "asset";
}

function extensionFor(url) {
  const ext = path.extname(url.pathname);
  if (ext && ext.length <= 8) return ext;

  if (url.hostname === "fonts.googleapis.com") return ".css";
  if (url.pathname.includes("css")) return ".css";
  if (url.pathname.includes("js")) return ".js";

  return ".bin";
}

function normalizeUrl(raw, baseUrl = sourceUrl) {
  if (!raw) return null;

  let value = raw
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/^['"]|['"]$/g, "");

  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("javascript:")
  ) {
    return null;
  }

  if (value.startsWith("//")) value = `https:${value}`;

  try {
    const url = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!resourceHosts.has(url.hostname)) return null;
    if (url.pathname === "/" && !url.search) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function localTarget(remoteUrl) {
  if (localByUrl.has(remoteUrl)) return localByUrl.get(remoteUrl);

  const url = new URL(remoteUrl);
  const ext = extensionFor(url);
  const rawBase = path.basename(url.pathname).replace(path.extname(url.pathname), "") || "index";
  const fileName = `${sanitize(rawBase)}.${hash(remoteUrl)}${ext}`;
  const rawDir = path.dirname(url.pathname).split("/").filter(Boolean).map(sanitize);
  const filePath = path.join(assetsDir, sanitize(url.hostname), ...rawDir, fileName);
  const publicPath = `${publicBasePath}/assets/${[sanitize(url.hostname), ...rawDir, fileName].join("/")}`;

  const target = { filePath, publicPath };
  localByUrl.set(remoteUrl, target);
  return target;
}

function enqueue(remoteUrl) {
  if (!remoteUrl || queuedKeys.has(remoteUrl)) return;
  queuedKeys.add(remoteUrl);
  localTarget(remoteUrl);
  queued.push(remoteUrl);
}

function collectResources(text, baseUrl) {
  const cssUrlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const protocolRelativePattern = /(?<!:)\/\/[a-zA-Z0-9.-]+\/[^\s"'<>)]*/g;
  const absolutePattern = /https?:\/\/[^\s"'<>)]*/g;

  for (const match of text.matchAll(cssUrlPattern)) {
    const url = normalizeUrl(match[2], baseUrl);
    if (url) enqueue(url);
  }

  for (const match of text.matchAll(protocolRelativePattern)) {
    const url = normalizeUrl(match[0], baseUrl);
    if (url) enqueue(url);
  }

  for (const match of text.matchAll(absolutePattern)) {
    const url = normalizeUrl(match[0], baseUrl);
    if (url) enqueue(url);
  }
}

function rewriteResources(text, baseUrl) {
  const cssUrlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const protocolRelativePattern = /(?<!:)\/\/[a-zA-Z0-9.-]+\/[^\s"'<>)]*/g;
  const absolutePattern = /https?:\/\/[^\s"'<>)]*/g;

  let rewritten = text.replace(cssUrlPattern, (full, quote, raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (!url) return full;
    return `url('${localTarget(url).publicPath}')`;
  });

  rewritten = rewritten.replace(protocolRelativePattern, (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    return url ? localTarget(url).publicPath : raw;
  });

  rewritten = rewritten.replace(absolutePattern, (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    return url ? localTarget(url).publicPath : raw;
  });

  return rewritten;
}

function shouldRewriteTextResource(contentType, remoteUrl) {
  const url = new URL(remoteUrl);
  return (
    contentType.includes("text/css") ||
    contentType.includes("image/svg") ||
    [".css", ".svg"].includes(path.extname(url.pathname))
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 mirror script",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function download(remoteUrl) {
  if (downloaded.has(remoteUrl)) return;
  downloaded.add(remoteUrl);

  const target = localTarget(remoteUrl);

  try {
    const response = await fetch(remoteUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 mirror script",
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const bytes = Buffer.from(await response.arrayBuffer());
    let output = bytes;

    if (shouldRewriteTextResource(contentType, remoteUrl)) {
      const text = bytes.toString("utf8");
      collectResources(text, remoteUrl);
      output = Buffer.from(rewriteResources(text, remoteUrl), "utf8");
    }

    await mkdir(path.dirname(target.filePath), { recursive: true });
    await writeFile(target.filePath, output);
    console.log(`saved ${target.publicPath}`);
  } catch (error) {
    failed.push(`${remoteUrl} -> ${error.message}`);
  }
}

async function main() {
  console.log(`Fetching ${sourceUrl}`);
  const html = await fetchText(sourceUrl);

  collectResources(html, sourceUrl);

  for (let index = 0; index < queued.length; index += 1) {
    await download(queued[index]);
  }

  const rewrittenHtml = rewriteResources(html, sourceUrl).replace(
    'data-tilda-lazy="yes"',
    'data-tilda-lazy="yes" data-tilda-imgoptimoff="yes"',
  );
  await writeFile(indexPath, rewrittenHtml, "utf8");

  console.log(`\nCreated ${indexPath}`);
  console.log(`Downloaded ${downloaded.size - failed.length} resources`);

  if (failed.length) {
    console.log("\nFailed resources:");
    for (const item of failed) console.log(`- ${item}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
