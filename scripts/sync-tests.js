#!/usr/bin/env node
/**
 * Runs portal/sync-tests.html in node: loads ops-core.js and sheet-sync-core.js in a sandbox that has no
 * Firebase and no real DOM (so the mapper is proven pure), runs the page's inline test script, prints every
 * line and exits 1 on any failure.  Usage: node scripts/sync-tests.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'portal', 'sync-tests.html'), 'utf8');
var m = html.match(/<script id="sync-tests">([\s\S]*?)<\/script>/);
if (!m) { console.error('No <script id="sync-tests"> block in portal/sync-tests.html'); process.exit(2); }

var elements = {};
function el(id) { return elements[id] || (elements[id] = { id: id, innerHTML: '', textContent: '' }); }
var sandbox = { console: console, Date: Date, JSON: JSON, Math: Math, Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp, isFinite: isFinite, isNaN: isNaN, parseFloat: parseFloat, parseInt: parseInt };
sandbox.window = sandbox;
var context = vm.createContext(sandbox);

function load(rel) { vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), context, { filename: rel }); }
load('portal/js/ops-core.js');
load('portal/js/sheet-sync-core.js');
if (typeof sandbox.SheetSyncCore !== 'object') { console.error('SheetSyncCore did not load'); process.exit(2); }

sandbox.document = { getElementById: el };
vm.runInContext(m[1], context, { filename: 'portal/sync-tests.html#sync-tests' });

var r = sandbox.__syncTestResults;
if (!r) { console.error('The tests did not report results.'); process.exit(2); }
r.lines.forEach(function (l) { console.log(l); });
console.log('');
console.log(r.fail ? r.fail + ' FAILED, ' + r.pass + ' passed' : 'All ' + r.pass + ' tests passed');
process.exit(r.fail ? 1 : 0);
