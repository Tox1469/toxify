// Monta release/Toxify-Setup.exe: compila o app, comprime o Toxify.exe e compila o instalador
// (src-tauri/setup) com ele dentro. Uso: npm run release
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts, env: { ...process.env, ...opts.env } });
const target = resolve("src-tauri/target/release");
const payload = resolve(target, "toxify.exe.gz");

run("npx tauri build --no-bundle");
writeFileSync(payload, gzipSync(readFileSync(resolve(target, "toxify.exe")), { level: 9 }));
run("cargo build --release --bin toxify-setup --features setup,tauri/custom-protocol", {
  cwd: "src-tauri",
  env: { TOXIFY_PAYLOAD: payload },
});

mkdirSync("release", { recursive: true });
copyFileSync(resolve(target, "toxify-setup.exe"), "release/Toxify-Setup.exe");
const mb = (statSync("release/Toxify-Setup.exe").size / 1048576).toFixed(1);
console.log(`\nrelease/Toxify-Setup.exe pronto (${mb} MB)`);
