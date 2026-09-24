// Canvas renderer: camera, sprites, particles, floating text, weather and lighting.
// Everything here is visual only and runs per frame with real dt; the simulation never reads it.
import { GRID, TILE_W, TILE_H, TREE_TYPES, BUILDINGS, BOSS_TYPES } from "./data.js";
import { lerp, rand, pick, clamp, lerpC, shadeC, isoToScreen, fmt } from "./util.js";
import { treeSprite, treeBox, groundSprite, MAP_BOUNDS, TREE_VARIANTS, mulberry32 } from "./sprites.js";

const MAX_PARTICLES = 500;
const MAX_FLOATS = 50;
export const MIN_ZOOM = 0.45,
  MAX_ZOOM = 2.6;

export const BUILDING_TILES = BUILDINGS.map((b) => `${Math.floor(b.pos.gx)},${Math.floor(b.pos.gy)}`);

function buildingVisible(g, b) {
  switch (b.name) {
    case "Sawmill":
      return g.upgrades.sawmill > 0;
    case "Market":
      return g.upgrades.market > 0 || g.workers.some((w) => w.type === "merchant");
    case "Nursery":
      return g.upgrades.replant > 0;
    case "Kiln":
      return g.techs.charcoalKiln;
    case "Workshop":
      return g.techs.furnWorkshop;
    case "Dock":
      return g.techs.exportDock;
  }
  return false;
}

// day/night key frames: [dayTime, skyTop, skyBottom, ambient tint, darkness]
const SKY = [
  [0.0, "#070a22", "#141836", "#5566aa", 0.62],
  [0.2, "#070a22", "#141836", "#5566aa", 0.62],
  [0.27, "#34406e", "#c0785a", "#e0b0a0", 0.25],
  [0.34, "#2a5a92", "#8ab0d0", "#ffffff", 0],
  [0.66, "#2a5a92", "#8ab0d0", "#ffffff", 0],
  [0.74, "#4a3a6a", "#e08a4a", "#ffc090", 0.2],
  [0.8, "#0c1030", "#2a1e3a", "#6a70b0", 0.55],
  [1.0, "#070a22", "#141836", "#5566aa", 0.62],
];
function skyAt(t) {
  for (let i = 0; i < SKY.length - 1; i++) {
    let a = SKY[i],
      b = SKY[i + 1];
    if (t >= a[0] && t <= b[0]) {
      let k = (t - a[0]) / (b[0] - a[0] || 1);
      return { top: lerpC(a[1], b[1], k), bot: lerpC(a[2], b[2], k), tint: lerpC(a[3], b[3], k), dark: lerp(a[4], b[4], k) };
    }
  }
  return { top: SKY[0][1], bot: SKY[0][2], tint: SKY[0][3], dark: SKY[0][4] };
}

export class Renderer {
  constructor(canvas, game, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.settings = settings;
    this.cam = { x: 0, y: (GRID * TILE_H) / 2 - 30, zoom: 1 };
    this.W = this.H = 0;
    this.dpr = 1;
    this.particles = [];
    this.floats = [];
    this.weather = [];
    this.leaves = [];
    this.falls = [];
    this.anim = new WeakMap(); // tree -> {wb, grow}
    this.workerPos = new WeakMap();
    this.hovered = null;
    this.shake = 0;
    this.time = 0;
    this.frameDt = 0;
    const r = mulberry32(42);
    this.stars = Array.from({ length: 90 }, () => ({ x: r(), y: r() * 0.6, s: r() * 1.4 + 0.3, p: r() * 6 }));
    this.setGame(game);
  }

  setGame(game) {
    this.game = game;
    this.falls = [];
    this.particles = [];
    this.floats = [];
    game.on((type, d) => this.onGameEvent(type, d));
  }

