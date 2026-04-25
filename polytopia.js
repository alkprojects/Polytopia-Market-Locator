// Polytopia rules engine + market optimizer (current rules).
// Adjacency is 8-directional (king moves). Map is a square grid.
//
// Current rules captured here:
//   - Windmill/Forge/Sawmill are the ONLY market-feeding suppliers.
//     (Ports / Customs Houses do NOT contribute stars to markets.)
//   - Market stars = Σ over adjacent suppliers of min(supplier.level, 8).
//   - Supplier level = count of adjacent matching resource buildings.
//   - Exactly one Market allowed per city. If no City tiles are painted,
//     the whole map is treated as one implicit city.
//   - Forge may be built on Forest (Forest remains; no Lumber Hut there).
//     Windmill, Sawmill, and Market still require empty Field.
//   - Forests may be chopped (removing Lumber Hut, exposing Field) when this
//     yields more stars/turn. Chopping is optional (optConfig.chop).
//   - All required tech is researched and all borders are purchased.

const TILE = {
  FIELD:'field', FOREST:'forest', MOUNTAIN:'mountain',
  CROP:'crop', ORE:'ore', WATER:'water', CITY:'city', BLOCKED:'blocked', FOG:'fog'
};
const BUILD = {
  NONE:null, FARM:'farm', MINE:'mine', LUMBERHUT:'lumberhut', PORT:'port',
  WINDMILL:'windmill', FORGE:'forge', SAWMILL:'sawmill', MARKET:'market'
};
const SUPPLIER_FEED = { windmill:'farm', forge:'mine', sawmill:'lumberhut' };

