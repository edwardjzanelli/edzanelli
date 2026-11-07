// scripts/seniorminder-resolve.mjs
//
// Lets Node load the vendored SeniorMinder modules as they are. They import SeniorMinder's workspace packages by
// name (@seniorminder/logger, /common, /device), which SeniorMinder resolves through its npm workspace links. Here a
// resolve hook maps each one to the vendored package, at the path its package.json "exports" names. The one npm
// package those modules load, fs-extra (the logger's), is a devDependency of this repository.
//
// Used by the parity bench runner, the sync script (which reads the sentiment prompt out of the vendored
// SentimentAnalyzer) and the Lambda's sentiment tests. Call it before the first import of a vendored module.

import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VENDOR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'vendor', 'seniorminder');

const hooks = (packages) => `
import { readFileSync } from 'node:fs';
const PACKAGES = ${JSON.stringify(packages)};
export async function resolve(specifier, context, next) {
    const m = specifier.match(/^@seniorminder\\/([^/]+)(\\/.*)?$/);
    if (!m) return next(specifier, context);
    const base = new URL(m[1] + '/', PACKAGES);
    const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));
    const target = typeof pkg.exports === 'object' ? pkg.exports[m[2] ? '.' + m[2] : '.'] : undefined;
    if (typeof target !== 'string') throw new Error(specifier + ' is not exported by the vendored @seniorminder/' + m[1]);
    return { url: new URL(target, base).href, shortCircuit: true };
}
`;

let registered = false;

export function registerVendoredSeniorMinder() {
    if (registered) return;
    registered = true;
    register(`data:text/javascript,${encodeURIComponent(hooks(pathToFileURL(path.join(VENDOR, 'packages') + path.sep).href))}`);
}

/** A vendored module's file URL, from its SeniorMinder path. */
export const vendored = (rel) => pathToFileURL(path.join(VENDOR, ...rel.split('/'))).href;
