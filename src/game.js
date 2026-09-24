// Pure simulation: no DOM or canvas access, so it runs in tests and in offline catch-up.
// Anything visual/audible is announced through `emit()` and handled by the renderer/UI.
import {
  SAVE_VERSION,
  GRID,
  BIOMES,
  TREE_TYPES,
  WEATHER_SEASONS,
  BUILDINGS,
  UPGRADES,
  TECH_TREE,
  AMBER_SHOP,
  EPOCH_PERKS,
  W_NAMES,
  W_TITLES,
  ACHIEVEMENTS,
  QUEST_POOL,
  EVENTS,
  ASCENSION_TREE,
  CONTRACTS_POOL,
  DEMAND_RESOURCES,
  BOSS_TYPES,
  AXE_COSMETICS,
} from "./data.js";
import { rand, pick, softCost, fmt } from "./util.js";
import { migrateSave, compactTree } from "./save.js";

export const SIM_DT = 0.05; // fixed simulation step (20 Hz)
export const OFFLINE_CAP = 8 * 3600;
export const OFFLINE_CAP_NETWORK = 24 * 3600;
export const OFFLINE_EFFICIENCY = 0.5;
const TRADE_ROUTE_COST = 50000;
const MARKET_TILE = { gx: 0, gy: GRID - 1 };

const BUILDING_TILES = new Set(BUILDINGS.map((b) => `${Math.floor(b.pos.gx)},${Math.floor(b.pos.gy)}`));
/** Random tile in [lo, hi) that isn't reserved for a building. */
function freeTile(lo = 0, hi = GRID) {
  for (;;) {
    let gx = Math.floor(rand(lo, hi)),
      gy = Math.floor(rand(lo, hi));
    if (!BUILDING_TILES.has(`${gx},${gy}`)) return { gx, gy };
  }
}

const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

export class Game {
  constructor() {
    this.listeners = [];
    this.resetAll();
  }

  // ---------------------------------------------------------------- events
  on(fn) {
    this.listeners.push(fn);
  }
  emit(type, data) {
    if (this.silent) return;
    for (const fn of this.listeners) fn(type, data);
  }
  notify(msg) {
    this.emit("notify", msg);
  }
  shopChanged() {
    this.emit("shop");
  }

  // ---------------------------------------------------------------- state
  resetAll() {
    this.logs = 0;
    this.planks = 0;
    this.gold = 0;
    this.charcoal = 0;
    this.furniture = 0;
    this.luxury = 0;
    this.amber = 0;
    this.totalLogs = 0;
    this.season = 1;
    this.seasonBonus = 0;
    this.era = 1;
    this.epoch = 1;
    this.epochPoints = 0;
    this.epochPerks = {};
    for (let ep of EPOCH_PERKS) this.epochPerks[ep.id] = false;
    this.upgrades = {};
    for (let k in UPGRADES) this.upgrades[k] = 0;
    this.techs = {};
    for (let k in TECH_TREE) this.techs[k] = false;
    this.amberPerks = {};
    for (let p of AMBER_SHOP) this.amberPerks[p.id] = 0;
    this.ascensionPerks = {};
    for (let n of ASCENSION_TREE) this.ascensionPerks[n.id] = false;
    this.achievementsEarned = [];
    this._ab = null;
    this.stats = {
      treesChopped: 0,
      totalGold: 0,
      heartwoodChopped: 0,
      worldtreeChopped: 0,
      furnitureMade: 0,
      crits: 0,
      totalPlayTime: 0,
      questsCompleted: 0,
      totalAmber: 0,
      eventsTriggered: 0,
      luxuryMade: 0,
      exportsCompleted: 0,
      bossesDefeated: 0,
      goldenChopped: 0,
      ancientChopped: 0,
      contractsCompleted: 0,
    };
    this.currentZone = 0;
    this.unlockedZones = [0];
    this.zones = [];
    for (let i = 0; i < BIOMES.length; i++) this.zones.push(this.genZone(i));
    this.workers = [];
    this.timers = {};
    this.dayTime = 0.25;
    this.rateTracker = { logs: 0, planks: 0, gold: 0, timer: 0, lr: 0, pr: 0, gr: 0 };
    this.weatherSeason = 0;
    this.weatherTimer = 0;
    this.quests = [];
    this.rollQuests();
    this.activeEvent = null;
    this.nextEventIn = rand(60, 180);
    this.demand = {};
    for (let r of DEMAND_RESOURCES) this.demand[r] = rand(0.5, 2);
    this.demandTimer = 0;
    this.nextDemandIn = rand(60, 90);
    this.contracts = [];
    this.rollContracts();
    this.tradeRoutes = [];
    this.bossTimer = 0;
    this.nextBoss = rand(180, 300);
    this.mutationStats = { golden: 0, ancient: 0, bossesDefeated: 0 };
    this.cosmetics = { axe: "default", theme: "default" };
    this.applyStartPerks();
  }

  /** Ascension perks (bought in the Amber tab) and legacy amberPerks levels share ids. */
  perk(id) {
    return Math.max(this.amberPerks[id] || 0, this.ascensionPerks[id] ? 1 : 0);
  }

  applyStartPerks() {
    let hs = this.perk("headStart");
    if (hs > 0) this.gold += hs * 500;
    let dp = this.perk("deepPockets");
    if (dp > 0) this.upgrades.sawmill = Math.max(this.upgrades.sawmill, Math.min(dp, UPGRADES.sawmill.max));
  }

