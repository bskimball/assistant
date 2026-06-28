import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const distDir = "dist";
const generatedSecretArtifacts = [];

function collectSecretArtifacts(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSecretArtifacts(path);
      continue;
    }
    if (entry.name === ".dev.vars" || entry.name === ".dev.vars.local" || entry.name === ".env") {
      generatedSecretArtifacts.push(path);
      continue;
    }
    if (entry.name.startsWith(".env.")) {
      generatedSecretArtifacts.push(path);
    }
  }
}

collectSecretArtifacts(distDir);

for (const path of generatedSecretArtifacts) {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

const remaining = generatedSecretArtifacts.filter(existsSync);
if (remaining.length > 0) {
  console.error(`Secret-like build artifact remains in dist: ${remaining.join(", ")}`);
  process.exit(1);
}
