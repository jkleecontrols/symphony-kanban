import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The board is one script with no build step and no unit tests around its rendering, so
// a function that is called but never defined only shows up as a blank page. It happened:
// a helper's definition failed to land, card() threw, and everything after renderBoard()
// in the refresh silently stopped — the metrics were there and nothing else was.
test("every function the board calls is defined in the board", async () => {
  const source = await fs.readFile(path.join(root, "public", "app.js"), "utf8");

  const defined = new Set([...source.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  for (const match of source.matchAll(/^const ([A-Za-z_$][\w$]*) = (?:async )?\(/gm)) defined.add(match[1]);

  const builtins = new Set([
    "encodeURIComponent", "decodeURIComponent", "String", "Number", "Boolean", "Object",
    "Array", "Math", "JSON", "Set", "Map", "Date", "fetch", "setInterval", "setTimeout",
    "parseInt", "parseFloat", "isNaN"
  ]);

  const missing = new Set();
  for (const match of source.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\(/g)) {
    const name = match[1];
    if (!defined.has(name) && !builtins.has(name)) missing.add(name);
  }

  assert.deepEqual([...missing], [], "these are interpolated into the board's HTML but never defined");
});

test("the board and its stylesheet stay parseable", async () => {
  const appSource = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  const braces = (text, open, close) => [...text].reduce((n, c) => n + (c === open ? 1 : c === close ? -1 : 0), 0);
  assert.equal(braces(appSource, "{", "}"), 0, "unbalanced braces in public/app.js");

  const css = await fs.readFile(path.join(root, "public", "styles.css"), "utf8");
  assert.equal(braces(css, "{", "}"), 0, "unbalanced braces in public/styles.css");

  const html = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
  for (const id of ["board", "metrics", "runtime", "logs", "composerForm", "themes", "banner"]) {
    assert.ok(html.includes(`id="${id}"`), `public/index.html is missing #${id}, which app.js looks up`);
  }
});