  // ---------------------------------------------------------------- derived stats
  get curWeather() {
    return WEATHER_SEASONS[this.weatherSeason];
  }
  treeHpScale() {
    return 1 + (this.season - 1) * 0.3 + (this.era - 1) * 0.8;
  }
  get chopPower() {
    let p = 1 + this.upgrades.axe + this.seasonBonus + this.perk("keenEdge") * 5 + this.aB("chop");
    if (this.techs.goldenAxe) p *= 3;
    if (this.epochPerks.cosmicAxe) p *= 10;
    return Math.floor(p);
  }
  get critChance() {
    let c = this.upgrades.enchant * 0.05 + (this.techs.magicSap ? 0.15 : 0) + this.perk("luckCharm") * 0.03 + this.aB("crit");
    if (this.activeEvent && this.activeEvent.effect === "critBoost") c = 1;
    return Math.min(c, 1);
  }
  get critMultiplier() {
    let m = 2 + (this.upgrades.critDmg || 0) * 0.5;
    if (this.epochPerks.voidTouch) m *= 2.5; // x5 at base, still benefits from Critical Force
    return m;
  }
  get doubleStrikeChance() {
    return Math.min(1, (this.upgrades.doubleChop || 0) * 0.1);
  }
  /** Epoch perk Time Warp: "All production 2x speed". */
  get speedMul() {
    return this.epochPerks.timeWarp ? 2 : 1;
  }
  get regrowSpeed() {
    let s = 1 + this.upgrades.replant * 0.2 + this.perk("natureBond") * 0.2;
    s *= this.curWeather.regrowMul;
    s += this.upgrades.planter * 0.15;
    s += (this.upgrades.regrowBoost || 0) * 0.25;
    return s * this.speedMul;
  }
  get maxTreeTier() {
    let t = Math.min(5, Math.floor(this.upgrades.explore));
    if (!this.techs.worldTreeSeed && t > 4) t = 4;
    return t;
  }
  get yieldMul() {
    let m = 1 + this.seasonBonus * 0.4;
    if (this.techs.deepRoots) m *= 1.5;
    if (this.techs.lumberEmpire) m *= 2;
    m *= 1 + this.aB("yield") + this.aB("all");
    if (this.activeEvent && this.activeEvent.effect === "yieldx2") m *= 2;
    m *= this.curWeather.treeMul;
    m *= 1 + (this.upgrades.logMulti || 0) * 0.2;
    return m;
  }
  get goldMul() {
    let m = 1;
    if (this.techs.lumberEmpire) m *= 2;
    m *= 1 + this.perk("goldenTouch") * 0.15;
    m *= 1 + this.aB("gold") + this.aB("all");
    if (this.activeEvent && this.activeEvent.effect === "goldx3") m *= 3;
    m *= this.curWeather.goldMul;
    m *= 1 + (this.upgrades.goldMulti || 0) * 0.15;
    return m;
  }
  get workerMul() {
    let m = 1 + this.aB("worker") + this.aB("all");
    if (this.techs.ancientKnow) m *= 2;
    return m * this.speedMul;
  }
  get amberPerSeason() {
    let base = 1 + this.season * 0.5;
    base += Math.floor(Math.log10(Math.max(1, this.stats.totalGold)));
    base += this.perk("amberMagnet");
    base += this.aB("amber");
    if (this.techs.eternityForge) base *= 2;
    if (this.epochPerks.starForge) base *= 5;
    base *= 1 + this.season * 0.1;
    return Math.floor(base);
  }
  /** Sum of achievement bonuses of a type ("chop", "yield", ...). Cached; invalidated when one is earned. */
  aB(type) {
    if (!this._ab) {
      this._ab = {};
      for (let id of this.achievementsEarned) {
        let a = ACH_BY_ID[id];
        if (!a) continue;
        let [k, raw] = a.bonus.split("+");
        let v = parseFloat(raw);
        this._ab[k] = (this._ab[k] || 0) + (raw.includes("%") ? v / 100 : v);
      }
    }
    return this._ab[type] || 0;
  }
  get axeCosmetic() {
    return AXE_COSMETICS.find((a) => a.id === this.cosmetics.axe) || AXE_COSMETICS[0];
  }

  // ---------------------------------------------------------------- zones & trees
  makeTree(gx, gy, tier, extra = {}) {
    let hp = Math.ceil(TREE_TYPES[tier].hp * this.treeHpScale() * (extra.hpMul || 1));
    let t = { gx, gy, tier, hp, maxHp: hp, alive: true, rt: 0, sc: extra.sc || rand(0.8, 1.15) };
    if (extra.mutation) t.mutation = extra.mutation;
    if (extra.ym) t.ym = extra.ym;
    return t;
  }
  genZone(bi) {
    let biome = BIOMES[bi],
      trees = [];
    for (let gx = 0; gx < GRID; gx++)
      for (let gy = 0; gy < GRID; gy++)
        if (!BUILDING_TILES.has(`${gx},${gy}`) && Math.random() < 0.6) trees.push(this.makeTree(gx, gy, this.pickTier(biome.tw)));
    return { bi, trees };
  }
  /** Puts a tree on a tile, replacing whatever stood there (keeps one tree per tile). */
  placeTree(zone, tree) {
    let i = zone.trees.findIndex((t) => t.gx === tree.gx && t.gy === tree.gy);
    if (i >= 0) {
      for (let w of this.workers) if (w.target === zone.trees[i]) w.target = null;
      zone.trees[i] = tree;
    } else zone.trees.push(tree);
    return tree;
  }
  pickTier(w) {
    let t = w.reduce((a, b) => a + b, 0),
      r = Math.random() * t,
      a = 0;
    for (let i = 0; i < w.length; i++) {
      a += w[i];
      if (r < a) return Math.min(i, this.maxTreeTier);
    }
    return 0;
  }
  get cZone() {
    return this.zones[this.currentZone];
  }
  get cTrees() {
    return this.cZone.trees;
  }
  get cBiome() {
    return BIOMES[this.cZone.bi];
  }
  get boss() {
    for (let z of this.zones) for (let t of z.trees) if (t.mutation === "boss" && t.alive) return t;
    return null;
  }
  switchZone(i) {
    if (!this.unlockedZones.includes(i) || i === this.currentZone) return;
    this.currentZone = i;
    this.clearWorkerTargets();
    this.emit("zone");
  }
  unlockZone(i) {
    let c = BIOMES[i].cost;
    if (this.gold < c || this.unlockedZones.includes(i)) return;
    this.gold -= c;
    this.unlockedZones.push(i);
    this.currentZone = i;
    this.clearWorkerTargets();
    this.notify(`🗺️ ${BIOMES[i].name}!`);
    this.emit("zone");
    this.shopChanged();
  }
  clearWorkerTargets() {
    for (let w of this.workers) w.target = null;
  }