  resize(cssW, cssH) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.W = cssW;
    this.H = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    if (!this.userZoomed) this.fitView();
  }
  fitView() {
    const fit = Math.min(this.W / (GRID * TILE_W + 60), this.H / (GRID * TILE_H + 190));
    this.cam.zoom = clamp(fit, MIN_ZOOM, 1.6);
    this.cam.x = 0;
    this.cam.y = (GRID * TILE_H) / 2 - 34;
    this.userZoomed = false;
  }

  // ------------------------------------------------------------ camera
  worldToScreen(wx, wy) {
    return { x: this.W / 2 + (wx - this.cam.x) * this.cam.zoom, y: this.H / 2 + (wy - this.cam.y) * this.cam.zoom };
  }
  screenToWorld(sx, sy) {
    return { x: this.cam.x + (sx - this.W / 2) / this.cam.zoom, y: this.cam.y + (sy - this.H / 2) / this.cam.zoom };
  }
  pan(dx, dy) {
    this.cam.x -= dx / this.cam.zoom;
    this.cam.y -= dy / this.cam.zoom;
    this.clampCam();
  }
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = clamp(this.cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.userZoomed = true;
    this.clampCam();
  }
  clampCam() {
    const hw = (GRID * TILE_W) / 2;
    this.cam.x = clamp(this.cam.x, -hw, hw);
    this.cam.y = clamp(this.cam.y, -60, GRID * TILE_H + 20);
  }

  /** Front-most living tree under a screen point (trees are tall, so test against the canopy). */
  pickTree(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    let best = null,
      bestDepth = -Infinity;
    for (let t of this.game.cTrees) {
      if (!t.alive) continue;
      const p = isoToScreen(t.gx + 0.5, t.gy + 0.5);
      const box = treeBox(t.tier),
        sc = t.sc || 1;
      const hw = Math.max(14, box.w * 0.36) * sc,
        top = (box.ay - 6) * sc;
      const inBody = Math.abs(w.x - p.x) < hw && w.y < p.y + 8 && w.y > p.y - top;
      const nearBase = (w.x - p.x) ** 2 + (w.y - p.y + 14) ** 2 < 22 * 22;
      if ((inBody || nearBase) && t.gx + t.gy > bestDepth) {
        bestDepth = t.gx + t.gy;
        best = t;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ game events -> effects
  onGameEvent(type, d) {
    const fx = this.settings.effects !== "low";
    if (type === "hit") {
      const a = this.animOf(d.tree);
      a.wb = 1;
      const p = isoToScreen(d.tree.gx + 0.5, d.tree.gy + 0.5);
      const spark = this.game.axeCosmetic.spark;
      if (fx || d.manual) {
        for (let i = 0; i < (d.manual ? 6 : 2); i++)
          this.addParticle(p.x + rand(-6, 6), p.y - 16 + rand(-6, 6), rand(-90, 90), rand(-160, -40), d.crit ? "#ffd700" : spark, rand(1.5, 3.5), 0.7);
      }
      if (d.manual && this.settings.damageNumbers) this.addFloat(p.x, p.y - 44, fmt(d.dmg), d.crit ? "#ffd700" : "#ffe0c0", d.crit ? 16 : 12);
    } else if (type === "fell") {
      const t = d.tree;
      const p = isoToScreen(t.gx + 0.5, t.gy + 0.5);
      this.falls.push({ x: p.x, y: p.y, tier: t.tier, v: this.variantOf(t), sc: t.sc || 1, mut: t.mutation, dir: Math.random() < 0.5 ? 1 : -1, t: 0 });
      if (fx || d.manual)
        for (let i = 0; i < (fx ? 12 : 5); i++)
          this.addParticle(p.x + rand(-18, 18), p.y - 30 + rand(-14, 10), rand(-120, 120), rand(-200, -40), shadeC(TREE_TYPES[t.tier].c, Math.round(rand(-20, 20))), rand(2, 5), 1.1);
      if (fx && this.game.weatherSeason === 2)
        for (let i = 0; i < 6; i++) this.addLeaf(p.x + rand(-12, 12), p.y - 40, pick(["#aa5a1a", "#cc7a2a", "#8a5a2a", "#d49a3a"]));
      // automatic fells are throttled so a big crew doesn't bury the map in numbers
      if (d.manual || (fx && this.time - (this.lastAutoFloat || 0) > 0.3)) {
        if (!d.manual) this.lastAutoFloat = this.time;
        this.addFloat(p.x, p.y - 62, `+${fmt(d.logs)} 🪵`, d.crit ? "#ffd700" : "#a8f0a0", d.manual ? 14 : 11);
      }
      if (d.manual) this.shake = 0.12;
    } else if (type === "burn") {
      const p = isoToScreen(d.tree.gx + 0.5, d.tree.gy + 0.5);
      for (let i = 0; i < 14; i++)
        this.addParticle(p.x + rand(-10, 10), p.y - rand(10, 50), rand(-20, 20), rand(-90, -30), pick(["#ff8a2a", "#ffcc40", "#555"]), rand(2, 5), 1.4, -60);
    } else if (type === "grow") {
      this.animOf(d.tree).grow = 0;
    } else if (type === "bossSpawn") {
      this.shake = 0.35;
    }
  }
  animOf(t) {
    let a = this.anim.get(t);
    if (!a) {
      a = { wb: 0, grow: 1 };
      this.anim.set(t, a);
    }
    return a;
  }
  variantOf(t) {
    return (t.gx * 7 + t.gy * 13) % TREE_VARIANTS;
  }
  addParticle(x, y, vx, vy, c, s, life, grav = 520) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ x, y, vx, vy, c, s, life, max: life, grav });
  }
  addFloat(x, y, text, color, size = 12) {
    if (this.floats.length >= MAX_FLOATS) this.floats.shift();
    this.floats.push({ x, y, text, color, size, t: 0 });
  }
  addLeaf(x, y, c) {
    if (this.leaves.length > 160) return;
    this.leaves.push({ x, y, vx: rand(-20, 20), vy: rand(18, 40), r: rand(0, 6.28), rs: rand(-3, 3), life: 1, s: rand(3, 6), c });
  }

  // ------------------------------------------------------------ per-frame update of visual state
  update(dt) {
    this.frameDt = dt;
    this.time += dt;
    const g = this.game;
    if (this.shake > 0) this.shake -= dt;
    for (let p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.grav * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (let f of this.floats) f.t += dt;
    this.floats = this.floats.filter((f) => f.t < 1.1);
    for (let f of this.falls) f.t += dt;
    this.falls = this.falls.filter((f) => f.t < 0.9);
    for (let t of g.cTrees) {
      const a = this.anim.get(t);
      if (!a) continue;
      if (a.wb > 0) a.wb = Math.max(0, a.wb - dt * 5);
      if (a.grow < 1) a.grow = Math.min(1, a.grow + dt * 3);
    }
    // ambient leaves (world space)
    const lowFx = this.settings.effects === "low";
    const leafRate = lowFx ? 0.5 : g.weatherSeason === 2 ? 7 : 2;
    if (Math.random() < dt * leafRate) {
      const p = isoToScreen(rand(0, GRID), rand(0, GRID));
      this.addLeaf(p.x + rand(-30, 30), p.y - 80, pick(["#4a8a3a", "#6aaa4a", "#8a6a2a", "#aa8a3a", "#3a6a2a"]));
    }
    const wind = Math.sin(this.time * 0.3) * 14;
    for (let l of this.leaves) {
      l.x += (l.vx + wind + Math.sin(l.life * 6) * 12) * dt;
      l.y += l.vy * dt;
      l.r += l.rs * dt;
      l.life -= dt * 0.22;
    }
    this.leaves = this.leaves.filter((l) => l.life > 0);
    // screen-space weather
    const season = g.weatherSeason;
    const night = skyAt(g.dayTime).dark > 0.4;
    let rate = 0,
      kind = null;
    if (season === 0) (rate = lowFx ? 25 : 90), (kind = "rain");
    else if (season === 3) (rate = lowFx ? 12 : 40), (kind = "snow");
    else if (season === 1 && night) (rate = lowFx ? 1 : 4), (kind = "fly");
    let n = rate * dt;
    while (n > 0 && kind) {
      if (Math.random() < n) {
        if (kind === "rain") this.weather.push({ k: "rain", x: rand(-60, this.W + 60), y: -20, vx: -60, vy: rand(620, 760), life: 2 });
        else if (kind === "snow") this.weather.push({ k: "snow", x: rand(-40, this.W + 40), y: -10, vx: rand(-20, 20), vy: rand(30, 60), life: 12, s: rand(1.5, 3.2) });
        else this.weather.push({ k: "fly", x: rand(0, this.W), y: rand(this.H * 0.3, this.H * 0.9), vx: rand(-15, 15), vy: rand(-10, 10), life: rand(4, 8), ph: rand(0, 6) });
      }
      n -= 1;
    }
    for (let w of this.weather) {
      w.x += (w.vx + (w.k === "snow" ? Math.sin(this.time + w.y * 0.02) * 15 : 0)) * dt;
      w.y += w.vy * dt;
      w.life -= dt;
    }
    this.weather = this.weather.filter((w) => w.life > 0 && w.y < this.H + 20);
  }

  // ------------------------------------------------------------ draw
  draw() {
    const g = this.game,
      ctx = this.ctx,
      W = this.W,
      H = this.H,
      z = this.cam.zoom,
      dpr = this.dpr;
    const sky = skyAt(g.dayTime);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, sky.top);
    grd.addColorStop(1, sky.bot);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    if (sky.dark > 0.2) {
      ctx.fillStyle = "#fff";
      for (let s of this.stars) {
        ctx.globalAlpha = (sky.dark - 0.2) * (0.6 + 0.4 * Math.sin(this.time * 2 + s.p));
        ctx.fillRect(s.x * W, s.y * H, s.s, s.s);
      }
      ctx.globalAlpha = 1;
    }

    // world transform
    let ox = W / 2 - this.cam.x * z,
      oy = H / 2 - this.cam.y * z;
    if (this.shake > 0 && this.settings.effects !== "low") {
      ox += rand(-3, 3);
      oy += rand(-3, 3);
    }
    ctx.setTransform(dpr * z, 0, 0, dpr * z, ox * dpr, oy * dpr);
    const density = dpr * z;

    // ground
    const gs = groundSprite(g.cZone.bi, density, BUILDING_TILES);
    const B = MAP_BOUNDS;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gs.img, B.x, B.y, B.w, B.h);

    // hovered tile
    if (this.hovered && this.hovered.alive) {
      const { x, y } = isoToScreen(this.hovered.gx, this.hovered.gy);
      ctx.fillStyle = "rgba(255,255,200,.18)";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + TILE_W / 2, y + TILE_H / 2);
      ctx.lineTo(x, y + TILE_H);
      ctx.lineTo(x - TILE_W / 2, y + TILE_H / 2);
      ctx.fill();
    }

    // depth-sorted scene
    const list = [];
    for (let t of g.cTrees) list.push({ d: t.gx + t.gy + 0.2, k: 0, o: t });
    for (let f of this.falls) list.push({ d: (f.x / (TILE_W / 2) + f.y / (TILE_H / 2)) / 2 - 0.8, k: 1, o: f });
    for (let w of g.workers) {
      const p = this.smoothWorker(w);
      list.push({ d: (p.x / (TILE_W / 2) + p.y / (TILE_H / 2)) / 2 - 0.5, k: 2, o: w, p });
    }
    for (let b of BUILDINGS) if (buildingVisible(g, b)) list.push({ d: b.pos.gx + b.pos.gy, k: 3, o: b });
    list.sort((a, b) => a.d - b.d);
    for (let e of list) {
      if (e.k === 0) this.drawTreeEntity(e.o, density);
      else if (e.k === 1) this.drawFall(e.o, density);
      else if (e.k === 2) this.drawWorker(e.o, e.p);
      else this.drawBuilding(e.o);
    }

    // leaves & particles
    for (let l of this.leaves) {
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.r);
      ctx.globalAlpha = Math.min(1, l.life * 2);
      ctx.fillStyle = l.c;
      ctx.fillRect(-l.s / 2, -l.s / 4, l.s, l.s / 2);
      ctx.restore();
    }
    for (let p of this.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;

    // lighting: multiply an ambient tint, then add light sources
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sky.tint !== "#ffffff") {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = sky.tint;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }
    if (sky.dark > 0.1) this.drawLights(sky.dark, ox, oy, z);

    // weather (screen space)
    for (let w of this.weather) {
      if (w.k === "rain") {
        ctx.strokeStyle = "rgba(160,190,255,.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w.x, w.y);
        ctx.lineTo(w.x + w.vx * 0.02, w.y + 14);
        ctx.stroke();
      } else if (w.k === "snow") {
        ctx.fillStyle = "rgba(255,255,255,.8)";
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.s, 0, 6.28);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(220,255,140,${0.5 + 0.5 * Math.sin(this.time * 5 + w.ph)})`;
        ctx.beginPath();
        ctx.arc(w.x, w.y, 1.6, 0, 6.28);
        ctx.fill();
      }
    }

    // floating text on top, unaffected by lighting
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (let f of this.floats) {
      const p = this.worldToScreen(f.x, f.y - f.t * 46);
      const a = f.t < 0.7 ? 1 : 1 - (f.t - 0.7) / 0.4;
      const s = f.size * (1 + Math.min(f.t * 4, 1) * 0.15);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.font = `700 ${s}px system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,.65)";
      ctx.strokeText(f.text, p.x, p.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    // boss label
    const boss = g.cTrees.find((t) => t.alive && t.mutation === "boss");
    if (boss) {
      const bt = BOSS_TYPES[boss.boss] || BOSS_TYPES[0];
      const p0 = isoToScreen(boss.gx + 0.5, boss.gy + 0.5);
      const p = this.worldToScreen(p0.x, p0.y - treeBox(boss.tier).ay * boss.sc - 14);
      const bw = 90;
      ctx.fillStyle = "rgba(0,0,0,.6)";
      ctx.fillRect(p.x - bw / 2 - 2, p.y - 2, bw + 4, 9);
      ctx.fillStyle = "#e04040";
      ctx.fillRect(p.x - bw / 2, p.y, bw * clamp(boss.hp / boss.maxHp, 0, 1), 5);
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillStyle = "#ffb0a0";
      ctx.strokeStyle = "rgba(0,0,0,.7)";
      ctx.lineWidth = 3;
      ctx.strokeText(`💀 ${bt.name}`, p.x, p.y - 5);
      ctx.fillText(`💀 ${bt.name}`, p.x, p.y - 5);
    }
  }

  smoothWorker(w) {
    const target = isoToScreen(w.gx + 0.5, w.gy + 0.5);
    let p = this.workerPos.get(w);
    if (!p) {
      p = { x: target.x, y: target.y, face: 1 };
      this.workerPos.set(w, p);
    }
    const k = 1 - Math.exp(-this.frameDt * 7);
    const nx = lerp(p.x, target.x, k);
    if (Math.abs(nx - p.x) > 0.05) p.face = nx > p.x ? 1 : -1;
    p.x = nx;
    p.y = lerp(p.y, target.y, k);
    if (w.target && (w.state === "chop" || w.state === "tend")) {
      const tp = isoToScreen(w.target.gx + 0.5, w.target.gy + 0.5);
      p.face = tp.x >= p.x ? 1 : -1;
    }
    return p;
  }

  drawTreeEntity(t, density) {
    const ctx = this.ctx;
    const { x, y } = isoToScreen(t.gx + 0.5, t.gy + 0.5);
    if (!t.alive) return this.drawStump(t, x, y, density);
    const a = this.anim.get(t) || { wb: 0, grow: 1 };
    const sc = (t.sc || 1) * (0.3 + 0.7 * easeOutBack(a.grow));
    const sway = this.settings.effects === "low" ? 0 : Math.sin(this.time * 1.4 + t.gx * 1.7 + t.gy) * 0.035;
    const wob = Math.sin(this.time * 38) * a.wb * 3;
    const spr = treeSprite(t.tier, this.variantOf(t), density * sc);
    const box = spr.box;
    // shadow
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.ellipse(x + 3 * sc, y + 2, box.w * 0.3 * sc, box.w * 0.13 * sc, 0, 0, 6.28);
    ctx.fill();
    // aura behind mutated / high-tier trees
    const aura =
      t.mutation === "golden" ? "255,215,0" : t.mutation === "ancient" ? "150,60,255" : t.mutation === "boss" ? "255,50,40" : t.tier === 5 ? "255,170,40" : t.tier === 4 ? "180,80,255" : null;
    if (aura) {
      const pulse = 0.25 + Math.sin(this.time * 3 + t.gx) * 0.12;
      const cy = y - box.ay * sc * 0.6,
        r = box.w * 0.6 * sc;
      const gr = ctx.createRadialGradient(x, cy, 0, x, cy, r);
      gr.addColorStop(0, `rgba(${aura},${pulse + (t.mutation ? 0.15 : 0)})`);
      gr.addColorStop(1, `rgba(${aura},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, 6.28);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(x + wob, y);
    ctx.transform(1, 0, -sway, 1, 0, 0);
    ctx.scale(sc, sc);
    ctx.drawImage(spr.img, -box.ax, -box.ay, box.w, box.h);
    if (t.mutation === "golden" || t.mutation === "ancient") {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.18 + Math.sin(this.time * 4) * 0.08;
      ctx.drawImage(spr.img, -box.ax, -box.ay, box.w, box.h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
    if (t.mutation === "golden" && Math.random() < this.frameDt * 4 && this.settings.effects !== "low")
      this.addParticle(x + rand(-14, 14) * sc, y - rand(20, box.ay) * sc, 0, -20, "#ffe680", 2, 0.8, 0);
    // hover ring + HP bar
    if (this.hovered === t) {
      ctx.strokeStyle = "rgba(255,255,200,.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y + 1, box.w * 0.34 * sc, box.w * 0.15 * sc, 0, 0, 6.28);
      ctx.stroke();
    }
    const hp = t.hp / t.maxHp;
    if (hp < 1 && hp > 0 && t.mutation !== "boss") {
      const bw = 26,
        by = y - box.ay * sc - 6;
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(x - bw / 2 - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = hp > 0.5 ? "#6de06d" : hp > 0.25 ? "#e0c04d" : "#e05050";
      ctx.fillRect(x - bw / 2, by, bw * hp, 3);
    }
  }

  drawStump(t, x, y, density) {
    const ctx = this.ctx,
      T = TREE_TYPES[t.tier],
      s = t.sc || 1;
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.beginPath();
    ctx.ellipse(x + 1, y + 1, 7 * s, 3 * s, 0, 0, 6.28);
    ctx.fill();
    ctx.fillStyle = T.tr;
    ctx.fillRect(x - 3.5 * s, y - 5 * s, 7 * s, 5 * s);
    ctx.fillStyle = "#c8a070";
    ctx.beginPath();
    ctx.ellipse(x, y - 5 * s, 3.5 * s, 1.6 * s, 0, 0, 6.28);
    ctx.fill();
    const rp = clamp(1 - t.rt / T.rg, 0, 1);
    if (rp > 0.25) {
      const k = (rp - 0.25) / 0.75;
      const spr = treeSprite(t.tier, this.variantOf(t), density * 0.4);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.65 * k;
      ctx.translate(x + 5 * s, y);
      ctx.scale(0.12 + 0.28 * k, 0.12 + 0.28 * k);
      ctx.drawImage(spr.img, -spr.box.ax, -spr.box.ay, spr.box.w, spr.box.h);
      ctx.restore();
    }
  }

  drawFall(f, density) {
    const ctx = this.ctx;
    const spr = treeSprite(f.tier, f.v, density * f.sc);
    const k = f.t / 0.9;
    ctx.save();
    ctx.globalAlpha = clamp(1.4 - k * 1.4, 0, 1);
    ctx.translate(f.x, f.y);
    ctx.rotate(f.dir * Math.min(1.45, 1.45 * easeInQuad(Math.min(1, k * 1.5))));
    ctx.scale(f.sc, f.sc);
    ctx.drawImage(spr.img, -spr.box.ax, -spr.box.ay, spr.box.w, spr.box.h);
    ctx.restore();
  }

  drawWorker(w, p) {
    const ctx = this.ctx,
      t = this.time;
    const moving = w.state === "walk";
    const bob = moving ? Math.abs(Math.sin(t * 10 + w.speed * 7)) * 1.8 : Math.sin(t * 2 + w.speed * 10) * 0.5;
    const shirt = w.type === "merchant" ? "#4a6aa8" : w.type === "planter" ? "#4a8a4a" : "#b8483a";
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.beginPath();
    ctx.ellipse(0, 1, 6, 2.6, 0, 0, 6.28);
    ctx.fill();
    ctx.scale(p.face, 1);
    // legs
    const step = moving ? Math.sin(t * 10 + w.speed * 7) * 2 : 0;
    ctx.fillStyle = "#3a3040";
    ctx.fillRect(-2.5 + step * 0.5, -5, 2, 5);
    ctx.fillRect(0.5 - step * 0.5, -5, 2, 5);
    // body
    ctx.fillStyle = shirt;
    ctx.fillRect(-3.5, -12 - bob, 7, 8);
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fillRect(-3.5, -12 - bob, 3, 8);
    // head + hat
    ctx.fillStyle = "#f0c8a0";
    ctx.beginPath();
    ctx.arc(0, -15 - bob, 3.4, 0, 6.28);
    ctx.fill();
    ctx.fillStyle = w.type === "planter" ? "#c8b060" : "#6a4a2a";
    ctx.fillRect(-4, -19 - bob, 8, 2);
    ctx.fillRect(-2.5, -21 - bob, 5, 2);
    // tool
    if (w.type === "chopper") {
      const swing = w.state === "chop" ? Math.sin(t * 14 + w.power * 5) : 0.2;
      ctx.save();
      ctx.translate(3, -10 - bob);
      ctx.rotate(-0.9 + swing * 0.9);
      ctx.fillStyle = "#7a5a3a";
      ctx.fillRect(-0.8, -9, 1.6, 10);
      ctx.fillStyle = this.game.axeCosmetic.color;
      ctx.fillRect(-0.5, -10, 4, 3);
      ctx.restore();
    } else if (w.type === "merchant") {
      ctx.fillStyle = "#b09060";
      ctx.beginPath();
      ctx.arc(4.5, -8 - bob, 3, 0, 6.28);
      ctx.fill();
      if (w.state === "sell" && Math.sin(t * 3 + w.speed * 4) > 0.95 && this.game.planks >= 2)
        this.addFloat(p.x, p.y - 26, "🪙", "#ffd700", 10);
    } else {
      const dig = w.state === "tend" ? Math.sin(t * 8 + w.speed) * 2 : 0;
      ctx.fillStyle = "#8a8a8a";
      ctx.fillRect(3, -9 - bob + dig, 1.5, 8);
      ctx.fillStyle = "#5aa04a";
      ctx.fillRect(2, -1 - bob + dig, 3.5, 2);
    }
    ctx.restore();
  }

  drawBuilding(b) {
    const ctx = this.ctx;
    const { x, y } = isoToScreen(b.pos.gx, b.pos.gy);
    const w = 20,
      h = 18,
      c = b.color;
    // right face, left face, then roof
    ctx.fillStyle = shadeC(c, -30);
    ctx.beginPath();
    ctx.moveTo(x, y + w / 2);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y - h);
    ctx.lineTo(x, y + w / 2 - h);
    ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x, y + w / 2);
    ctx.lineTo(x - w, y);
    ctx.lineTo(x - w, y - h);
    ctx.lineTo(x, y + w / 2 - h);
    ctx.fill();
    // door + window
    ctx.fillStyle = "#3a2618";
    ctx.beginPath();
    ctx.moveTo(x - 12, y + 4);
    ctx.lineTo(x - 7, y + 6.5);
    ctx.lineTo(x - 7, y - 3.5);
    ctx.lineTo(x - 12, y - 6);
    ctx.fill();
    ctx.fillStyle = "#ffd98a";
    ctx.fillRect(x + 7, y - 10, 5, 4);
    // roof
    const roof = shadeC(c, 30);
    ctx.fillStyle = shadeC(roof, -25);
    ctx.beginPath();
    ctx.moveTo(x - w - 3, y - h);
    ctx.lineTo(x, y + w / 2 - h + 3);
    ctx.lineTo(x, y - h - 14);
    ctx.lineTo(x - w / 2 - 2, y - h - 20);
    ctx.fill();
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(x + w + 3, y - h);
    ctx.lineTo(x, y + w / 2 - h + 3);
    ctx.lineTo(x, y - h - 14);
    ctx.lineTo(x + w / 2 + 2, y - h - 20);
    ctx.fill();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(b.icon, x, y - h - 22);
    // chimney smoke from sawmill/kiln
    if ((b.name === "Kiln" || b.name === "Sawmill") && Math.random() < this.frameDt * 3 && this.settings.effects !== "low")
      this.addParticle(x + 8, y - h - 18, rand(-5, 5), -25, "rgba(200,200,200,.5)", rand(3, 5), 2.2, -4);
  }

  drawLights(dark, ox, oy, z) {
    const ctx = this.ctx,
      g = this.game;
    ctx.globalCompositeOperation = "lighter";
    const glow = (wx, wy, r, rgb, a) => {
      const sx = ox + wx * z,
        sy = oy + wy * z,
        rr = r * z;
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr);
      gr.addColorStop(0, `rgba(${rgb},${a})`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = gr;
      ctx.fillRect(sx - rr, sy - rr, rr * 2, rr * 2);
    };
    for (let b of BUILDINGS)
      if (buildingVisible(g, b)) {
        const { x, y } = isoToScreen(b.pos.gx, b.pos.gy);
        glow(x + 6, y - 8, 46, "255,190,90", 0.5 * dark);
      }
    for (let t of g.cTrees) {
      if (!t.alive) continue;
      const p = isoToScreen(t.gx + 0.5, t.gy + 0.5);
      const cy = p.y - treeBox(t.tier).ay * 0.55 * (t.sc || 1);
      if (t.mutation === "golden") glow(p.x, cy, 40, "255,210,80", 0.45 * dark);
      else if (t.mutation === "ancient" || t.tier === 4) glow(p.x, cy, 36, "190,90,255", 0.35 * dark);
      else if (t.tier === 5) glow(p.x, cy, 50, "255,180,60", 0.35 * dark);
      else if (t.mutation === "boss") glow(p.x, cy, 60, "255,60,40", 0.45 * dark);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}

function easeOutBack(x) {
  const c1 = 1.70158,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function easeInQuad(x) {
  return x * x;
}
