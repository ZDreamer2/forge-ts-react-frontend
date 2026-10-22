import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr}`);
  return result.stdout;
}

test("bootstrap packs only declared metadata and installs independently", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-frontend-package-"));
  try {
    const [packed] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root));
    assert.equal(packed.name, "@zdreamer/forge-ts-react-frontend");
    assert.equal(packed.version, manifest.version);
    assert.deepEqual(packed.files.map(file => file.path).sort(), ["LICENSE", "README.md", "package.json"]);
    const tarball = join(directory, packed.filename);
    assert.equal(packed.integrity, "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball], directory);
    const installed = JSON.parse(readFileSync(join(directory, "node_modules/@zdreamer/forge-ts-react-frontend/package.json"), "utf8"));
    assert.equal(installed.name, packed.name);
    assert.equal(installed.version, packed.version);
    assert.equal(installed.license, "MIT");
    assert.deepEqual(installed.exports, {});
    assert.equal(installed.repository.url, "git+https://github.com/ZDreamer2/forge-ts-react-frontend.git");
    assert.equal(installed.dependencies, undefined);
    assert.equal(installed.peerDependencies, undefined);
    assert.equal(installed.scripts.prepublishOnly, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