  // ---------------------------------------------------------------- chopping
  chopTree(tree, manual = false, damage = null) {
    if (!tree || !tree.alive) return;
    let pw = damage ?? this.chopPower,
      crit = damage === null && Math.random() < this.critChance;
    if (crit) {
      pw *= this.critMultiplier;
      pw = Math.floor(pw);
      this.stats.crits++;
      this.track("critsLanded", 1);
    }
    tree.hp -= pw;
    this.emit("hit", { tree, dmg: pw, crit, manual });
    if (tree.hp <= 0) this.fellTree(tree, crit, manual);
    else if (damage === null && Math.random() < this.doubleStrikeChance) this.chopTree(tree, manual, this.chopPower);
  }
  fellTree(tree, crit, manual) {
    tree.alive = false;
    let T = TREE_TYPES[tree.tier];
    let ym = tree.ym || (tree.mutation === "golden" ? 5 : tree.mutation === "ancient" ? 10 : 1);
    let logs = Math.ceil(T.y * this.yieldMul * ym * (crit ? 2 : 1));
    if (Math.random() < 0.02 + (this.upgrades.luckyDrop || 0) * 0.02) logs += Math.ceil(T.y * this.yieldMul * 0.5);
    if (this.epochPerks.soulHarvest && Math.random() < 0.1) this.gainAmber(1);
    this.gainLogs(logs);
    this.stats.treesChopped++;
    this.track("anyChopped", 1);
    this.track("treesChopped", 1);
    if (tree.tier === 0) this.track("pineChopped", 1);
    if (tree.tier === 1) this.track("oakChopped", 1);
    if (tree.tier === 3) {
      this.track("ironChopped", 1);
      this.track("ironwoodChopped", 1);
    }
    if (tree.tier === 4) {
      this.stats.heartwoodChopped++;
      this.track("heartwoodChop", 1);
    }
    if (tree.tier === 5) this.stats.worldtreeChopped++;
    if (tree.mutation === "golden") this.stats.goldenChopped++;
    if (tree.mutation === "ancient") {
      this.stats.ancientChopped++;
      if (this.perk("ancientHunter")) this.gainAmber(1);
    }
    this.emit("fell", { tree, logs, crit, manual });
    if (tree.mutation === "boss") this.defeatBoss(tree);
    tree.rt = T.rg;
    delete tree.ym;
    delete tree.mutation;
  }
  chopRandom() {
    let alive = this.cTrees.filter((t) => t.alive);
    if (alive.length) this.chopTree(pick(alive), false);
  }

  // ---------------------------------------------------------------- economy helpers
  gainLogs(n) {
    this.logs += n;
    this.totalLogs += n;
    this.rateTracker.logs += n;
    this.track("totalLogs", n);
  }
  gainGold(g) {
    if (g <= 0) return;
    this.gold += g;
    this.stats.totalGold += g;
    this.rateTracker.gold += g;
    this.track("goldEarned", g);
  }
  gainAmber(n) {
    this.amber += n;
    this.stats.totalAmber += n;
  }
  /** Progress quests and contracts that watch `stat`. */
  track(stat, amt) {
    for (let q of this.quests) if (q.stat === stat && q.progress < q.target) {
      q.progress = Math.min(q.target, q.progress + amt);
      if (q.progress >= q.target) this.completeQuest(q);
    }
    for (let c of this.contracts) if (c.stat === stat && c.progress < c.target) {
      c.progress = Math.min(c.target, c.progress + amt);
      if (c.progress >= c.target) this.completeContract(c);
    }
  }
  sellPrice(res) {
    const base = { logs: 1, planks: 4, charcoal: 7, furniture: 25 * (1 + this.aB("furn")), luxury: 100 }[res];
    return base * this.goldMul * (this.demand[res] || 1);
  }
  sell(res, amount = this[res]) {
    amount = Math.floor(Math.min(amount, this[res]));
    if (amount <= 0) return 0;
    let g = Math.floor(amount * this.sellPrice(res));
    this[res] -= amount;
    this.gainGold(g);
    if (res === "logs") this.track("logsSold", amount);
    return g;
  }
  sellAll(res) {
    let n = Math.floor(this[res]);
    let g = this.sell(res);
    if (g > 0) {
      this.notify(`Sold ${fmt(n)} ${res} → ${fmt(g)} 🪙`);
      this.emit("sale", { gold: g });
    }
  }

