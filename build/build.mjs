// Static site build for edzanelli.com. No dependencies.
//
//   src/layout.html         the HTML shell shared by every page
//   src/partials/*.html     header variants, footer, and repeated fragments
//   src/pages/*.html        one file per page: a JSON metadata comment, then the page's <main>
//                           The page's "path" is its URL and decides where it is written: "" is index.html,
//                           "name.html" is written as is, and an extensionless "dir/name" is written as
//                           dir/name/index.html so it is served at /dir/name. Pages are written from the
//                           site root's point of view; in a page written below the root, every relative
//                           href and src is prefixed with one "../" per level, so the same partials work
//                           at any depth, from a server or from file://.
//   src/css, src/js, src/assets  copied through unchanged
//
// Output goes to website/, which Amplify serves. website/ is build output and is not committed.
//
// Placeholders:
//   {{name}}             a value from src/site.json (email, linkedin, resume, ...) or the page's metadata block
//                        (title, description, path). og_title and og_description fall back to title and
//                        description; og_image falls back to assets/og-image.jpg.
//   {{header}}           the partial named by the page's "header" field
//   {{footer}}           partials/footer.html
//   {{content}}          the page body
//   {{scripts}}          <script> tags for "scripts" and "module_scripts"
//   {{partial:name}}     inline partials/name.html (usable inside pages and partials)
//   {{current:name}}     ' aria-current="page"' when the page's "current" field equals name

import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const out = join(root, "website");

const read = (p) => readFileSync(p, "utf8");
const site = JSON.parse(read(join(src, "site.json")));
const partial = (name) => read(join(src, "partials", `${name}.html`)).trimEnd();

function expand(text, meta) {
  return text
    .replace(/\{\{partial:([\w-]+)\}\}/g, (_, name) => expand(partial(name), meta))
    .replace(/\{\{current:([\w-]+)\}\}/g, (_, name) => (meta.current === name ? ' aria-current="page"' : ""));
}

const outFile = (path) => (path === "" ? "index.html" : path.endsWith(".html") ? path : `${path}/index.html`);

function render(pageFile) {
  const raw = read(join(src, "pages", pageFile));
  const m = raw.match(/^<!-- meta\n([\s\S]*?)\n-->\n/);
  if (!m) throw new Error(`${pageFile}: missing metadata block`);
  const page = JSON.parse(m[1]);
  const meta = {
    ...site,
    og_title: page.title,
    og_description: page.description,
    og_image: "assets/og-image.jpg",
    current: "",
    ...page,
  };
  const content = raw.slice(m[0].length).trimEnd();

  const scripts = [
    ...(meta.scripts || []).map((s) => `<script src="${s}"></script>`),
    ...(meta.module_scripts || []).map((s) => `<script type="module" src="${s}"></script>`),
  ].join("\n");

  let html = read(join(src, "layout.html"))
    .replace("{{header}}", expand(partial(meta.header), meta))
    .replace("{{content}}", expand(content, meta))
    .replace("{{footer}}", expand(partial("footer"), meta))
    .replace("{{scripts}}", scripts);

  html = html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in meta)) throw new Error(`${pageFile}: no value for {{${key}}}`);
    return meta[key];
  });

  const file = outFile(meta.path);
  const up = "../".repeat(file.split("/").length - 1);
  if (up) html = html.replace(/\b(href|src)="(?![a-z][a-z0-9+.-]*:|\/|#)/gi, `$1="${up}`);
  return { file, html };
}

const pages = readdirSync(join(src, "pages")).filter((f) => f.endsWith(".html"));
const built = pages.map(render);
const builtFiles = new Set(built.map((b) => b.file));

// website/ is build output and is cleared on every run. Before clearing it, refuse if it holds
// anything the build did not put there (a file that has no counterpart under src/), so nothing
// placed in website/ by hand can be lost: list the strays and stop.
function strays(dir, rel = "") {
  const found = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = join(rel, entry.name);
    const posix = path.split("\\").join("/"); // Windows paths use backslashes
    if (entry.isDirectory()) { if (posix !== "js/vendor") found.push(...strays(dir, path)); continue; }
    const isPage = builtFiles.has(posix);
    if (!isPage && !existsSync(join(src, path))) found.push(posix);
  }
  return found;
}
if (existsSync(out)) {
  const extra = strays(out);
  if (extra.length) {
    console.error("website/ contains files that are not in src/ and would be deleted by the build:");
    for (const f of extra) console.error("  " + f);
    console.error("Move them under src/ (they are copied to website/ by the build), then build again.");
    process.exit(1);
  }
  // On Windows a file held open in website/ (a running server, an editor) can block the delete;
  // retry briefly, and if it still will not go, overwrite in place rather than fail.
  try { rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (err) { console.warn(`could not clear website/ (${err.code}); overwriting in place`); }
}
mkdirSync(out, { recursive: true });
for (const dir of ["css", "js", "assets"]) {
  if (existsSync(join(src, dir))) cpSync(join(src, dir), join(out, dir), { recursive: true });
}
for (const { file, html } of built) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), html);
}
console.log(`built ${built.length} pages -> website/`);
