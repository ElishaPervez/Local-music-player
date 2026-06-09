// Renders app-icon.svg to the 1024px PNG that `tauri icon` consumes.
// Usage: npm i --no-save @resvg/resvg-js && node scripts/render-icon.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "app-icon.svg"), "utf8");
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
}).render().asPng();
writeFileSync(resolve(root, "app-icon.png"), png);
console.log("wrote app-icon.png (1024x1024)");