  // ---------------------------------------------------------------- shop
  maxLevel(k) {
    return this.epochPerks.infiniteGrowth ? Infinity : UPGRADES[k].max;
  }
  uCost(k) {
    return softCost(UPGRADES[k].base, UPGRADES[k].mul, this.upgrades[k]);
  }
  canBuy(k) {
    return this.upgrades[k] < this.maxLevel(k) && this.gold >= this.uCost(k);
  }
  buyUpgrade(k) {
    if (!this.canBuy(k)) return false;
    this.gold -= this.uCost(k);
    this.upgrades[k]++;
    if (k === "explore") {
      let tier = this.maxTreeTier;
      this.notify(`🗺️ Discovered: ${TREE_TYPES[tier].name}!`);
      for (let z of this.zones)
        for (let i = 0; i < 3; i++) {
          let p = freeTile();
          this.placeTree(z, this.makeTree(p.gx, p.gy, tier));
        }
    }
    this.emit("buy", { k });
    this.shopChanged();
    return true;
  }
  techCost(k) {
    let c = TECH_TREE[k].cost * (1 - this.perk("quickStudy") * 0.1);
    if (this.epochPerks.eternalWisdom) c *= 0.5;
    return Math.floor(c);
  }
  canResearch(k) {
    let t = TECH_TREE[k];
    if (this.techs[k]) return false;
    for (let r of t.req) if (!this.techs[r]) return false;
    return this.gold >= this.techCost(k);
  }
  research(k) {
    if (!this.canResearch(k)) return false;
    this.gold -= this.techCost(k);
    this.techs[k] = true;
    this.notify(`🔬 ${TECH_TREE[k].name}!`);
    this.emit("buy", { k });
    this.shopChanged();
    return true;
  }
  canBuyAscension(id) {
    let n = ASCENSION_TREE.find((x) => x.id === id);
    if (!n || this.ascensionPerks[id]) return false;
    if (this.amber < n.cost) return false;
    for (let req of n.req) if (!this.ascensionPerks[req]) return false;
    return true;
  }
  buyAscension(id) {
    if (!this.canBuyAscension(id)) return false;
    let n = ASCENSION_TREE.find((x) => x.id === id);
    this.amber -= n.cost;
    this.ascensionPerks[id] = true;
    this.notify(`⬆️ ${n.name}!`);
    this.emit("buy", { k: id });
    this.shopChanged();
    return true;
  }
  buyEpochPerk(id) {
    let ep = EPOCH_PERKS.find((x) => x.id === id);
    if (!ep || this.epochPerks[id] || this.epochPoints < ep.cost) return false;
    this.epochPoints -= ep.cost;
    this.epochPerks[id] = true;
    this.notify(`✨ ${ep.name}!`);
    this.emit("buy", { k: id });
    this.shopChanged();
    return true;
  }
  equipAxe(id) {
    let ax = AXE_COSMETICS.find((a) => a.id === id);
    if (!ax || this.era < ax.era) return;
    this.cosmetics.axe = id;
    this.shopChanged();
  }

