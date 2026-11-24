'use strict';

const fs = require('node:fs');
const path = require('node:path');

const roots = process.argv.slice(2).filter(Boolean);

function findSarifFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return root.endsWith('.sarif') ? [root] : [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return findSarifFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.sarif') ? [fullPath] : [];
  });
}

const files = [...new Set(roots.flatMap(findSarifFiles))];
if (!files.length) {
  console.log('No local SARIF files were found. CodeQL upload/analysis result remains authoritative.');
  process.exit(0);
}

let total = 0;
for (const file of files) {
  const sarif = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`===== CodeQL SARIF: ${file} =====`);
  for (const run of sarif.runs || []) {
    const rules = new Map(
      (run.tool?.driver?.rules || []).map((rule) => [rule.id, rule])
    );
    for (const result of run.results || []) {
      total += 1;
      const rule = rules.get(result.ruleId) || {};
      const location = result.locations?.[0]?.physicalLocation;
      const region = location?.region;
      const uri = location?.artifactLocation?.uri || '<unknown file>';
      const line = region?.startLine || '?';
      const severity = result.properties?.['security-severity'] ??
        rule.properties?.['security-severity'] ??
        result.level ??
        rule.defaultConfiguration?.level ??
        'unknown';
      console.log(JSON.stringify({
        ruleId: result.ruleId,
        severity,
        message: result.message?.text || result.message?.markdown || '',
        location: `${uri}:${line}`,
        fingerprint: result.partialFingerprints || null,
      }));
    }
  }
}
console.log(`Total SARIF findings reported: ${total}`);
