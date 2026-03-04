#!/usr/bin/env node
"use strict";

/**
 * merge-contrib-config.js
 *
 * Usage:
 *   node tools/merge-contrib-config.js --check contrib/configs/mylatest-config.json
 *   node tools/merge-contrib-config.js --apply contrib/configs/mylatest-config.json
 *
 * What it merges into config.js:
 *   - customDeviations[]                -> DEVIANT_LIST (string list)
 *   - customTraits[]                    -> TRAIT_DATA  ({name,effect,deviants,neg})
 *   - settings.variants[{name,description}] -> VARIANT_LIST (string list)  (and optionally descriptions later)
 *
 * Notes:
 * - Exact duplicates are skipped (case + whitespace normalized).
 * - Near duplicates (possible typos) are WARNED (no auto-merge decisions).
 * - In --check mode: prints a report and exits without writing.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// -------- CLI parsing --------
const args = process.argv.slice(2);
const mode = args.includes("--apply") ? "apply" : args.includes("--check") ? "check" : null;

const fileArgs = args.filter(a => !a.startsWith("--"));
if (!mode || fileArgs.length !== 1) {
  console.error(
    "Usage:\n" +
    "  node tools/merge-contrib-config.js --check <path-to-*-config.json>\n" +
    "  node tools/merge-contrib-config.js --apply <path-to-*-config.json>\n"
  );
  process.exit(2);
}

const inputPath = fileArgs[0];
const inputBase = path.basename(inputPath);

// Enforce naming pattern
if (!inputBase.toLowerCase().endsWith("-config.json")) {
  console.error(`ERROR: Contributed config must be named "<name>-config.json". Got: ${inputBase}`);
  process.exit(2);
}

// -------- Paths --------
const CONFIG_JS_PATH = path.resolve(process.cwd(), "config.js");
if (!fs.existsSync(CONFIG_JS_PATH)) {
  console.error(`ERROR: Could not find config.js at: ${CONFIG_JS_PATH}\nRun this from your repo root.`);
  process.exit(2);
}

// -------- Helpers --------
function normKey(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Simple Levenshtein for near-duplicate warnings
function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function warnNearDuplicates(newItems, existingItems, label) {
  const warnings = [];
  for (const ni of newItems) {
    const nNorm = normKey(ni);
    // Only check short-ish names to reduce noise
    const nShort = nNorm.length <= 40;
    if (!nShort) continue;

    for (const ei of existingItems) {
      const eNorm = normKey(ei);
      if (eNorm === nNorm) continue;

      // Heuristic: similar length and close edit distance
      const lenDiff = Math.abs(eNorm.length - nNorm.length);
      if (lenDiff > 3) continue;

      const dist = levenshtein(nNorm, eNorm);
      if (dist > 0 && dist <= 2) {
        warnings.push(`WARN (${label}): "${ni}" is very close to existing "${ei}" (distance ${dist})`);
      }
    }
  }
  return warnings;
}

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`ERROR: Invalid JSON: ${p}\n${e.message}`);
    process.exit(2);
  }
}

function loadJsArrayFromConst(jsText, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\[(.*?)\\];`, "s");
  const m = jsText.match(re);
  if (!m) return null;
  const arrayLiteral = `[${m[1]}]`; // keep comments etc
  try {
    const val = vm.runInNewContext(arrayLiteral, {}, { timeout: 1000 });
    if (!Array.isArray(val)) throw new Error("Not an array");
    return val;
  } catch (e) {
    console.error(`ERROR: Failed parsing ${constName} from config.js: ${e.message}`);
    process.exit(2);
  }
}

function insertIntoConstArray(jsText, constName, newEntriesText) {
  // Inserts text BEFORE the closing ]; of the const array
  const re = new RegExp(`(const\\s+${constName}\\s*=\\s*\\[)([\\s\\S]*?)(\\];)`, "m");
  const m = jsText.match(re);
  if (!m) return null;
  const prefix = m[1], body = m[2], suffix = m[3];

  // Ensure we add a comma if needed
  const trimmed = body.trim();
  const needsComma = trimmed.length > 0 && !trimmed.trim().endsWith(",");

  const insertion = (trimmed.length ? (needsComma ? "," : "") : "") + "\n" + newEntriesText + "\n";
  return jsText.replace(re, `${prefix}${body}${insertion}${suffix}`);
}

function ensureVariantListExists(jsText) {
  if (jsText.includes("const VARIANT_LIST")) return jsText;

  // Insert after 'use strict'; (or at top if not found)
  const marker = /(['"]use strict['"];\s*)/;
  if (marker.test(jsText)) {
    return jsText.replace(marker, `$1\nconst VARIANT_LIST = [\n];\n`);
  }
  return `const VARIANT_LIST = [\n];\n\n` + jsText;
}

// -------- Validation of contributed JSON shape --------
function validateContribConfig(cfg) {
  const errors = [];

  if (typeof cfg !== "object" || cfg === null) errors.push("Root must be an object.");
  if (!("customDeviations" in cfg)) errors.push("Missing: customDeviations");
  if (!("customTraits" in cfg)) errors.push("Missing: customTraits");
  if (!("settings" in cfg)) errors.push("Missing: settings");
  if (cfg.settings && !("variants" in cfg.settings)) errors.push("Missing: settings.variants");

  if (cfg.customDeviations && !Array.isArray(cfg.customDeviations)) errors.push("customDeviations must be an array.");
  if (cfg.customTraits && !Array.isArray(cfg.customTraits)) errors.push("customTraits must be an array.");
  if (cfg.settings && cfg.settings.variants && !Array.isArray(cfg.settings.variants)) errors.push("settings.variants must be an array.");

  // Validate variants objects
  if (Array.isArray(cfg.settings?.variants)) {
    cfg.settings.variants.forEach((v, idx) => {
      if (!v || typeof v !== "object") errors.push(`settings.variants[${idx}] must be an object.`);
      else {
        if (!v.name || typeof v.name !== "string") errors.push(`settings.variants[${idx}].name must be a string.`);
        if (!v.description || typeof v.description !== "string") errors.push(`settings.variants[${idx}].description must be a string (required).`);
      }
    });
  }

  // Validate traits objects (best-effort)
  if (Array.isArray(cfg.customTraits)) {
    cfg.customTraits.forEach((t, idx) => {
      if (!t || typeof t !== "object") errors.push(`customTraits[${idx}] must be an object.`);
      else {
        if (!t.name || typeof t.name !== "string") errors.push(`customTraits[${idx}].name must be a string.`);
        if (!t.effect || typeof t.effect !== "string") errors.push(`customTraits[${idx}].effect must be a string.`);
        if (!t.type || (t.type !== "positive" && t.type !== "negative")) errors.push(`customTraits[${idx}].type must be "positive" or "negative".`);
        if (!Array.isArray(t.deviations) && t.deviations !== "ALL") errors.push(`customTraits[${idx}].deviations must be an array or "ALL".`);
      }
    });
  }

  return errors;
}

// -------- Main --------
const cfg = readJson(inputPath);
const validationErrors = validateContribConfig(cfg);

if (validationErrors.length) {
  console.error("❌ CONFIG VALIDATION FAILED:");
  for (const e of validationErrors) console.error(" - " + e);
  process.exit(1);
}

const jsTextOriginal = fs.readFileSync(CONFIG_JS_PATH, "utf8");

// Load existing lists
const existingDeviants = loadJsArrayFromConst(jsTextOriginal, "DEVIANT_LIST") || [];
const existingTraits = loadJsArrayFromConst(jsTextOriginal, "TRAIT_DATA") || [];
const jsWithVariant = ensureVariantListExists(jsTextOriginal);
const existingVariants = loadJsArrayFromConst(jsWithVariant, "VARIANT_LIST") || [];

// Normalize existing sets
const existingDeviantsSet = new Set(existingDeviants.map(normKey));
const existingVariantsSet = new Set(existingVariants.map(normKey));
const existingTraitsSet = new Set(existingTraits.map(t => normKey(t?.name)));

// Gather input, dedupe within input
const inputDeviantsRaw = (cfg.customDeviations || []).filter(Boolean).map(String);
const inputVariantsRaw = (cfg.settings?.variants || []).map(v => v?.name).filter(Boolean).map(String);
const inputTraitsRaw = (cfg.customTraits || []).filter(Boolean);

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  const dupes = [];
  for (const s of arr) {
    const k = normKey(s);
    if (!k) continue;
    if (seen.has(k)) dupes.push(s);
    else { seen.add(k); out.push(s.trim()); }
  }
  return { out, dupes };
}

const { out: inputDeviants, dupes: dupInputDeviants } = dedupeStrings(inputDeviantsRaw);
const { out: inputVariants, dupes: dupInputVariants } = dedupeStrings(inputVariantsRaw);

// Traits dedupe by name
const traitSeen = new Set();
const inputTraits = [];
const dupInputTraits = [];
for (const t of inputTraitsRaw) {
  const name = String(t.name || "").trim();
  const k = normKey(name);
  if (!k) continue;
  if (traitSeen.has(k)) dupInputTraits.push(name);
  else { traitSeen.add(k); inputTraits.push(t); }
}

// Determine additions
const addDeviants = inputDeviants.filter(d => !existingDeviantsSet.has(normKey(d)));
const addVariants = inputVariants.filter(v => !existingVariantsSet.has(normKey(v)));
const addTraits = inputTraits.filter(t => !existingTraitsSet.has(normKey(t.name)));

// Near-duplicate warnings
const warnings = [
  ...warnNearDuplicates(addDeviants, existingDeviants, "Deviation"),
  ...warnNearDuplicates(addVariants, existingVariants, "Variant"),
  ...warnNearDuplicates(addTraits.map(t => t.name), existingTraits.map(t => t.name), "Trait"),
];

// Report
console.log("✅ CONFIG VALIDATION PASSED");
console.log(`File: ${inputBase}`);
console.log("");
if (dupInputDeviants.length) console.log(`⚠ Duplicate Deviations inside file (ignored): ${dupInputDeviants.join(", ")}`);
if (dupInputVariants.length) console.log(`⚠ Duplicate Variants inside file (ignored): ${dupInputVariants.join(", ")}`);
if (dupInputTraits.length) console.log(`⚠ Duplicate Traits inside file (ignored): ${dupInputTraits.join(", ")}`);
console.log("");

console.log(`Will add Deviations: ${addDeviants.length}`);
console.log(`Will add Variants:   ${addVariants.length}`);
console.log(`Will add Traits:     ${addTraits.length}`);

if (warnings.length) {
  console.log("\n⚠ POSSIBLE TYPOS / NEAR DUPLICATES:");
  warnings.forEach(w => console.log(" - " + w));
}

if (mode === "check") {
  console.log("\n--check mode: no changes written.");
  process.exit(0);
}

// -------- APPLY: Write into config.js with minimal changes (append only) --------
let jsText = jsWithVariant;

// Append deviants (keep minimal diff: just add new quoted strings)
if (addDeviants.length) {
  const devText = addDeviants.map(d => `  "${d}"`).join(",\n");
  const updated = insertIntoConstArray(jsText, "DEVIANT_LIST", devText + ",");
  if (!updated) {
    console.error("ERROR: Could not insert into DEVIANT_LIST.");
    process.exit(1);
  }
  jsText = updated;
}

// Append variants (as strings). (Descriptions live in contrib json; later you can move to VARIANT_DATA if desired)
if (addVariants.length) {
  const varText = addVariants.map(v => `  "${v}"`).join(",\n");
  const updated = insertIntoConstArray(jsText, "VARIANT_LIST", varText + ",");
  if (!updated) {
    console.error("ERROR: Could not insert into VARIANT_LIST.");
    process.exit(1);
  }
  jsText = updated;
}

// Append traits as objects matching config.js format
if (addTraits.length) {
  const traitLines = addTraits.map(t => {
    const name = String(t.name).trim().replace(/"/g, '\\"');
    const effect = String(t.effect).trim().replace(/"/g, '\\"');
    const deviants = t.deviations === "ALL" ? `"ALL"` : JSON.stringify(t.deviations || []);
    const neg = (t.type === "negative") ? "true" : "false";
    return `  {name:"${name}",effect:"${effect}",deviants:${deviants},neg:${neg}},`;
  }).join("\n");
  const updated = insertIntoConstArray(jsText, "TRAIT_DATA", traitLines);
  if (!updated) {
    console.error("ERROR: Could not insert into TRAIT_DATA.");
    process.exit(1);
  }
  jsText = updated;
}

fs.writeFileSync(CONFIG_JS_PATH, jsText, "utf8");
console.log("\n✅ --apply complete: config.js updated (append-only).");
console.log("Next: review with `git diff` before committing.");
