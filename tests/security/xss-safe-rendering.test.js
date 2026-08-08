'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '../../public/js');

function readAllJs() {
  return fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).map((f) => ({
    file: f, content: fs.readFileSync(path.join(JS_DIR, f), 'utf8'),
  }));
}

test('frontend never assigns dynamic/interpolated content to innerHTML (only static or clearing values)', () => {
  const offenders = [];
  for (const { file, content } of readAllJs()) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const match = line.match(/\.innerHTML\s*=\s*(.+)/);
      if (!match) return;
      const rhs = match[1].trim().replace(/;\s*$/, '');
      const isSafe = rhs === "''" || rhs === '""' || rhs === '``';
      if (!isSafe) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Found innerHTML assignments with non-static content:\n${offenders.join('\n')}`);
});

test('rendering helpers use textContent/createElement rather than string-built HTML', () => {
  const dashboard = fs.readFileSync(path.join(JS_DIR, 'dashboard.js'), 'utf8');
  assert.match(dashboard, /document\.createElement/, 'expected DOM-API-based rendering');
  assert.match(dashboard, /\.textContent\s*=/, 'expected textContent-based content assignment');
});

test('the confirmation dialog builds order details via textContent, not string concatenation', () => {
  const orderConfirmation = fs.readFileSync(path.join(JS_DIR, 'order-confirmation.js'), 'utf8');
  assert.doesNotMatch(orderConfirmation, /innerHTML\s*=\s*`/, 'dialog must not template raw HTML strings');
});