function effType(t){ return (t.chopped && t.type === TILE.FOREST) ? TILE.FIELD : t.type; }
function inBounds(g,r,c){ return r>=0 && c>=0 && r<g.rows && c<g.cols; }
function neighbors(g,r,c){
  const out=[];
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
    if(!dr && !dc) continue;
    const nr=r+dr, nc=c+dc;
    if(inBounds(g,nr,nc)) out.push(g.tiles[nr][nc]);
  }
  return out;
}
function makeGrid(rows,cols){
  const tiles=[];
  for(let r=0;r<rows;r++){
    const row=[];
    for(let c=0;c<cols;c++) row.push({r,c,type:TILE.FIELD,building:null,chopped:false,cityId:0,manualCity:null});
    tiles.push(row);
  }
  return {rows,cols,tiles};
}
// Buildings that are capped at 1 per city.
const UNIQUE_PER_CITY = [BUILD.MARKET, BUILD.WINDMILL, BUILD.FORGE, BUILD.SAWMILL];
function countsPerCity(g, building){
  const counts={};
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(t.building===building && t.cityId) counts[t.cityId]=(counts[t.cityId]||0)+1;
  }
  return counts;
}
// Total excess (sum over cities and unique-building types of max(0, count-1)).
// Used by the optimizer objective so it always sees a gradient away from
// violations, even when multiple cities exceed the limit.
function totalExcessPerCity(g){
  let excess=0;
  for(const b of UNIQUE_PER_CITY){
    const c = countsPerCity(g,b);
    for(const k in c) if(c[k]>1) excess += c[k]-1;
  }
  return excess;
}
function validateBoard(g){
  const errs=[];
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c], b=t.building;
    if(t.type===TILE.FOG && b) errs.push(`Building at ${r},${c} is inside fog of war`);
    if(!b) continue;
    if(b===BUILD.FARM && t.type!==TILE.CROP) errs.push(`Farm at ${r},${c} not on Crop`);
    if(b===BUILD.MINE && t.type!==TILE.ORE)  errs.push(`Mine at ${r},${c} not on Ore`);
    if(b===BUILD.LUMBERHUT && (t.type!==TILE.FOREST || t.chopped))
      errs.push(`Lumber Hut at ${r},${c} not on (unchopped) Forest`);
    if(b===BUILD.PORT){
      if(t.type!==TILE.WATER) errs.push(`Port at ${r},${c} not on Water`);
      else if(!neighbors(g,r,c).some(n=>n.type!==TILE.WATER && n.type!==TILE.FOG))
        errs.push(`Port at ${r},${c} has no adjacent land`);
    }
    if([BUILD.WINDMILL,BUILD.SAWMILL,BUILD.MARKET].includes(b) && effType(t)!==TILE.FIELD)
      errs.push(`${b} at ${r},${c} must be on empty Field`);
    if(b===BUILD.FORGE && effType(t)!==TILE.FIELD && t.type!==TILE.FOREST)
      errs.push(`Forge at ${r},${c} must be on Field or Forest`);
  }
  // One Market / Forge / Sawmill per city.
  for(const b of UNIQUE_PER_CITY){
    const c = countsPerCity(g,b);
    for(const k in c) if(c[k]>1)
      errs.push(`City ${k} has ${c[k]} ${b}s (max 1 per city)`);
  }
  return errs;
}
function supplierLevel(g,r,c,st){
  const feed = SUPPLIER_FEED[st]; if(!feed) return 0;
  let n=0;
  for(const nb of neighbors(g,r,c)) if(nb.building===feed) n++;
  return n;
}
function marketStars(g,r,c){
  let s=0;
  for(const nb of neighbors(g,r,c)){
    const b=nb.building;
    if(b===BUILD.WINDMILL || b===BUILD.FORGE || b===BUILD.SAWMILL)
      s += Math.min(supplierLevel(g,nb.r,nb.c,b), 8);
  }
  return s;
}
function totalStarsPerTurn(g){
  let s=0;
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++)
    if(g.tiles[r][c].building===BUILD.MARKET) s += marketStars(g,r,c);
  return s;
}
// Assign a cityId to tiles. User-painted overrides (t.manualCity = "r,c"
// pointing at a City tile) win. Otherwise, only tiles within Chebyshev distance
// 1 of a City (the 8 immediately adjacent tiles) are auto-assigned to the
// nearest City; tiles farther out stay city-less (id=0) until the user assigns
// them manually. Fog tiles also stay city-less. If no City is painted, the
// whole map is one implicit city (id=1).
function assignCities(g){
  const cities=[]; let next=1;
  const cityByKey = {};
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(t.type===TILE.CITY){
      t.cityId=next;
      const ci={r,c,id:next};
      cities.push(ci);
      cityByKey[r+','+c]=ci;
      next++;
    } else t.cityId=0;
  }
  if(cities.length===0){
    for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
      const t=g.tiles[r][c];
      if(t.type!==TILE.FOG) t.cityId=1;
    }
    return 1;
  }
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(t.type===TILE.CITY || t.type===TILE.FOG) continue;
    if(t.manualCity && cityByKey[t.manualCity]){
      t.cityId = cityByKey[t.manualCity].id;
      continue;
    }
    // Auto-assign only the 8 immediately adjacent tiles (Chebyshev distance 1).
    // Tiles farther out stay city-less until the user manually assigns them.
    let bestD=Infinity, bestId=0;
    for(const ci of cities){
      const d=Math.max(Math.abs(r-ci.r), Math.abs(c-ci.c));
      if(d<bestD){ bestD=d; bestId=ci.id; }
    }
    t.cityId = (bestD<=1) ? bestId : 0;
  }
  return cities.length;
}
function maxMarketsPerCity(g){
  const counts={};
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(t.building===BUILD.MARKET && t.cityId) counts[t.cityId]=(counts[t.cityId]||0)+1;
  }
  let mx=0; for(const k in counts) if(counts[k]>mx) mx=counts[k];
  return mx;
}
function prefillResources(g){
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c]; if(t.building) continue;
    if(t.type===TILE.FOG) continue;
    if(!t.cityId) continue; // out-of-territory: no auto resources
    if(t.type===TILE.CROP) t.building=BUILD.FARM;
    else if(t.type===TILE.ORE) t.building=BUILD.MINE;
    else if(t.type===TILE.FOREST && !t.chopped) t.building=BUILD.LUMBERHUT;
    else if(t.type===TILE.WATER && neighbors(g,r,c).some(n=>n.type!==TILE.WATER && n.type!==TILE.BLOCKED && n.type!==TILE.FOG))
      t.building=BUILD.PORT;
  }
}
function buildablePool(g){
  const out=[];
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(!t.cityId) continue; // out-of-territory: can't build here
    if(effType(t)===TILE.FIELD) out.push(t);
  }
  return out;
}
function cloneGrid(g){
  const ng={rows:g.rows,cols:g.cols,tiles:[]};
  for(let r=0;r<g.rows;r++){
    const row=[];
    for(let c=0;c<g.cols;c++){
      const t=g.tiles[r][c];
      row.push({r:t.r,c:t.c,type:t.type,building:t.building,chopped:!!t.chopped,cityId:t.cityId||0,manualCity:t.manualCity||null});
    }
    ng.tiles.push(row);
  }
  return ng;
}

