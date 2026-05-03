// Build a tech-name → wiki icon URL mapping by probing wiki.factorio.com.
//
// Source list: factorio-tech-requirements.json (193 techs).
// For each tech, generate candidate file names and HEAD-probe wiki.factorio.com
// until one returns 200, then record the direct /images/<file>.png URL.
//
// Candidate generation:
//   1. OVERRIDES table (techs whose wiki name doesn't fit any pattern, e.g.
//      worker-robots-storage → Worker_robot_cargo_size, or Space-Age techs whose
//      research has no wiki page and falls back to the item icon).
//   2. Algorithmic variants:
//        - rename "worker-robots-*" → "worker-robot-*" (wiki uses singular)
//        - if name ends in "-<N>": also try the version with that suffix removed
//        - if name ends in "-equipment": also try without it
//        - uppercase any "mkN" segment to "MKN"
//      Cross-product each variant with suffixes "_(research).png" and ".png".
//
// The wiki uses a flat /images/<file>.png layout (no hash subdirs), so a direct
// GET works and Special:FilePath is only needed once for resolution.
//
// Usage:
//   node game-data/build-tech-icons.js [out.json]

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQ_PATH = path.join(__dirname, 'factorio-tech-requirements.json');
const OUT_PATH = process.argv[2] || path.join(__dirname, 'factorio-tech-icons.json');
const WIKI_BASE = 'https://wiki.factorio.com/images/';
const CONCURRENCY = 6;

// Hard overrides for techs that don't fit any pattern. Verified manually with HEAD on the wiki.
// Empty string means: known to have no wiki icon, leave unresolved.
const OVERRIDES = {
  // Wiki uses different terminology
  'worker-robots-storage-1': 'Worker_robot_cargo_size_(research).png',
  'worker-robots-storage-2': 'Worker_robot_cargo_size_(research).png',
  'worker-robots-storage-3': 'Worker_robot_cargo_size_(research).png',
  'research-speed-1': 'Lab_research_speed_(research).png',
  'research-speed-2': 'Lab_research_speed_(research).png',
  'research-speed-3': 'Lab_research_speed_(research).png',
  'research-speed-4': 'Lab_research_speed_(research).png',
  'research-speed-5': 'Lab_research_speed_(research).png',
  'research-speed-6': 'Lab_research_speed_(research).png',
  // Compound word: wiki concatenates "night vision" → "Nightvision"
  'night-vision-equipment': 'Nightvision_equipment_(research).png',
  // Space-Age techs with no research page on the wiki — fall back to item icon
  'solar-panel-equipment': 'Solar_panel.png',
  'battery-mk2-equipment': 'Personal_battery_MK2.png',
  'fission-reactor-equipment': 'Portable_fission_reactor.png',
  'artillery-shell-speed-1': 'Artillery_shell.png',
};

function titleCase(name) {
  // "advanced-circuit" → "Advanced_circuit"
  // "power-armor-MK2"  → "Power_armor_MK2" (preserves segments that already have uppercase)
  return name
    .split('-')
    .map((p, i) => {
      if (/[A-Z]/.test(p)) return p; // preserve "MK2" etc.
      if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      return p.toLowerCase();
    })
    .join('_');
}

function nameVariants(tech) {
  const variants = new Set([tech]);

  if (tech.includes('worker-robots-')) {
    variants.add(tech.replace('worker-robots-', 'worker-robot-'));
  }

  // Strip trailing -N for tiered techs (braking-force-3 → braking-force).
  for (const v of [...variants]) {
    const stripped = v.replace(/-\d+$/, '');
    if (stripped !== v) variants.add(stripped);
  }

  // Strip "-equipment" suffix.
  for (const v of [...variants]) {
    if (v.endsWith('-equipment')) variants.add(v.slice(0, -'-equipment'.length));
  }

  // Uppercase mkN → MKN.
  for (const v of [...variants]) {
    const upped = v.replace(/-mk(\d)/g, '-MK$1');
    if (upped !== v) variants.add(upped);
  }

  return [...variants];
}

function* candidates(tech) {
  if (tech in OVERRIDES) {
    if (OVERRIDES[tech]) yield OVERRIDES[tech];
    return;
  }
  const seen = new Set();
  for (const v of nameVariants(tech)) {
    for (const suffix of ['_(research).png', '.png']) {
      const fn = titleCase(v) + suffix;
      if (!seen.has(fn)) { seen.add(fn); yield fn; }
    }
  }
}

function head(filename) {
  return new Promise((resolve) => {
    const url = WIKI_BASE + encodeURI(filename);
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      res.resume();
      resolve({ url, status: res.statusCode, filename });
    });
    req.on('error', (err) => resolve({ url, status: 0, filename, error: err.message }));
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function resolveTech(techName) {
  const tried = [];
  for (const fn of candidates(techName)) {
    tried.push(fn);
    const r = await head(fn);
    if (r.status === 200) return { tech: techName, url: r.url, filename: fn, tried };
  }
  return { tech: techName, url: null, filename: null, tried };
}

async function pool(items, worker, n) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stderr.write(`  resolved ${done}/${items.length}\n`);
      }
    }
  }));
  return results;
}

(async () => {
  const req = JSON.parse(fs.readFileSync(REQ_PATH, 'utf8'));
  const techs = Object.keys(req.technologies).sort();
  console.error(`Probing wiki for ${techs.length} tech icons (concurrency ${CONCURRENCY})...`);

  const results = await pool(techs, resolveTech, CONCURRENCY);

  const icons = {};
  const unresolved = [];
  for (const r of results) {
    if (r.url) icons[r.tech] = r.url;
    else unresolved.push(r);
  }

  const sortedIcons = {};
  for (const k of Object.keys(icons).sort()) sortedIcons[k] = icons[k];

  const out = {
    meta: {
      source: 'wiki.factorio.com',
      generatedAt: new Date().toISOString(),
      techCount: Object.keys(sortedIcons).length,
      totalTechs: techs.length,
      unresolvedCount: unresolved.length,
      note: 'URLs are direct hits on /images/ and were verified with HEAD at generation time.'
    },
    icons: sortedIcons
  };
  if (unresolved.length) out.unresolved = unresolved.map(u => ({ tech: u.tech, tried: u.tried }));

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.error(`Wrote ${OUT_PATH}`);
  console.error(`Resolved: ${Object.keys(sortedIcons).length} / ${techs.length}`);
  if (unresolved.length) {
    console.error(`UNRESOLVED (${unresolved.length}):`);
    for (const u of unresolved) console.error(`  ${u.tech}  (tried: ${u.tried.join(', ')})`);
    process.exitCode = 2;
  }
})();
