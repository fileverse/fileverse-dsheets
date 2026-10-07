/**
 * Minimal self-check for sanitizeDuneUrl / sanitizeSheetIframes.
 * Run: node src/sheet-engine/core/modules/iframe.sanitize.test.mjs
 *
 * Mirrors the logic in iframe.ts (keep in sync when changing allowlist).
 */

function sanitizeDuneUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const iframeAttrMatch = trimmed.match(
    /src=["']?(https:\/\/dune\.com\/embeds\/\d+\/\d+)/i,
  );
  if (iframeAttrMatch) return iframeAttrMatch[1];

  const embedMatch = trimmed.match(
    /^https:\/\/dune\.com\/embeds\/(\d+)\/(\d+)\/?(?:\?.*)?$/i,
  );
  if (embedMatch) {
    return `https://dune.com/embeds/${embedMatch[1]}/${embedMatch[2]}`;
  }

  const queryMatch = trimmed.match(
    /^https:\/\/dune\.com\/queries\/(\d+)\/(\d+)\/?(?:\?.*)?$/i,
  );
  if (queryMatch) {
    return `https://dune.com/embeds/${queryMatch[1]}/${queryMatch[2]}`;
  }

  return null;
}

function sanitizeSheetIframes(iframes) {
  if (!Array.isArray(iframes)) return [];
  const out = [];
  for (const frame of iframes) {
    const safeSrc = sanitizeDuneUrl(frame?.src ?? '');
    if (!safeSrc) continue;
    out.push({ ...frame, src: safeSrc });
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  sanitizeDuneUrl('https://dune.com/embeds/1/2') ===
    'https://dune.com/embeds/1/2',
  'bare embed',
);
assert(
  sanitizeDuneUrl('src="https://dune.com/embeds/9/8"') ===
    'https://dune.com/embeds/9/8',
  'src attr',
);
assert(
  sanitizeDuneUrl('https://dune.com/queries/3/4') ===
    'https://dune.com/embeds/3/4',
  'query → embed',
);
assert(sanitizeDuneUrl('https://evil.example/x') === null, 'evil rejected');
assert(sanitizeDuneUrl('http://dune.com/embeds/1/2') === null, 'http rejected');
assert(
  sanitizeDuneUrl('https://dune.com.evil.com/embeds/1/2') === null,
  'host suffix rejected',
);

const cleaned = sanitizeSheetIframes([
  { id: 'a', src: 'https://dune.com/embeds/1/2' },
  { id: 'b', src: 'https://evil.example' },
]);
assert(cleaned.length === 1 && cleaned[0].id === 'a', 'filter list');

console.log('iframe.sanitize.test.mjs: ok');
