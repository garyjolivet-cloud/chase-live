// runTests.js — tiny zero-dependency test runner for Chase Life
// ───────────────────────────────────────────────────────────────
// Usage: node tests/runTests.js
//
// Tests register themselves via the `test(name, fn)` global.
// `fn` may throw on failure or call `assert(condition, message)`.
// Exit code is 0 if all pass, 1 if any fail.

const tests = [];

// Public API used by test files
globalThis.test = (name, fn) => {
  tests.push({ name, fn });
};

globalThis.assert = (cond, message = 'assertion failed') => {
  if (!cond) throw new Error(message);
};

globalThis.assertEq = (actual, expected, message = '') => {
  // Deep equality for objects and arrays; strict equality for primitives.
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `${message}\n  expected: ${e}\n  actual:   ${a}`
    );
  }
};

globalThis.assertClose = (actual, expected, tolerance = 0.5, message = '') => {
  // For floats: actual within ±tolerance of expected
  if (typeof actual !== 'number' || isNaN(actual)) {
    throw new Error(`${message}\n  expected number near ${expected}, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message}\n  expected: ${expected} (±${tolerance})\n  actual:   ${actual}`
    );
  }
};

async function run() {
  // Discover and load test files from this directory
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const files = (await fs.readdir(here)).filter(f => f.endsWith('.test.js'));

  for (const file of files) {
    await import(path.join(here, file));
  }

  // Execute all registered tests
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err });
      console.log(`  ✗ ${name}`);
      console.log(`      ${err.message.split('\n').join('\n      ')}`);
    }
  }

  console.log('');
  console.log(`──────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`──────────────────────────────────────`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});

