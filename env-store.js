const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");

function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    values[key] = line.slice(index + 1);
  }
  return values;
}

function stringifyEnv(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join("\n") + "\n";
}

function readEnv() {
  if (!fs.existsSync(envPath)) return {};
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}

function writeEnv(updates) {
  const current = readEnv();
  const next = { ...current, ...updates };
  fs.writeFileSync(envPath, stringifyEnv(next), "utf8");
  Object.assign(process.env, next);
  return next;
}

module.exports = { readEnv, writeEnv };