  // ---------------------------------------------------------------- workers
  workerCost() {
    return Math.floor(100 * Math.pow(1.4, this.workers.length));
  }
  hireWorker() {
    let c = this.workerCost();
    if (this.gold < c) return false;
    this.gold -= c;
    let type = Math.random() < 0.6 ? "chopper" : Math.random() < 0.5 ? "merchant" : "planter";
    this.workers.push({
      name: pick(W_NAMES) + " " + pick(W_TITLES),
      type,
      speed: rand(0.6, 1.4),
      power: rand(0.5, 1.5),
      carry: rand(0.8, 1.2),
      gx: Math.floor(rand(0, GRID)),
      gy: Math.floor(rand(0, GRID)),
      target: null,
      mt: 0,
      ct: 0,
      state: "idle",
    });
    this.emit("buy", { k: "worker" });
    this.shopChanged();
    return true;
  }
  nearest(w, list) {
    let best = null,
      bd = Infinity;
    for (let t of list) {
      let d = (t.gx - w.gx) ** 2 + (t.gy - w.gy) ** 2 + rand(0, 6);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }
  /** Walk one tile per 0.4 "move units"; loops so large offline steps still cover ground. Returns true on arrival. */
  walk(w, tx, ty, dt, sm, reach) {
    let dist = () => Math.abs(tx - w.gx) + Math.abs(ty - w.gy);
    if (dist() <= reach) return true;
    w.state = "walk";
    w.mt += dt * sm * 2;
    while (w.mt >= 0.4 && dist() > reach) {
      w.mt -= 0.4;
      let dx = tx - w.gx,
        dy = ty - w.gy;
      if (Math.abs(dx) > Math.abs(dy)) w.gx += Math.sign(dx);
      else w.gy += Math.sign(dy);
    }
    if (dist() <= reach) {
      w.mt = 0;
      return true;
    }
    return false;
  }
  updateWorkers(dt) {
    let alive = null,
      stumps = null;
    for (let w of this.workers) {
      let sm = w.speed * this.workerMul;
      if (w.type === "merchant") {
        // walk to the market and sell planks there
        if (!this.walk(w, MARKET_TILE.gx, MARKET_TILE.gy, dt, sm, 0)) continue;
        w.state = "sell";
        w.ct += dt * sm;
        let iv = 2;
        let n = Math.floor(w.ct / iv);
        w.ct -= n * iv;
        let k = Math.min(n, Math.floor(this.planks / 2));
        if (k > 0) {
          this.planks -= 2 * k;
          this.gainGold(k * Math.floor(10 * this.goldMul));
        } else if (n > 0) w.state = "idle";
        continue;
      }
      if (w.type === "planter") {
        // tend the nearest stump so it regrows faster
        if (!w.target || w.target.alive || w.target.rt <= 0) {
          stumps ??= this.cTrees.filter((t) => !t.alive && t.rt > 0);
          w.target = stumps.length ? this.nearest(w, stumps) : null;
          if (!w.target) {
            w.state = "idle";
            continue;
          }
        }
        let t = w.target;
        if (!this.walk(w, t.gx, t.gy, dt, sm, 1)) continue;
        w.state = "tend";
        t.rt -= dt * sm * 1.5;
        continue;
      }
      if (!w.target || !w.target.alive) {
        alive ??= this.cTrees.filter((t) => t.alive);
        w.target = alive.length ? this.nearest(w, alive) : null;
        if (!w.target) {
          w.state = "idle";
          continue;
        }
      }
      let t = w.target;
      if (!this.walk(w, t.gx, t.gy, dt, sm, 1)) continue;
      w.state = "chop";
      w.ct += dt * sm;
      let iv = 1 / w.power;
      while (w.ct >= iv && t.alive) {
        w.ct -= iv;
        this.chopTree(t, false);
      }
      if (!t.alive) {
        w.ct = Math.min(w.ct, iv);
        alive = null;
      }
    }
  }

  // ---------------------------------------------------------------- prestige layers
  prestigeReq() {
    return Math.floor(1000 * Math.pow(2.5, this.season - 1));
  }
  canPrestige() {
    return this.totalLogs >= this.prestigeReq();
  }
  canEra() {
    return this.season >= 5 + (this.era - 1) * 3;
  }
  canEpoch() {
    return this.era >= 5 + (this.epoch - 1) * 3;
  }
  resetRun({ keepWorkers = 0, keepZones = 0, techs = false }) {
    this.logs = this.planks = this.gold = this.charcoal = this.furniture = this.luxury = 0;
    this.totalLogs = 0;
    for (let k in this.upgrades) this.upgrades[k] = 0;
    if (techs) for (let k in this.techs) this.techs[k] = false;
    this.workers = this.workers.slice(0, keepWorkers);
    let kept = [0];
    for (let i = 1; i < Math.min(1 + keepZones, this.unlockedZones.length); i++) kept.push(this.unlockedZones[i]);
    this.unlockedZones = kept;
    this.currentZone = 0;
    for (let i = 0; i < BIOMES.length; i++) this.zones[i] = this.genZone(i);
    this.clearWorkerTargets();
    this.activeEvent = null;
    this.applyStartPerks();
    this.rollQuests();
    this.emit("zone");
    this.shopChanged();
  }
  prestige() {
    if (!this.canPrestige()) return false;
    let amberGain = this.amberPerSeason;
    this.gainAmber(amberGain);
    this.season++;
    this.seasonBonus += 1;
    this.resetRun({
      keepWorkers: Math.floor(this.workers.length * 0.2) + this.perk("bornLeader"),
      keepZones: this.perk("zoneMemory"),
    });
    this.notify(`🍂 Season ${this.season}! +${amberGain} 🔶 Amber`);
    this.emit("prestige", { layer: "season" });
    return true;
  }
  doEra() {
    if (!this.canEra()) return false;
    this.era++;
    this.season = 1;
    this.seasonBonus = 0;
    this.resetRun({ techs: true });
    this.notify(`⭐ ERA ${this.era}! Trees are tougher, but your amber perks persist!`);
    this.emit("prestige", { layer: "era" });
    return true;
  }
  doEpoch() {
    if (!this.canEpoch()) return false;
    let pts = this.era;
    this.epochPoints += pts;
    this.epoch++;
    this.era = 1;
    this.season = 1;
    this.seasonBonus = 0;
    this.amber = 0;
    for (let k in this.ascensionPerks) this.ascensionPerks[k] = false;
    for (let k in this.amberPerks) this.amberPerks[k] = 0;
    this.resetRun({ techs: true });
    if (this.epochPerks.dimensionalRift) this.unlockedZones = BIOMES.map((_, i) => i);
    this.emit("zone");
    this.notify(`🌌 EPOCH ${this.epoch}! +${pts} Epoch Points`);
    this.emit("prestige", { layer: "epoch" });
    return true;
  }

  // ---------------------------------------------------------------- quests, contracts, trade
  rollQuests() {
    let pool = [...QUEST_POOL].sort(() => Math.random() - 0.5);
    this.quests = pool.slice(0, 3).map((q) => ({ ...q, progress: 0 }));
  }
  completeQuest(q) {
    this.stats.questsCompleted++;
    if (q.reward.type === "gold") {
      this.gainGold(q.reward.amount);
      this.notify(`📜 Quest done! +${fmt(q.reward.amount)} 🪙`);
    } else {
      this.gainAmber(q.reward.amount);
      this.notify(`📜 Quest done! +${q.reward.amount} 🔶`);
    }
    let used = new Set(this.quests.map((x) => x.id));
    let avail = QUEST_POOL.filter((x) => !used.has(x.id));
    if (avail.length) this.quests[this.quests.indexOf(q)] = { ...pick(avail), progress: 0 };
    this.emit("reward");
    this.shopChanged();
  }
  newContract() {
    let avail = CONTRACTS_POOL.filter((x) => !this.contracts.find((c) => c.id === x.id));
    let c = pick(avail.length ? avail : CONTRACTS_POOL);
    return { ...c, progress: 0, timeRemaining: c.timeLimit };
  }
  rollContracts() {
    this.contracts = [];
    for (let i = 0; i < 2; i++) this.contracts.push(this.newContract());
  }
  completeContract(c) {
    let idx = this.contracts.indexOf(c);
    if (idx === -1) return;
    this.stats.contractsCompleted++;
    if (c.reward.type === "gold") {
      this.gainGold(c.reward.amount);
      this.notify(`📋 Contract done! +${fmt(c.reward.amount)} 🪙`);
    } else {
      this.gainAmber(c.reward.amount);
      this.notify(`📋 Contract done! +${c.reward.amount} 🔶`);
    }
    this.contracts[idx] = this.newContract();
    this.emit("reward");
    this.shopChanged();
  }
  updateContracts(dt) {
    for (let i = 0; i < this.contracts.length; i++) {
      let c = this.contracts[i];
      c.timeRemaining -= dt;
      if (c.timeRemaining <= 0) {
        this.notify(`📋 Contract expired: ${c.name}`);
        this.contracts[i] = this.newContract();
        this.shopChanged();
      }
    }
  }
  hasRoute(a, b) {
    return this.tradeRoutes.some((r) => (r[0] === a && r[1] === b) || (r[0] === b && r[1] === a));
  }
  connectZones(a, b) {
    if (a === b || this.gold < TRADE_ROUTE_COST || this.hasRoute(a, b)) return false;
    this.gold -= TRADE_ROUTE_COST;
    this.tradeRoutes.push([a, b]);
    this.emit("buy", { k: "route" });
    this.shopChanged();
    return true;
  }
  get tradeRouteCost() {
    return TRADE_ROUTE_COST;
  }
  getTradeIncome() {
    return this.tradeRoutes.length * 100;
  }

  // ---------------------------------------------------------------- events & bosses
  updateEvents(dt) {
    if (this.activeEvent) {
      this.activeEvent._timer -= dt;
      if (this.activeEvent._timer <= 0) {
        this.activeEvent = null;
        this.emit("eventEnd");
      }
      return;
    }
    this.nextEventIn -= dt;
    if (this.nextEventIn <= 0) {
      this.nextEventIn = rand(90, 240);
      this.triggerEvent();
    }
  }
  triggerEvent(ev = pick(EVENTS)) {
    ev = { ...ev, _timer: ev.duration };
    this.stats.eventsTriggered++;
    if (ev.effect === "burnAndBoost") {
      let alive = this.cTrees.filter((t) => t.alive && t.mutation !== "boss");
      let burn = Math.min(8, Math.floor(alive.length * 0.15));
      for (let i = 0; i < burn; i++) {
        let t = alive.splice(Math.floor(Math.random() * alive.length), 1)[0];
        t.alive = false;
        t.rt = TREE_TYPES[t.tier].rg * 0.3;
        this.emit("burn", { tree: t });
      }
      this.notify(`🔥 Forest fire! ${burn} trees burned, but regrowth is faster.`);
      return;
    }
    if (ev.effect === "ancientTree") {
      let tier = Math.min(this.maxTreeTier, 4);
      let p = freeTile(1, GRID - 1);
      this.placeTree(this.cZone, this.makeTree(p.gx, p.gy, tier, { hpMul: 3, ym: 3, sc: 1.4 }));
      this.notify(`🌳 An ancient tree appeared! (3x HP & yield)`);
      return;
    }
    this.activeEvent = ev;
    this.emit("event", ev);
  }
  updateBoss(dt) {
    if (this.boss) return;
    this.bossTimer += dt;
    if (this.bossTimer < this.nextBoss) return;
    this.bossTimer = 0;
    this.nextBoss = rand(180, 300);
    let bi = Math.floor(Math.random() * BOSS_TYPES.length),
      bt = BOSS_TYPES[bi];
    let p = freeTile(2, GRID - 2);
    let t = this.makeTree(p.gx, p.gy, bt.tier, {
      hpMul: bt.hpMul / this.treeHpScale(),
      sc: 1.9,
      mutation: "boss",
    });
    t.boss = bi;
    this.placeTree(this.cZone, t);
    this.notify(`💀 ${bt.name} appeared!`);
    this.emit("bossSpawn", { tree: t, boss: bt });
  }
  defeatBoss(tree) {
    let bd = BOSS_TYPES[tree.boss] || BOSS_TYPES[0];
    this.gainGold(bd.reward.gold);
    this.gainAmber(bd.reward.amber);
    this.stats.bossesDefeated++;
    this.mutationStats.bossesDefeated++;
    this.track("bossesDefeated", 1);
    this.notify(`🎉 ${bd.name} defeated! +${fmt(bd.reward.gold)} 🪙 +${bd.reward.amber} 🔶`);
    this.emit("bossDown", { boss: bd });
    delete tree.boss;
    tree.sc = rand(0.8, 1.15);
  }

  checkAchievements() {
    for (let a of ACHIEVEMENTS) {
      if (!this.achievementsEarned.includes(a.id) && a.check(this)) {
        this.achievementsEarned.push(a.id);
        this._ab = null;
        this.emit("achievement", a);
        this.shopChanged();
      }
    }
  }

  // ---------------------------------------------------------------- main tick
  /** Runs `fn(n)` for the number of whole intervals elapsed on timer `key`. */
  every(key, iv, dt, fn) {
    this.timers[key] = (this.timers[key] || 0) + dt;
    let n = Math.floor(this.timers[key] / iv);
    if (n > 0) {
      this.timers[key] -= n * iv;
      fn(n);
    }
  }
  regrow(dt) {
    let rs = this.regrowSpeed;
    for (let t of this.cTrees) {
      if (t.alive) continue;
      t.rt -= dt * rs;
      if (this.upgrades.planter > 0) t.rt -= dt * 0.05 * this.upgrades.planter;
      if (this.techs.druidPact && Math.random() < 0.05 * dt) t.rt = 0;
      if (t.rt <= 0) {
        let tier = this.pickTier(this.cBiome.tw);
        if (Math.random() < 0.12) tier = Math.min(tier + 1, this.maxTreeTier);
        let m = Math.random(),
          goldenP = 0.02 * (this.perk("goldenMutation") ? 2 : 1),
          mutation = null,
          hpMul = 1;
        if (m < goldenP) {
          mutation = "golden";
          hpMul = 5;
          this.mutationStats.golden++;
        } else if (m < goldenP + 0.005) {
          mutation = "ancient";
          hpMul = 10;
          this.mutationStats.ancient++;
        }
        Object.assign(t, this.makeTree(t.gx, t.gy, tier, { mutation, hpMul }));
        this.emit("grow", { tree: t });
      }
    }
  }
  production(dt) {
    const sp = this.speedMul;
    if (this.upgrades.autoChop > 0)
      this.every("autoChop", 1 / (this.upgrades.autoChop * 0.4 * sp), dt, (n) => {
        let alive = this.cTrees.filter((t) => t.alive);
        for (let i = 0; i < n && alive.length; i++) {
          let t = pick(alive);
          this.chopTree(t, false);
          if (!t.alive) alive = alive.filter((x) => x !== t);
        }
      });
    if (this.upgrades.sawmill > 0)
      this.every("sawmill", 1 / (this.upgrades.sawmill * 0.6 * sp), dt, (n) => {
        let k = Math.min(n, Math.floor(this.logs / 2));
        this.logs -= 2 * k;
        this.planks += k;
        this.rateTracker.planks += k;
        this.track("planksProduced", k);
      });
    if (this.upgrades.market > 0)
      this.every("market", 1 / (this.upgrades.market * 0.5 * sp), dt, (n) => {
        let k = Math.min(n, Math.floor(this.planks));
        this.planks -= k;
        this.gainGold(k * Math.floor(4 * this.goldMul));
      });
    if (this.techs.charcoalKiln)
      this.every("kiln", 2 / sp, dt, (n) => {
        let k = Math.min(n, Math.floor(this.logs / 3));
        this.logs -= 3 * k;
        this.charcoal += k;
        this.track("charMade", k);
        this.track("charcoalMade", k);
      });
    if (this.techs.furnWorkshop)
      this.every("workshop", 3 / sp, dt, (n) => {
        let k = Math.min(n, Math.floor(this.planks / 4), Math.floor(this.charcoal));
        this.planks -= 4 * k;
        this.charcoal -= k;
        this.furniture += k;
        this.stats.furnitureMade += k;
        this.track("furnMade", k);
      });
    if (this.techs.exportDock)
      this.every("dock", 2 / sp, dt, (n) => {
        let k = Math.min(n, Math.floor(this.furniture));
        this.furniture -= k;
        this.stats.exportsCompleted += k;
        this.gainGold(k * Math.floor(25 * this.goldMul * (1 + this.aB("furn"))));
      });
    if (this.techs.artisanGuild)
      this.every("luxury", 2.5 / sp, dt, (n) => {
        let k = Math.min(n, Math.floor(this.furniture), Math.floor(this.charcoal));
        this.furniture -= k;
        this.charcoal -= k;
        this.luxury += k;
        this.stats.luxuryMade += k;
        this.track("luxuryMade", k);
      });
    if (this.upgrades.merchant > 0)
      this.every("merchant", 2 / (this.upgrades.merchant * 0.4 * sp), dt, (n) => {
        let k = Math.min(n, Math.floor(this.planks / 2));
        this.planks -= 2 * k;
        this.gainGold(k * Math.floor(10 * this.goldMul));
      });
    if (this.upgrades.autoSell > 0)
      this.every("autoSell", 5, dt, (n) => {
        let frac = Math.min(1, this.upgrades.autoSell * 0.1);
        let keep = this.logs;
        for (let i = 0; i < n; i++) keep *= 1 - frac;
        this.sell("logs", this.logs - keep);
      });
    if (this.tradeRoutes.length) this.gainGold(this.getTradeIncome() * dt);
  }

  /** One fixed simulation step. `offline` skips random events, bosses and contract timers. */
  tick(dt, offline = false) {
    if (!offline) this.stats.totalPlayTime += dt;
    this.dayTime = (this.dayTime + dt / 120) % 1;
    this.weatherTimer += dt;
    while (this.weatherTimer >= this.curWeather.duration) {
      this.weatherTimer -= this.curWeather.duration;
      this.weatherSeason = (this.weatherSeason + 1) % WEATHER_SEASONS.length;
      this.emit("weather", this.curWeather);
    }
    this.demandTimer += dt;
    if (this.demandTimer >= this.nextDemandIn) {
      this.demandTimer = 0;
      this.nextDemandIn = rand(60, 90);
      for (let r of DEMAND_RESOURCES) this.demand[r] = rand(0.5, 2);
    }
    this.regrow(dt);
    this.updateWorkers(dt);
    this.production(dt);
    if (!offline) {
      this.updateEvents(dt);
      this.updateBoss(dt);
      this.updateContracts(dt);
    }
    let rt = this.rateTracker;
    rt.timer += dt;
    if (rt.timer >= 2) {
      rt.lr = rt.logs / rt.timer;
      rt.pr = rt.planks / rt.timer;
      rt.gr = rt.gold / rt.timer;
      rt.logs = rt.planks = rt.gold = rt.timer = 0;
    }
    this.checkAchievements();
  }

  /**
   * Catch up on time spent away. Closed-game offline time runs at reduced efficiency and is capped;
   * Timber Network raises both. Returns a summary of what changed.
   */
  simulateOffline(seconds, { efficiency = null } = {}) {
    const net = !!this.techs.timberNetwork;
    const cap = net ? OFFLINE_CAP_NETWORK : OFFLINE_CAP;
    const eff = efficiency ?? (net ? 1 : OFFLINE_EFFICIENCY);
    const sim = Math.min(seconds, cap) * eff;
    const keys = ["logs", "planks", "gold", "charcoal", "furniture", "luxury", "amber"];
    const before = Object.fromEntries(keys.map((k) => [k, this[k]]));
    const trees0 = this.stats.treesChopped;
    const steps = Math.min(20000, Math.ceil(sim / SIM_DT));
    const dt = steps ? sim / steps : 0;
    this.silent = true;
    try {
      for (let i = 0; i < steps; i++) this.tick(dt, true);
    } finally {
      this.silent = false;
    }
    const gains = Object.fromEntries(keys.map((k) => [k, this[k] - before[k]]));
    this.shopChanged();
    return { away: seconds, simulated: sim, capped: seconds > cap, efficiency: eff, gains, trees: this.stats.treesChopped - trees0 };
  }

  // ---------------------------------------------------------------- save / load
  getSaveData() {
    const trees = this.cTrees;
    return {
      saveVersion: SAVE_VERSION,
      savedAt: Date.now(),
      logs: this.logs,
      planks: this.planks,
      gold: this.gold,
      charcoal: this.charcoal,
      furniture: this.furniture,
      luxury: this.luxury,
      amber: this.amber,
      totalLogs: this.totalLogs,
      season: this.season,
      seasonBonus: this.seasonBonus,
      era: this.era,
      epoch: this.epoch,
      epochPoints: this.epochPoints,
      epochPerks: this.epochPerks,
      upgrades: this.upgrades,
      techs: this.techs,
      amberPerks: this.amberPerks,
      ascensionPerks: this.ascensionPerks,
      achievementsEarned: this.achievementsEarned,
      stats: this.stats,
      currentZone: this.currentZone,
      unlockedZones: this.unlockedZones,
      zones: this.zones.map((z) => ({ bi: z.bi, trees: z.trees.map(compactTree) })),
      workers: this.workers.map(({ target, state, ...w }) => ({ ...w, ti: target ? trees.indexOf(target) : -1 })),
      quests: this.quests.map((q) => ({ ...q })),
      weatherSeason: this.weatherSeason,
      weatherTimer: this.weatherTimer,
      dayTime: this.dayTime,
      demand: this.demand,
      contracts: this.contracts,
      tradeRoutes: this.tradeRoutes,
      bossTimer: this.bossTimer,
      nextBoss: this.nextBoss,
      nextEventIn: this.nextEventIn,
      timers: this.timers,
      mutationStats: this.mutationStats,
      cosmetics: this.cosmetics,
    };
  }
  loadSaveData(d) {
    d = migrateSave(structuredClone(d));
    this.resetAll();
    const num = (v, dflt = 0) => (Number.isFinite(v) ? v : dflt);
    for (let k of ["logs", "planks", "gold", "charcoal", "furniture", "luxury", "amber", "totalLogs", "seasonBonus", "epochPoints"])
      this[k] = num(d[k]);
    this.season = num(d.season, 1);
    this.era = num(d.era, 1);
    this.epoch = num(d.epoch, 1);
    Object.assign(this.epochPerks, d.epochPerks);
    Object.assign(this.upgrades, d.upgrades);
    Object.assign(this.techs, d.techs);
    Object.assign(this.amberPerks, d.amberPerks);
    Object.assign(this.ascensionPerks, d.ascensionPerks);
    Object.assign(this.stats, d.stats);
    Object.assign(this.mutationStats, d.mutationStats);
    Object.assign(this.cosmetics, d.cosmetics);
    Object.assign(this.demand, d.demand);
    Object.assign(this.timers, d.timers);
    this.achievementsEarned = Array.isArray(d.achievementsEarned) ? d.achievementsEarned : [];
    this._ab = null;
    this.unlockedZones = Array.isArray(d.unlockedZones) && d.unlockedZones.length ? d.unlockedZones : [0];
    this.currentZone = this.unlockedZones.includes(d.currentZone) ? d.currentZone : 0;
    if (Array.isArray(d.zones))
      for (let i = 0; i < BIOMES.length; i++) if (d.zones[i]?.trees) this.zones[i] = { bi: i, trees: d.zones[i].trees.map(compactTree) };
    const trees = this.cTrees;
    this.workers = (d.workers || []).map((w) => ({
      ...w,
      gx: num(w.gx),
      gy: num(w.gy),
      mt: num(w.mt),
      ct: num(w.ct),
      state: "idle",
      target: w.ti >= 0 && trees[w.ti] ? trees[w.ti] : null,
    }));
    for (let w of this.workers) delete w.ti;
    if (Array.isArray(d.quests) && d.quests.length) this.quests = d.quests.map((q) => ({ ...q, progress: num(q.progress) }));
    if (Array.isArray(d.contracts) && d.contracts.length) this.contracts = d.contracts;
    this.tradeRoutes = Array.isArray(d.tradeRoutes) ? d.tradeRoutes.filter((r) => r[0] !== r[1]) : [];
    this.weatherSeason = num(d.weatherSeason) % WEATHER_SEASONS.length;
    this.weatherTimer = num(d.weatherTimer);
    this.dayTime = num(d.dayTime, 0.25);
    this.bossTimer = num(d.bossTimer);
    this.nextBoss = num(d.nextBoss, rand(180, 300));
    this.nextEventIn = num(d.nextEventIn, rand(60, 180));
    this.savedAt = d.savedAt || null;
    this.emit("zone");
    this.shopChanged();
    return d;
  }
}

export { MARKET_TILE, BUILDINGS };
