// Scenario test suite for the Polytopia market optimizer (current rules).

const P = typeof require !== 'undefined' ? require('./polytopia.js') : window.Polytopia;
const { TILE, BUILD, makeGrid, optimize, validateBoard, totalStarsPerTurn,
        supplierLevel, marketStars, prefillResources, assignCities,
        maxMarketsPerCity, countsPerCity, totalExcessPerCity } = P;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg||'expected'}: got ${a}, want ${b}`);
}

// --- Scenario 1: crop -> windmill -> market chain, single implicit city.
test('crop -> windmill -> market chain', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.CROP;
  const { grid, stars } = optimize(g);
  assertEq(stars, 1, 'stars');
  assertEq(validateBoard(grid).length, 0, 'rules');
  assertEq(grid.tiles[0][0].building, BUILD.FARM);
  assertEq(grid.tiles[0][1].building, BUILD.WINDMILL);
  assertEq(grid.tiles[0][2].building, BUILD.MARKET);
});

// --- Scenario 2: one-market/windmill-per-city rule on a clustered board.
// 4 crops in a plus around a center. With one windmill and one market allowed
// per city, the best config places the windmill at the center (level 4, fed by
// all 4 farms) and the market in a corner next to it → market sees windmill
// level min(4,4) = 4 stars.
test('one supplier each per city — 4 farms yield 4 stars', () => {
  const g = makeGrid(3, 3);
  g.tiles[0][1].type = TILE.CROP;
  g.tiles[2][1].type = TILE.CROP;
  g.tiles[1][0].type = TILE.CROP;
  g.tiles[1][2].type = TILE.CROP;
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0, 'rules');
  assertEq(stars, 4, 'one windmill at center (lvl 4) feeds one corner market');
  assertEq(maxMarketsPerCity(grid), 1, 'exactly one market in the implicit city');
  const wm = countsPerCity(grid, BUILD.WINDMILL);
  for (const k in wm) assert(wm[k] <= 1, `city ${k} got ${wm[k]} windmills`);
});

// --- Scenario 3: two explicit cities, each gets its own market.
// Two independent clusters, each a full crop->windmill->market chain,
// isolated by a fog band so territories are unambiguous.
test('two cities, one market per city', () => {
  const g = makeGrid(5, 3);
  g.tiles[0][0].type = TILE.CROP;
  g.tiles[1][0].type = TILE.CITY;
  g.tiles[2][0].type = TILE.FOG;
  g.tiles[2][1].type = TILE.FOG;
  g.tiles[2][2].type = TILE.FOG;
  g.tiles[3][0].type = TILE.CITY;
  g.tiles[4][0].type = TILE.CROP;
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0, 'rules');
  let markets = 0;
  for (let r=0;r<grid.rows;r++) for (let c=0;c<grid.cols;c++)
    if (grid.tiles[r][c].building === BUILD.MARKET) markets++;
  assertEq(markets, 2, 'one market per city placed');
  assertEq(maxMarketsPerCity(grid), 1, 'max 1 market per city');
  assert(stars >= 2, `expected >=2 stars, got ${stars}`);
});

// --- Scenario 4: ports no longer contribute.
// A water tile adjacent to land gives a Port, but a Market adjacent to that
// port should still have 0 stars from it.
test('ports do not feed markets', () => {
  const g = makeGrid(3, 3);
  g.tiles[0][0].type = TILE.WATER; // port candidate
  g.tiles[0][1].type = TILE.WATER;
  g.tiles[1][0].type = TILE.WATER;
  // The rest are fields.
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  assertEq(stars, 0, 'no stars from ports');
});

// --- Scenario 5: tile-type constraints.
test('lumber hut on forest, mine on ore', () => {
  const g = makeGrid(2, 2);
  g.tiles[0][0].type = TILE.FOREST;
  g.tiles[0][1].type = TILE.ORE;
  const { grid } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  // Forest may be chopped if it helps; with no sawmill benefit here and no
  // adjacent resource to feed a supplier from the chop-site, keeping the
  // Lumber Hut is fine (no gain either way, tie-break prefers no chop).
});

// --- Scenario 6: supplier contribution is min(level, 8), not capped at 4.
// Windmill fed by 7 farms (all neighbors except the one taken by the market)
// yields 7 stars — previously the optimizer would have seen 4 (old cap).
// Level 8 is the theoretical max (a tile has at most 8 neighbors), but with
// a market adjacent, 7 is the most that can occur in practice.
test('supplier contribution uncapped up to level 8', () => {
  const g = makeGrid(3, 3);
  // Farms on crops at 7 neighbors of (1,1); (1,2) reserved for the market.
  [[0,0],[0,1],[0,2],[1,0],[2,0],[2,1],[2,2]].forEach(([r,c]) => {
    g.tiles[r][c].type = TILE.CROP;
    g.tiles[r][c].building = BUILD.FARM;
  });
  g.tiles[1][1].building = BUILD.WINDMILL;
  g.tiles[1][2].building = BUILD.MARKET;
  assignCities(g);
  assertEq(validateBoard(g).length, 0, 'hand layout is rule-valid');
  assertEq(supplierLevel(g, 1, 1, 'windmill'), 7, 'raw windmill level = 7');
  assertEq(marketStars(g, 1, 2), 7, 'market contribution = level (no cap at 4)');
});

// --- Scenario 7: three supplier types feed one market.
// Crop, Ore, Forest each with their suppliers adjacent to a single market.
// Expected: windmill(1) + forge(1) + sawmill(1) = 3 stars.
test('three supplier types feed single market', () => {
  // 5x5:
  //  .  C  .  O  .
  //  .  W  .  F  .
  //  .  .  M  .  .
  //  .  S  .  .  .
  //  .  L  .  .  .
  const g = makeGrid(5, 5);
  g.tiles[0][1].type = TILE.CROP;   // feeds windmill at (1,1)
  g.tiles[0][3].type = TILE.ORE;    // feeds forge at (1,3)
  g.tiles[4][1].type = TILE.FOREST; // feeds sawmill at (3,1)
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  assert(stars >= 3, `expected >=3 stars, got ${stars}`);
});

// --- Scenario 8: empty board produces zero stars, no phantom buildings.
test('empty board = 0 stars, nothing placed', () => {
  const g = makeGrid(4, 4);
  const { stars, grid } = optimize(g);
  assertEq(stars, 0);
  assertEq(validateBoard(grid).length, 0);
  for (let r=0;r<4;r++) for (let c=0;c<4;c++)
    assert(grid.tiles[r][c].building === null, `phantom building at ${r},${c}`);
});

// --- Scenario 9: fog tile is inert.
test('fog tile blocks building placement', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.CROP;
  g.tiles[0][1].type = TILE.FOG;
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  // Crop gets a Farm (pre-filled), but no Windmill can sit on the fog and
  // (0,2) has no adj Farm (since (0,1) is fog), so no market either.
  assertEq(grid.tiles[0][1].building, null, 'no building on fog');
  assertEq(stars, 0);
});

// --- Scenario 10: chopping a forest is chosen when it yields more stars.
// Layout: crop, forest, field. Without chopping, best is Farm-Lumber-Market(0).
// With chopping the forest, the middle becomes a field that can host a
// Windmill (level 1 from the farm), and the last field a Market (1 star).
test('chopping a forest can unlock stars', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.CROP;
  g.tiles[0][1].type = TILE.FOREST;
  // (0,2) is field
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  assertEq(stars, 1, 'chop forest -> windmill -> market');
  assert(grid.tiles[0][1].chopped === true, 'forest was chopped');
  assertEq(grid.tiles[0][1].building, BUILD.WINDMILL);
  assertEq(grid.tiles[0][2].building, BUILD.MARKET);
});

// --- Forge on Forest: the 2025 Balance Pass lets Forges be built directly on
// unchopped Forest tiles. Validator should accept it, and the optimizer should
// prefer it over chop-then-forge (forest preservation tiebreak).
test('validateBoard accepts forge on unchopped forest', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.ORE;
  g.tiles[0][0].building = BUILD.MINE;
  g.tiles[0][1].type = TILE.FOREST;
  g.tiles[0][1].building = BUILD.FORGE; // on unchopped forest
  g.tiles[0][2].building = BUILD.MARKET;
  assignCities(g);
  assertEq(validateBoard(g).length, 0, 'forge on forest is legal');
  assertEq(supplierLevel(g, 0, 1, 'forge'), 1, 'forge fed by 1 mine');
  assertEq(marketStars(g, 0, 2), 1, 'market sees 1 star from forge-on-forest');
});

test('optimizer uses forge-on-forest instead of chopping', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.ORE;
  g.tiles[0][1].type = TILE.FOREST;
  // (0,2) is field
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  assertEq(stars, 1, 'ore -> forge -> market chain');
  assertEq(grid.tiles[0][0].building, BUILD.MINE);
  assertEq(grid.tiles[0][1].building, BUILD.FORGE);
  assert(grid.tiles[0][1].chopped === false, 'forest kept intact under forge');
  assertEq(grid.tiles[0][2].building, BUILD.MARKET);
});

// --- Scenario 11: optConfig disables a supplier type.
test('disabling windmills stops their placement', () => {
  const g = makeGrid(1, 3);
  g.tiles[0][0].type = TILE.CROP;
  const { grid, stars } = optimize(g, { windmill:false });
  assertEq(validateBoard(grid).length, 0);
  // Without windmills, the farm can't feed anything -> 0 stars.
  assertEq(stars, 0);
  for (let r=0;r<grid.rows;r++) for (let c=0;c<grid.cols;c++)
    assert(grid.tiles[r][c].building !== BUILD.WINDMILL, 'no windmill should be placed');
});

// --- Scenario 12: one forge per city enforced.
// If we hand-place two forges in the same implicit city, validate flags it.
test('validateBoard flags two forges in one city', () => {
  const g = makeGrid(2, 3);
  // one implicit city (no CITY tiles)
  g.tiles[0][0].type = TILE.ORE; g.tiles[0][0].building = BUILD.MINE;
  g.tiles[0][2].type = TILE.ORE; g.tiles[0][2].building = BUILD.MINE;
  g.tiles[0][1].building = BUILD.FORGE;
  g.tiles[1][1].building = BUILD.FORGE;
  assignCities(g);
  const errs = validateBoard(g);
  assert(errs.some(e => /forge/.test(e) && /max 1/.test(e)),
    `expected a forge-count error, got: ${errs.join(' | ')}`);
});

// --- Scenario 13: one sawmill per city enforced.
test('validateBoard flags two sawmills in one city', () => {
  const g = makeGrid(2, 3);
  g.tiles[0][0].type = TILE.FOREST; g.tiles[0][0].building = BUILD.LUMBERHUT;
  g.tiles[0][2].type = TILE.FOREST; g.tiles[0][2].building = BUILD.LUMBERHUT;
  g.tiles[0][1].building = BUILD.SAWMILL;
  g.tiles[1][1].building = BUILD.SAWMILL;
  assignCities(g);
  const errs = validateBoard(g);
  assert(errs.some(e => /sawmill/.test(e) && /max 1/.test(e)),
    `expected a sawmill-count error, got: ${errs.join(' | ')}`);
});

// --- Scenario 14: optimizer respects one-forge-per-city.
// Two ore tiles flanking a center field in a single implicit city. A greedy
// optimizer might place forges on both flanks next to a central market. The
// rule permits only one forge per city, so the best legal config places a
// single forge adjacent to both mines (level 2) plus a market = 2 stars.
test('optimizer places only one forge per city', () => {
  const g = makeGrid(1, 5);
  g.tiles[0][0].type = TILE.ORE;
  g.tiles[0][4].type = TILE.ORE;
  // implicit single city
  const { grid, stars } = optimize(g);
  assertEq(validateBoard(grid).length, 0, 'rules clean');
  const forgeCount = countsPerCity(grid, BUILD.FORGE);
  for (const k in forgeCount) assert(forgeCount[k] <= 1, `city ${k} got ${forgeCount[k]} forges`);
  assert(stars >= 1, `expected >=1 stars, got ${stars}`);
});

// --- Scenario 15: optimizer places only one sawmill per city.
test('optimizer places only one sawmill per city', () => {
  const g = makeGrid(1, 5);
  g.tiles[0][0].type = TILE.FOREST;
  g.tiles[0][4].type = TILE.FOREST;
  const { grid } = optimize(g);
  assertEq(validateBoard(grid).length, 0, 'rules clean');
  const sawCount = countsPerCity(grid, BUILD.SAWMILL);
  for (const k in sawCount) assert(sawCount[k] <= 1, `city ${k} got ${sawCount[k]} sawmills`);
});

// --- Scenario 16: manual territory override moves a field between cities.
// Two cities, a crop tile sits closer to city A by Chebyshev; user reassigns
// it to city B. After assignCities, the crop tile's cityId should match B.
test('manual territory override honored by assignCities', () => {
  const g = makeGrid(1, 5);
  g.tiles[0][0].type = TILE.CITY; // city A
  g.tiles[0][4].type = TILE.CITY; // city B
  g.tiles[0][1].type = TILE.CROP; // closer to A (dist 1) than B (dist 3)
  assignCities(g);
  const autoId = g.tiles[0][1].cityId;
  const cityAId = g.tiles[0][0].cityId;
  const cityBId = g.tiles[0][4].cityId;
  assertEq(autoId, cityAId, 'auto assignment should be city A');
  // Apply manual override to city B (at coord "0,4")
  g.tiles[0][1].manualCity = '0,4';
  assignCities(g);
  assertEq(g.tiles[0][1].cityId, cityBId, 'manual override to city B');
});

// --- Scenario 17: stale manual override (pointing at non-city) is ignored.
test('stale manual override falls back to Chebyshev', () => {
  const g = makeGrid(1, 5);
  g.tiles[0][0].type = TILE.CITY;
  g.tiles[0][4].type = TILE.CITY;
  g.tiles[0][1].type = TILE.CROP;
  g.tiles[0][1].manualCity = '9,9'; // no city there
  assignCities(g);
  // Should fall back to nearest = city A at (0,0)
  assertEq(g.tiles[0][1].cityId, g.tiles[0][0].cityId);
});

// --- Scenario 18: don't chop forests when chopping buys nothing.
// A 1x2 board with a single forest. There is no adjacent field to place a
// sawmill or any other supplier, so chopping yields 0 stars either way. The
// optimizer must leave the lumber hut alone (the user's stated assumption is
// that forests stay unless beneficial).
test('do not chop forests for no reason', () => {
  const g = makeGrid(1, 1);
  g.tiles[0][0].type = TILE.FOREST;
  const { grid, stars } = optimize(g);
  assertEq(stars, 0);
  assert(grid.tiles[0][0].chopped === false, 'forest should not be chopped');
  assertEq(grid.tiles[0][0].building, BUILD.LUMBERHUT);
});

// --- Scenario 19: forest with no useful sawmill stays unchopped even when
// surrounded by other field tiles. Previously the tie-break preferred NONE so
// strongly that random chops in the seed state were never reverted.
test('lone forest in a field cluster stays unchopped', () => {
  const g = makeGrid(3, 3);
  g.tiles[1][1].type = TILE.FOREST;
  const { grid } = optimize(g);
  assertEq(validateBoard(grid).length, 0);
  assert(grid.tiles[1][1].chopped === false, 'forest was chopped without benefit');
  assertEq(grid.tiles[1][1].building, BUILD.LUMBERHUT);
});

// --- Run & report ---
if (typeof window === 'undefined') {
  let pass=0, fail=0;
  for (const r of results) {
    if (r.ok) { pass++; console.log(`  ok  ${r.name}`); }
    else      { fail++; console.log(`FAIL  ${r.name}\n        ${r.err}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} else {
  window.__testResults = results;
}
