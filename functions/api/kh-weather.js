// Cloudflare Pages Function — fetches & parses KH advanced weather page.
// Always returns valid JSON, even on internal errors. Includes _debug for diagnosis.

export async function onRequest(context) {
  const URL = 'https://kickinghorseresort.com/conditions/advanced-weather-data/';
  const debug = { strategies: [], rawSnippet: '' };
  const start = Date.now();

  try {
    let res;
    try {
      res = await fetch(URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-CA,en;q=0.9',
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (fetchErr) {
      return jsonResponse({ ok: false, error: `fetch threw: ${fetchErr.message}`, _debug: debug });
    }

    debug.status = res.status;
    debug.contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      return jsonResponse({ ok: false, error: `KH returned HTTP ${res.status}`, _debug: debug });
    }

    let html;
    try {
      html = await res.text();
    } catch (textErr) {
      return jsonResponse({ ok: false, error: `body read failed: ${textErr.message}`, _debug: debug });
    }

    debug.htmlLength = html.length;
    debug.rawSnippet = html.substring(0, 300).replace(/\s+/g, ' ');

    // Bot-challenge sniffing
    if (/cloudflare|just a moment|captcha|attention required/i.test(debug.rawSnippet)) {
      return jsonResponse({ ok: false, error: 'blocked by anti-bot challenge', _debug: debug });
    }

    // Strategy 1: <pre> blocks
    const preBlocks = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => m[1].trim());
    debug.strategies.push(`pre_blocks=${preBlocks.length}`);

    // Strategy 2: <table> blocks
    const tableBlocks = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]);
    debug.strategies.push(`table_blocks=${tableBlocks.length}`);

    let whiteWall = null;
    let dogtooth = null;

    // Try pre-blocks first
    if (preBlocks.length >= 2) {
      let wwText = preBlocks[0];
      let dtText = preBlocks[1];
      if (/HS|Precip/i.test(preBlocks[0]) && !/HS|Precip/i.test(preBlocks[1])) {
        wwText = preBlocks[1];
        dtText = preBlocks[0];
      }
      const wwParsed = parseStation(wwText, 'whitewall');
      const dtParsed = parseStation(dtText, 'dogtooth');
      if (wwParsed.latest || dtParsed.latest) {
        whiteWall = wwParsed.latest;
        dogtooth = dtParsed.latest;
        debug.strategies.push('pre_parsed_ok');
      }
    }

    // Try tables if pre failed
    if (!whiteWall && !dogtooth && tableBlocks.length > 0) {
      for (let t = 0; t < tableBlocks.length; t++) {
        try {
          const rows = parseTableRows(tableBlocks[t]);
          if (rows.length < 2) continue;
          const headerRow = rows[0];
          const dataRows = rows.slice(1).filter(r => r.length >= 4);
          if (dataRows.length === 0) continue;
          const lastRow = dataRows[dataRows.length - 1];
          const headerText = headerRow.join(' ').toLowerCase();
          const isDogtooth = /hs|precip|snow.*depth/i.test(headerText)
                          || /hs|precip/i.test(tableBlocks[t]);
          const parsed = buildFromTableRow(headerRow, lastRow, isDogtooth ? 'dogtooth' : 'whitewall');
          if (isDogtooth) dogtooth = parsed;
          else whiteWall = parsed;
          debug.strategies.push(`table_${t}_${isDogtooth ? 'dt' : 'ww'}`);
        } catch (rowErr) {
          debug.strategies.push(`table_${t}_err:${rowErr.message}`);
        }
      }
    }

    debug.elapsedMs = Date.now() - start;

    return jsonResponse({
      ok: true,
      fetchedAt: new Date().toISOString(),
      whiteWall,
      dogtooth,
      _debug: debug,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: `unhandled: ${err.message}`,
      _debug: debug,
    });
  }
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function parseStation(text, kind) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const month = parseInt(tokens[0], 10);
    const day = parseInt(tokens[1], 10);
    if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const timeTok = tokens[2];
    if (!/^\d{1,4}$|^\d{1,2}:\d{2}$/.test(timeTok)) continue;
    const timeStr = timeTok.includes(':') ? timeTok : timeTok.padStart(4, '0').replace(/^(\d{2})(\d{2})$/, '$1:$2');
    const nums = tokens.slice(3).map(t => {
      const n = parseFloat(t);
      return isNaN(n) ? null : n;
    });
    rows.push({ timeLabel: `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${timeStr}`, month, day, timeStr, values: nums });
  }
  const last = rows[rows.length - 1] || null;
  let latest = null;
  if (last) {
    const v = last.values;
    // KH publishes wind columns as: DIRECTION (degrees), SPEED (kph), GUST (kph)
    // Clamp wind values to realistic ranges so format changes don't show 300 kph
    const clampWind = (n) => (typeof n === 'number' && n >= 0 && n <= 200) ? n : null;
    const clampDir = (n) => (typeof n === 'number' && n >= 0 && n <= 360) ? n : null;
    const clampTemp = (n) => (typeof n === 'number' && n >= -50 && n <= 40) ? n : null;
    const clampHS = (n) => (typeof n === 'number' && n >= 0 && n <= 500) ? n : null;

    if (kind === 'whitewall') {
      // Columns: airTemp, dir, wind, gust
      latest = {
        time: last.timeLabel,
        airTemp: clampTemp(v[0]),
        dir:  clampDir(v[1]),
        wind: clampWind(v[2]),
        gust: clampWind(v[3]),
      };
    } else {
      // Columns: airTemp, rh, hn24, hst, hs, hrPrecip, cumPrecip, dir, wind, gust
      latest = {
        time: last.timeLabel,
        airTemp: clampTemp(v[0]),
        rh: v[1],
        hn24: v[2],
        hst: v[3],
        hs: clampHS(v[4]),
        hrPrecip: v[5],
        cumPrecip: v[6],
        dir:  clampDir(v[7]),
        wind: clampWind(v[8]),
        gust: clampWind(v[9]),
      };
    }
  }
  return { latest, rows };
}

function parseTableRows(tableHtml) {
  const rows = [];
  const trMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const trMatch of trMatches) {
    const cells = [...trMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function buildFromTableRow(headerRow, dataRow, kind) {
  const headers = headerRow.map(h => h.toLowerCase());
  const get = (regex) => {
    for (let i = 0; i < headers.length; i++) {
      if (regex.test(headers[i])) {
        const v = parseFloat(dataRow[i]);
        return isNaN(v) ? null : v;
      }
    }
    return null;
  };
  let time = null;
  for (let i = 0; i < headers.length; i++) {
    if (/time|date|hour/i.test(headers[i])) { time = dataRow[i]; break; }
  }
  if (kind === 'whitewall') {
    return { time: time || 'now', airTemp: get(/temp|air/), wind: get(/wind.*sp|^wind$/), dir: get(/dir/), gust: get(/gust/) };
  }
  return {
    time: time || 'now',
    airTemp: get(/temp|air/), rh: get(/rh|humid/),
    hn24: get(/hn.*24|new.*24/), hst: get(/hst|storm/),
    hs: get(/^hs$|snow.*depth|height/),
    hrPrecip: get(/hr.*precip|hourly/), cumPrecip: get(/cum.*precip|^precip$/),
    wind: get(/wind.*sp|^wind$/), dir: get(/dir/), gust: get(/gust/),
  };
}
