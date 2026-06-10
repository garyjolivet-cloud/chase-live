// functions/api/pois.smoke.js
// Manual smoke test — not part of npm test suite.
// Run with: node functions/api/pois.smoke.js
//
// Simulates the KV binding and exercises every code path in pois.js
// before we deploy. Cloudflare Pages Functions can't be run locally
// without wrangler, but the handler is plain JS that we can call
// directly with a fake env.

import { onRequestGet, onRequest } from './pois.js';

// ─── Fake KV namespace ──────────────────────────────────────

function makeKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// ─── Test cases ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    failed++;
    failures.push(name);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Fixtures ───────────────────────────────────────────────

const sampleCatalog = [
  {
    id: 'tunnel-vision',
    name: 'Tunnel Vision',
    type: 'winter-chute',
    topLatLon: [50.8763, -116.91],
    radiusMeters: 25,
  },
  {
    id: 'cpr-ridge-story',
    name: 'CPR Ridge Story',
    type: 'narrative-poi',
    topLatLon: [50.88, -116.9],
    radiusMeters: 40,
  },
  {
    id: 'easy-out-pullout',
    name: 'Easy Out Pullout',
    type: 'general',
    topLatLon: [50.87, -116.92],
    radiusMeters: 25,
  },
];

function makeRequest(url, method = 'GET') {
  return new Request(url, { method });
}

// ─── Run ─────────────────────────────────────────────────────

(async () => {
  console.log('Smoke tests for /api/pois\n');

  // S1 — Empty KV → empty array
  await check('S1 — empty KV returns empty pois array', async () => {
    const env = { CHUTES_KV: makeKV({}) };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois'),
      env,
    });
    assertEq(resp.status, 200, 'S1 status');
    const body = await resp.json();
    assertEq(body.pois, [], 'S1 pois empty');
    assertEq(body.count, 0, 'S1 count zero');
    assertEq(body.schemaVersion, '0.7', 'S1 schemaVersion');
    assert(typeof body.lastFetched === 'string', 'S1 lastFetched is ISO string');
  });

  // S2 — Populated KV → returns all POIs
  await check('S2 — populated KV returns all POIs', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: JSON.stringify(sampleCatalog) }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois'),
      env,
    });
    assertEq(resp.status, 200, 'S2 status');
    const body = await resp.json();
    assertEq(body.count, 3, 'S2 count');
    assertEq(body.pois.length, 3, 'S2 pois length');
    assertEq(body.pois[0].id, 'tunnel-vision', 'S2 first id');
  });

  // S3 — Filter by type=winter-chute
  await check('S3 — filter by type=winter-chute', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: JSON.stringify(sampleCatalog) }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois?type=winter-chute'),
      env,
    });
    const body = await resp.json();
    assertEq(body.count, 1, 'S3 count');
    assertEq(body.pois[0].id, 'tunnel-vision', 'S3 id');
  });

  // S4 — Filter by type=narrative-poi
  await check('S4 — filter by type=narrative-poi', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: JSON.stringify(sampleCatalog) }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois?type=narrative-poi'),
      env,
    });
    const body = await resp.json();
    assertEq(body.count, 1, 'S4 count');
    assertEq(body.pois[0].id, 'cpr-ridge-story', 'S4 id');
  });

  // S5 — Fetch by id (single POI returned, not wrapped)
  await check('S5 — fetch by id returns single POI', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: JSON.stringify(sampleCatalog) }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois?id=tunnel-vision'),
      env,
    });
    assertEq(resp.status, 200, 'S5 status');
    const body = await resp.json();
    assertEq(body.id, 'tunnel-vision', 'S5 id');
    assertEq(body.type, 'winter-chute', 'S5 type');
  });

  // S6 — Fetch by unknown id → 404
  await check('S6 — unknown id returns 404', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: JSON.stringify(sampleCatalog) }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois?id=does-not-exist'),
      env,
    });
    assertEq(resp.status, 404, 'S6 status');
    const body = await resp.json();
    assert(body.error.includes('not found'), 'S6 error message');
  });

  // S7 — Missing CHUTES_KV binding → 500 with clear error
  await check('S7 — missing CHUTES_KV binding returns clear 500', async () => {
    const env = {};  // no binding at all
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois'),
      env,
    });
    assertEq(resp.status, 500, 'S7 status');
    const body = await resp.json();
    assert(body.error.includes('CHUTES_KV'), 'S7 mentions binding name');
  });

  // S8 — Corrupted KV value (invalid JSON) → returns empty, no crash
  await check('S8 — corrupted KV value gracefully returns empty', async () => {
    const env = {
      CHUTES_KV: makeKV({ catalog: 'not-valid-json{{' }),
    };
    const resp = await onRequestGet({
      request: makeRequest('https://example.com/api/pois'),
      env,
    });
    assertEq(resp.status, 200, 'S8 status');
    const body = await resp.json();
    assertEq(body.count, 0, 'S8 count (treated as empty)');
  });

  // S9 — POST returns 405 (method not allowed yet)
  await check('S9 — POST returns 405 until Step 5', async () => {
    const env = { CHUTES_KV: makeKV({}) };
    const resp = await onRequest({
      request: new Request('https://example.com/api/pois', { method: 'POST' }),
      env,
    });
    assertEq(resp.status, 405, 'S9 status');
    assertEq(resp.headers.get('allow'), 'GET', 'S9 Allow header');
  });

  // ─── Summary ──────────────────────────────────────────────
  console.log('');
  console.log('──────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('──────────────────────────────────────');
  if (failed > 0) {
    console.log('Failures:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
