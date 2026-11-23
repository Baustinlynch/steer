// Makes the zip that goes on the Chrome Web Store: extension/ without the manifest's
// "key" (the store refuses it, and gives the extension its own id instead).
//   node tools/pack-extension.mjs   ->  dist/steer-extension-VERSION.zip

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
delete manifest.key;
const tmp = mkdtempSync(join(tmpdir(), "steer-extension-"));
cpSync(join(root, "extension"), tmp, { recursive: true, filter: (f) => !f.endsWith(".DS_Store") });
writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
mkdirSync(join(root, "dist"), { recursive: true });
const zip = join(root, "dist", `steer-extension-${manifest.version}.zip`);
rmSync(zip, { force: true });
const r = spawnSync("zip", ["-r", "-X", zip, "."], { cwd: tmp, stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(zip);
