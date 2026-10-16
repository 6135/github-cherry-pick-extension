// Makes one folder for each browser in dist/, with a manifest that has only the keys
// that browser uses. Usage: node scripts/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const COPY = ["src", "icons", "LICENSE"];

const targets = {
  // Firefox does not support background.service_worker.
  firefox(m) {
    m.background = { scripts: m.background.scripts };
    return m;
  },
  // Chrome, Edge, Opera: no Gecko keys, service worker only.
  chromium(m) {
    m.background = { service_worker: m.background.service_worker };
    delete m.browser_specific_settings;
    return m;
  }
};

rmSync(join(root, "dist"), { recursive: true, force: true });
for (const [name, transform] of Object.entries(targets)) {
  const out = join(root, "dist", name);
  mkdirSync(out, { recursive: true });
  for (const item of COPY) cpSync(join(root, item), join(out, item), { recursive: true });
  const m = transform(structuredClone(manifest));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  console.log(`dist/${name} (version ${m.version})`);
}
