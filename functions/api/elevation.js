// Returns a pre-computed elevation grid for the Kicking Horse area.
// Fetched once from OpenTopoData (free SRTM), then cached in Cloudflare KV-like memory.
//
// Grid: 31×31 cells (961 points) covering roughly 5.5km × 5.5km centered on KH.
// At ~180m spacing — coarse but enough to resolve major ridges and bowls.
// We avoid the 100-points-per-request, 1-req-per-second public API limits by
// caching the result for a long time (terrain doesn't move).

// Bounding box (lat/lon). Tweaked to cover the lift-served terrain at KH.
const LAT_MIN = 51.275;
const LAT_MAX = 51.325;
const LON_MIN = -117.095;
const LON_MAX = -117.020;
const GRID_N = 31;  // 31x31 = 961 points, 10 requests at 100 pts each

let cached = null;  // in-memory cache for this worker instance

export async function onRequest(context) {
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
        'X-Cache': 'HIT',
      },
    });
  }

  // Build the full list of points
  const points = [];
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const lat = LAT_MIN + (LAT_MAX - LAT_MIN) * (i / (GRID_N - 1));
      const lon = LON_MIN + (LON_MAX - LON_MIN) * (j / (GRID_N - 1));
      points.push({ lat, lon, i, j });
    }
  }

  // Batch into requests of 100 points each
  const batches = [];
  for (let k = 0; k < points.length; k += 100) batches.push(points.slice(k, k + 100));

  const grid = new Array(GRID_N).fill(null).map(() => new Array(GRID_N).fill(null));

  try {
    for (const batch of batches) {
      const locs = batch.map(p => `${p.lat},${p.lon}`).join('|');
      const url = `https://api.opentopodata.org/v1/srtm30m?locations=${locs}&interpolation=bilinear`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ChaseLife/1.0' },
        cf: { cacheTtl: 86400 * 7 },
      });
      if (!res.ok) throw new Error(`OpenTopoData ${res.status}`);
      const json = await res.json();
      if (json.status !== 'OK') throw new Error(json.error || 'OpenTopoData failed');
      for (let n = 0; n < batch.length; n++) {
        const p = batch[n];
        const elev = json.results[n].elevation;
        grid[p.i][p.j] = elev;
      }
      // Be polite to the 1 req/sec free tier
      await new Promise(r => setTimeout(r, 1100));
    }

    const payload = {
      bbox: { latMin: LAT_MIN, latMax: LAT_MAX, lonMin: LON_MIN, lonMax: LON_MAX },
      gridN: GRID_N,
      grid,
      fetchedAt: new Date().toISOString(),
    };
    cached = payload;

    return new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
        'X-Cache': 'MISS',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message,
      hint: 'Falling back to synthetic terrain on client',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}

