/* Copy the files the extension shares with the web app into extension/. Run with `npm run sync`. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const target = path.join(root, "extension");

for (const file of ["core.js", "brand-config.js"]) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
  console.log(`synced ${file}`);
}
fs.mkdirSync(path.join(target, "fonts"), { recursive: true });
for (const file of fs.readdirSync(path.join(root, "fonts"))) {
  fs.copyFileSync(path.join(root, "fonts", file), path.join(target, "fonts", file));
}
console.log("synced fonts");
