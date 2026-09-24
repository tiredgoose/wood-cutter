// Offscreen-rendered sprites. Trees are drawn once per (tier, variant, resolution) and blitted every frame.
import { TREE_TYPES, BIOMES, GRID, TILE_W, TILE_H } from "./data.js";
import { shadeC, isoToScreen } from "./util.js";

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export const TREE_VARIANTS = 3;
// sprite box in world px; anchor is the trunk base
const BOX = [
  { w: 56, h: 84, ax: 28, ay: 76 },
  { w: 60, h: 80, ax: 30, ay: 72 },
  { w: 72, h: 92, ax: 36, ay: 84 },
  { w: 52, h: 104, ax: 26, ay: 96 },
  { w: 68, h: 104, ax: 34, ay: 96 },
  { w: 100, h: 132, ax: 50, ay: 122 },
];
export function treeBox(tier) {
  return BOX[tier];
}

const OUTLINE = "rgba(10,20,10,.55)";

function blob(ctx, x, y, r, fill, light) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (light) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function trunk(ctx, w, h, col, flare = 0) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-w / 2 - flare, 0);
  ctx.lineTo(-w / 2, -h);
  ctx.lineTo(w / 2, -h);
  ctx.lineTo(w / 2 + flare, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // lit left half of the bark
  ctx.fillStyle = "rgba(255,230,190,.14)";
  ctx.fillRect(-w / 2, -h, w / 2, h);
}

/** Draws a split-lit triangle layer (pine / cypress style). */
function cone(ctx, cx, top, bottom, halfW, col) {
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + halfW, bottom);
  ctx.quadraticCurveTo(cx, bottom + halfW * 0.28, cx - halfW, bottom);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,220,.13)";
  ctx.fillRect(cx - halfW - 2, top, halfW + 2, bottom - top + halfW);
  ctx.fillStyle = "rgba(0,0,20,.16)";
  ctx.fillRect(cx + halfW * 0.25, top, halfW, bottom - top + halfW);
  ctx.restore();
}