const DEFAULT_CONFIG = { windmill:true, forge:true, sawmill:true, chop:true };

function movesFor(t, cfg){
  const suppliers=[];
  if(cfg.windmill) suppliers.push(BUILD.WINDMILL);
  if(cfg.forge)    suppliers.push(BUILD.FORGE);
  if(cfg.sawmill)  suppliers.push(BUILD.SAWMILL);
  const fieldRoles=[BUILD.NONE, ...suppliers, BUILD.MARKET];
  if(t.type===TILE.FOREST){
    const moves=[{chopped:false,building:BUILD.LUMBERHUT}];
    // Forge may be built directly on Forest (2025 Balance Pass rule).
    if(cfg.forge) moves.push({chopped:false,building:BUILD.FORGE});
    if(cfg.chop) for(const b of fieldRoles) moves.push({chopped:true,building:b});
    return moves;
  }
  return fieldRoles.map(b=>({chopped:false,building:b}));
}
function applyMove(t,m){ t.chopped=m.chopped; t.building=m.building; }
function objective(g){
  return totalStarsPerTurn(g) - 10000 * totalExcessPerCity(g);
}
function hillClimb(g, cfg){
  const pool=[];
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if(!t.cityId) continue; // skip out-of-territory tiles
    if(t.type===TILE.FIELD || t.type===TILE.FOREST) pool.push(t);
  }
  let improved=true, best=objective(g), iter=0;
  while(improved && iter<400){
    improved=false; iter++;
    // Single-tile moves.
    for(const t of pool){
      const origB=t.building, origC=!!t.chopped;
      let bestM={chopped:origC,building:origB}, bestScore=best;
      for(const m of movesFor(t,cfg)){
        applyMove(t,m);
        const s=objective(g);
        // Tie-break priority (highest first):
        //   1. Prefer NOT chopping a forest (user assumption: forests stay).
        //   2. Within the same chop state, prefer no building over an idle one.
        let tie = false;
        if(s===bestScore){
          if(bestM.chopped && !m.chopped) tie = true;
          else if(!!m.chopped === !!bestM.chopped &&
                  m.building===BUILD.NONE && bestM.building!==BUILD.NONE) tie = true;
        }
        if(s>bestScore || tie){ bestScore=s; bestM=m; }
      }
      applyMove(t,bestM);
      if(bestM.building!==origB || bestM.chopped!==origC) improved=true;
      best=bestScore;
    }
    // Pair-swap pass: try swapping roles between every pair of pool tiles.
    // Escapes local optima where moving a single tile can't help (e.g. a
    // market and a supplier blocking each other's ideal slots).
    for(let i=0;i<pool.length;i++){
      for(let j=i+1;j<pool.length;j++){
        const a=pool[i], b=pool[j];
        const aB=a.building, aC=!!a.chopped, bB=b.building, bC=!!b.chopped;
        // A swap only makes sense if each tile can legally host the other's
        // building. Check via movesFor — candidate must appear in its move set.
        const aMoves=movesFor(a,cfg), bMoves=movesFor(b,cfg);
        const aCan=aMoves.some(m=>m.building===bB && m.chopped===bC);
        const bCan=bMoves.some(m=>m.building===aB && m.chopped===aC);
        if(!aCan||!bCan) continue;
        applyMove(a,{building:bB,chopped:bC});
        applyMove(b,{building:aB,chopped:aC});
        const s=objective(g);
        if(s>best){ best=s; improved=true; }
        else {
          applyMove(a,{building:aB,chopped:aC});
          applyMove(b,{building:bB,chopped:bC});
        }
      }
    }
  }
  return totalStarsPerTurn(g);
}
function optimize(gIn, cfgIn){
  const cfg = Object.assign({}, DEFAULT_CONFIG, cfgIn||{});
  const g = cloneGrid(gIn);
  for(let r=0;r<g.rows;r++) for(let c=0;c<g.cols;c++){
    const t=g.tiles[r][c];
    if([BUILD.WINDMILL,BUILD.FORGE,BUILD.SAWMILL,BUILD.MARKET].includes(t.building)) t.building=null;
    if(t.type===TILE.FOREST){ t.chopped=false; t.building=null; }
  }
  assignCities(g);
  prefillResources(g);

  let bestGrid=null, bestScore=-1;

  const g1=cloneGrid(g);
  for(const t of buildablePool(g1)) t.building=BUILD.MARKET;
  const s1=hillClimb(g1,cfg); if(s1>bestScore){ bestScore=s1; bestGrid=g1; }

  const g2=cloneGrid(g);
  for(const t of buildablePool(g2)){
    const sc={};
    if(cfg.windmill) sc.windmill = supplierLevel(g2,t.r,t.c,'windmill');
    if(cfg.forge)    sc.forge    = supplierLevel(g2,t.r,t.c,'forge');
    if(cfg.sawmill)  sc.sawmill  = supplierLevel(g2,t.r,t.c,'sawmill');
    let bk=null,bv=0;
    for(const k of Object.keys(sc)) if(sc[k]>bv){ bv=sc[k]; bk=k; }
    t.building = bk || BUILD.MARKET;
  }
  const s2=hillClimb(g2,cfg); if(s2>bestScore){ bestScore=s2; bestGrid=g2; }

  // Seed 2b: for every candidate market position, build the best legal
  // 1-of-each supplier configuration *around* it, then hill climb. This
  // breaks the local optimum where a misplaced market blocks a third supplier.
  const mkPool = buildablePool(g);
  for(const mkTile of mkPool){
    const g2b = cloneGrid(g);
    const mk = g2b.tiles[mkTile.r][mkTile.c];
    mk.building = BUILD.MARKET;
    // For each supplier type, pick the adjacent field with the most feed.
    const candTypes = [];
    if(cfg.windmill) candTypes.push('windmill');
    if(cfg.forge)    candTypes.push('forge');
    if(cfg.sawmill)  candTypes.push('sawmill');
    for(const st of candTypes){
      let best={lvl:0, tile:null};
      for(const nb of neighbors(g2b, mk.r, mk.c)){
        if(effType(nb)!==TILE.FIELD || nb.building) continue;
        const lvl = supplierLevel(g2b, nb.r, nb.c, st);
        if(lvl>best.lvl){ best={lvl, tile:nb}; }
      }
      if(best.tile){
        best.tile.building = { windmill:BUILD.WINDMILL, forge:BUILD.FORGE, sawmill:BUILD.SAWMILL }[st];
      }
    }
    const s2b=hillClimb(g2b,cfg);
    if(s2b>bestScore){ bestScore=s2b; bestGrid=g2b; }
  }

  const ROLES=[BUILD.MARKET];
  if(cfg.windmill) ROLES.push(BUILD.WINDMILL);
  if(cfg.forge)    ROLES.push(BUILD.FORGE);
  if(cfg.sawmill)  ROLES.push(BUILD.SAWMILL);
  for(let trial=0; trial<80; trial++){
    const g3=cloneGrid(g);
    for(const t of buildablePool(g3)) t.building=ROLES[Math.floor(Math.random()*ROLES.length)];
    for(let r=0;r<g3.rows;r++) for(let c=0;c<g3.cols;c++){
      const t=g3.tiles[r][c];
      if(t.type===TILE.FOREST && cfg.chop && Math.random()<0.3){ t.chopped=true; t.building=null; }
    }
    const s3=hillClimb(g3,cfg); if(s3>bestScore){ bestScore=s3; bestGrid=g3; }
  }
  return { grid: bestGrid, stars: bestScore };
}

const __exports = {
  TILE, BUILD, UNIQUE_PER_CITY, makeGrid, neighbors, validateBoard, effType,
  supplierLevel, marketStars, totalStarsPerTurn, maxMarketsPerCity,
  countsPerCity, totalExcessPerCity,
  prefillResources, assignCities, optimize, cloneGrid
};
if (typeof module !== 'undefined') module.exports = __exports;
if (typeof window !== 'undefined') window.Polytopia = __exports;
