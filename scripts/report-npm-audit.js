'use strict';

const fs = require('node:fs');

const [reportPath, serviceName, scope] = process.argv.slice(2);
if (!reportPath || !serviceName || !['full', 'production'].includes(scope)) {
  console.error('Usage: node report-npm-audit.js <report.json> <service> <full|production>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Could not read npm audit report for ${serviceName} (${scope}): ${error.message}`);
  process.exit(2);
}

if (report.error) {
  console.error(`npm audit returned an error for ${serviceName} (${scope}): ${JSON.stringify(report.error)}`);
  process.exit(2);
}

const counts = report.metadata?.vulnerabilities;
if (!counts || typeof counts !== 'object') {
  console.error(`npm audit report for ${serviceName} (${scope}) has no vulnerability summary`);
  process.exit(2);
}

console.log(`[${serviceName}] ${scope} dependency audit: ${JSON.stringify(counts)}`);
for (const [name, item] of Object.entries(report.vulnerabilities || {})) {
  console.log(JSON.stringify({
    service: serviceName,
    scope,
    package: name,
    severity: item.severity,
    range: item.range,
    direct: item.isDirect,
    fixAvailable: item.fixAvailable,
  }));
}

// Keep the full audit informational, but block deployable package sets from
// shipping known HIGH/CRITICAL advisories. Report/network errors fail either scope.
if (scope === 'production' && ((counts.critical || 0) > 0 || (counts.high || 0) > 0)) {
  console.error(`[${serviceName}] production dependencies contain HIGH or CRITICAL advisories`);
  process.exitCode = 1;
}