const DRAW = [
  // 0 Pine
  (ctx, T, r) => {
    trunk(ctx, 5, 14, T.tr);
    let layers = 3 + Math.floor(r() * 2);
    let base = -10,
      top = -66 - r() * 6;
    for (let i = 0; i < layers; i++) {
      let f = i / layers;
      let b = base - (base - top) * f * 0.78;
      let hw = 20 - f * 12 + r() * 2;
      cone(ctx, 0, b - 26 + f * 4, b, hw, shadeC(T.c, Math.round(-8 + f * 22)));
    }
  },
  // 1 Oak
  (ctx, T, r) => {
    trunk(ctx, 7, 26, T.tr, 2);
    let pts = [
      [0, -44, 17],
      [-13, -36, 12],
      [13, -37, 12],
      [-7, -54, 12],
      [8, -53, 12],
    ];
    for (let [x, y, rr] of pts) blob(ctx, x + (r() - 0.5) * 4, y + (r() - 0.5) * 4, rr + r() * 3, shadeC(T.c, -14), null);
    for (let [x, y, rr] of pts) blob(ctx, x + (r() - 0.5) * 3, y - 2, rr - 2, T.c, shadeC(T.c, 26));
  },
  // 2 Mahogany: tall trunk, wide umbrella canopy
  (ctx, T, r) => {
    trunk(ctx, 7, 42, T.tr, 3);
    ctx.strokeStyle = T.tr;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -30);
    ctx.lineTo(-14, -46);
    ctx.moveTo(0, -34);
    ctx.lineTo(15, -48);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = OUTLINE;
    for (let i = 0; i < 3; i++) {
      let y = -52 - i * 7,
        w = 32 - i * 7 + r() * 3;
      ctx.fillStyle = shadeC(T.c, -10 + i * 14);
      ctx.beginPath();
      ctx.ellipse((r() - 0.5) * 4, y, w, 9 - i, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  },
  // 3 Ironwood: columnar, steel-tinted
  (ctx, T, r) => {
    trunk(ctx, 6, 20, T.tr);
    let h = 80 + r() * 8;
    ctx.beginPath();
    ctx.moveTo(0, -h - 12);
    ctx.bezierCurveTo(16, -h + 6, 17, -30, 0, -14);
    ctx.bezierCurveTo(-17, -30, -16, -h + 6, 0, -h - 12);
    ctx.fillStyle = T.c;
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(170,200,230,.18)";
    ctx.fillRect(-18, -h - 14, 16, h);
    ctx.fillStyle = "rgba(0,0,25,.22)";
    ctx.fillRect(4, -h - 14, 16, h);
    ctx.strokeStyle = "rgba(160,190,220,.25)";
    for (let i = 0; i < 6; i++) {
      let y = -24 - i * 11;
      ctx.beginPath();
      ctx.moveTo(-12, y);
      ctx.quadraticCurveTo(0, y - 6, 12, y);
      ctx.stroke();
    }
    ctx.restore();
  },
  // 4 Heartwood: twisted trunk, violet canopy with glowing cores
  (ctx, T, r) => {
    ctx.fillStyle = T.tr;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.bezierCurveTo(-10, -14, 4, -22, -2, -40);
    ctx.lineTo(4, -40);
    ctx.bezierCurveTo(10, -22, -2, -14, 6, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    let pts = [
      [0, -58, 18],
      [-16, -48, 13],
      [16, -49, 13],
      [-8, -72, 12],
      [9, -71, 12],
    ];
    for (let [x, y, rr] of pts) blob(ctx, x, y, rr + r() * 3, shadeC(T.c, -12), null);
    for (let [x, y, rr] of pts) blob(ctx, x, y - 2, rr - 3, T.c, shadeC(T.c, 30));
    for (let i = 0; i < 5; i++) {
      let x = (r() - 0.5) * 34,
        y = -48 - r() * 28;
      let g = ctx.createRadialGradient(x, y, 0, x, y, 5);
      g.addColorStop(0, "rgba(255,160,255,.95)");
      g.addColorStop(1, "rgba(255,120,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  // 5 Worldtree: massive trunk, roots, golden canopy
  (ctx, T, r) => {
    ctx.fillStyle = T.tr;
    ctx.beginPath();
    ctx.moveTo(-22, 0);
    ctx.quadraticCurveTo(-10, -6, -9, -56);
    ctx.lineTo(9, -56);
    ctx.quadraticCurveTo(10, -6, 22, 0);
    ctx.quadraticCurveTo(0, 5, -22, 0);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,220,160,.12)";
    ctx.fillRect(-9, -56, 8, 56);
    let pts = [
      [0, -86, 26],
      [-26, -72, 19],
      [26, -73, 19],
      [-14, -104, 17],
      [14, -103, 17],
      [-34, -90, 13],
      [34, -91, 13],
      [0, -112, 14],
    ];
    for (let [x, y, rr] of pts) blob(ctx, x, y, rr + r() * 3, shadeC(T.c, -18), null);
    for (let [x, y, rr] of pts) blob(ctx, x, y - 3, rr - 4, shadeC(T.c, 10), "#c89a3a");
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = r() < 0.5 ? "#ffd86a" : "#ffe9a8";
      ctx.fillRect((r() - 0.5) * 70, -70 - r() * 50, 2, 2);
    }
  },
];

const treeCache = new Map();
/** Returns {img, box, scale} for a tree tier/variant at a given pixel density. */
export function treeSprite(tier, variant, density) {
  const d = Math.max(1, Math.min(6, Math.ceil(density * 2) / 2));
  const key = `${tier}|${variant}|${d}`;
  let s = treeCache.get(key);
  if (s) return s;
  const box = BOX[tier];
  const c = makeCanvas(Math.ceil(box.w * d), Math.ceil(box.h * d));
  const ctx = c.getContext("2d");
  ctx.scale(d, d);
  ctx.translate(box.ax, box.ay);
  ctx.lineWidth = 1;
  ctx.strokeStyle = OUTLINE;
  ctx.lineJoin = "round";
  DRAW[tier](ctx, TREE_TYPES[tier], mulberry32(tier * 1000 + variant * 77 + 1));
  s = { img: c, box, d };
  treeCache.set(key, s);
  return s;
}

export function clearSpriteCache() {
  treeCache.clear();
  groundCache.clear();
}

// --------------------------------------------------------------------------- ground
export const SLAB = 18; // thickness of the map "block" in world px
export const MAP_BOUNDS = {
  x: -(GRID * TILE_W) / 2 - 4,
  y: -4,
  w: GRID * TILE_W + 8,
  h: GRID * TILE_H + SLAB + 8,
};
const DECOR = [
  { tuft: "#3f7a2a", extra: null },
  { tuft: "#2f6a4a", extra: "puddle" },
  { tuft: "#5a5a3a", extra: "rock" },
  { tuft: "#4a4a8a", extra: "flower" },
  { tuft: "#8aa0b0", extra: "snow" },
];
const groundCache = new Map();

/** The whole isometric slab for a biome, pre-rendered. Buildings' tiles get a dirt pad. */
export function groundSprite(bi, density, padTiles) {
  const d = Math.max(1, Math.min(6, Math.ceil(density * 2) / 2));
  const key = `${bi}|${d}|${padTiles.join(",")}`;
  let s = groundCache.get(key);
  if (s) return s;
  const B = MAP_BOUNDS;
  const c = makeCanvas(Math.ceil(B.w * d), Math.ceil(B.h * d));
  const ctx = c.getContext("2d");
  ctx.scale(d, d);
  ctx.translate(-B.x, -B.y);
  const biome = BIOMES[bi],
    r = mulberry32(bi * 97 + 5),
    dec = DECOR[bi] || DECOR[0];

  // slab sides
  const L = isoToScreen(0, GRID),
    R = isoToScreen(GRID, 0),
    Bt = isoToScreen(GRID, GRID);
  ctx.fillStyle = "#4a3422";
  ctx.beginPath();
  ctx.moveTo(L.x, L.y);
  ctx.lineTo(Bt.x, Bt.y);
  ctx.lineTo(Bt.x, Bt.y + SLAB);
  ctx.lineTo(L.x, L.y + SLAB);
  ctx.fill();
  ctx.fillStyle = "#35251a";
  ctx.beginPath();
  ctx.moveTo(R.x, R.y);
  ctx.lineTo(Bt.x, Bt.y);
  ctx.lineTo(Bt.x, Bt.y + SLAB);
  ctx.lineTo(R.x, R.y + SLAB);
  ctx.fill();
  // strata lines
  ctx.strokeStyle = "rgba(0,0,0,.18)";
  for (let k = 1; k < 3; k++) {
    let o = (SLAB * k) / 3;
    ctx.beginPath();
    ctx.moveTo(L.x, L.y + o);
    ctx.lineTo(Bt.x, Bt.y + o);
    ctx.lineTo(R.x, R.y + o);
    ctx.stroke();
  }
  // grass lip
  ctx.fillStyle = shadeC(biome.g1, -8);
  ctx.beginPath();
  ctx.moveTo(L.x, L.y);
  ctx.lineTo(Bt.x, Bt.y);
  ctx.lineTo(R.x, R.y);
  ctx.lineTo(R.x, R.y + 4);
  ctx.lineTo(Bt.x, Bt.y + 4);
  ctx.lineTo(L.x, L.y + 4);
  ctx.fill();

  const pads = new Set(padTiles);
  for (let gx = 0; gx < GRID; gx++)
    for (let gy = 0; gy < GRID; gy++) {
      const { x, y } = isoToScreen(gx, gy);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + TILE_W / 2, y + TILE_H / 2);
      ctx.lineTo(x, y + TILE_H);
      ctx.lineTo(x - TILE_W / 2, y + TILE_H / 2);
      ctx.closePath();
      let base = (gx + gy) % 2 === 0 ? biome.g1 : biome.g2;
      ctx.fillStyle = pads.has(`${gx},${gy}`) ? "#6a5238" : shadeC(base, Math.round((r() - 0.5) * 10));
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.10)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      if (pads.has(`${gx},${gy}`)) continue;
      // speckles & tufts
      for (let k = 0; k < 5; k++) {
        let u = r() - 0.5,
          v = r() - 0.5;
        let px = x + (u - v) * TILE_W * 0.8,
          py = y + TILE_H / 2 + (u + v) * TILE_H * 0.8;
        ctx.fillStyle = r() < 0.5 ? shadeC(base, 14) : shadeC(base, -14);
        ctx.fillRect(px, py, 1.5, 1);
      }
      if (r() < 0.35) {
        let px = x + (r() - 0.5) * 30,
          py = y + TILE_H / 2 + (r() - 0.5) * 12;
        ctx.strokeStyle = dec.tuft;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = -1; k <= 1; k++) {
          ctx.moveTo(px + k * 2, py);
          ctx.lineTo(px + k * 3, py - 4 - r() * 2);
        }
        ctx.stroke();
      }
      if (dec.extra && r() < 0.12) {
        let px = x + (r() - 0.5) * 24,
          py = y + TILE_H / 2 + (r() - 0.5) * 8;
        if (dec.extra === "puddle") {
          ctx.fillStyle = "rgba(90,140,150,.45)";
          ctx.beginPath();
          ctx.ellipse(px, py, 7, 3, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (dec.extra === "rock") {
          ctx.fillStyle = "#77736a";
          ctx.beginPath();
          ctx.ellipse(px, py, 4, 2.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#9a968a";
          ctx.fillRect(px - 2, py - 2, 2, 1);
        } else if (dec.extra === "flower") {
          ctx.fillStyle = r() < 0.5 ? "#c9a0ff" : "#80e0ff";
          ctx.fillRect(px, py, 2, 2);
          ctx.fillRect(px + 4, py + 1, 2, 2);
        } else if (dec.extra === "snow") {
          ctx.fillStyle = "rgba(240,248,255,.7)";
          ctx.beginPath();
          ctx.ellipse(px, py, 8, 3.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  s = { img: c, d };
  groundCache.set(key, s);
  return s;
}
