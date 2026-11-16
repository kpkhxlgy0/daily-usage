'use strict';
const os = require('node:os');
const path = require('node:path');
const { createCollector } = require('../src/collector.cjs');
const args = process.argv.slice(2);
let codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
let cacheDir;
for (let index = 0; index < args.length; index++)
{
    if (args[index] === '--home' && args[index + 1]) codexHome = path.resolve(args[++index]);
    else if (args[index] === '--cache' && args[index + 1]) cacheDir = path.resolve(args[++index]);
    else throw new Error('Usage: npm run report -- [--home PATH] [--cache PATH]');
}
cacheDir ||= path.join(codexHome, '.daily-usage', 'cache');
const collector = createCollector({ codexHome, cacheDir });
(async () =>
{
    try { process.stdout.write(JSON.stringify(await collector.scan(), null, 2) + '\n'); }
    finally { await collector.dispose(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
