import {
  SAVE_VERSION,
  SAVE_KEY,
  AMBER_SHOP,
  TECH_TREE,
  DEMAND_RESOURCES,
  ASCENSION_TREE,
  EPOCH_PERKS,
} from "./data.js";
import { rand } from "./util.js";

export const BACKUP_KEY = SAVE_KEY + "_backup";

export function migrateSave(d) {
  let v = d.saveVersion || 1;
  if (v < 2) {
    d.charcoal = d.charcoal || 0;
    d.furniture = d.furniture || 0;
    d.techs = d.techs || {};
    d.achievementsEarned = d.achievementsEarned || [];
    d.stats = d.stats || {
      treesChopped: 0,
      totalGold: 0,
      heartwoodChopped: 0,
      furnitureMade: 0,
      crits: 0,
      totalPlayTime: 0,
    };
    d.unlockedZones = d.unlockedZones || [0];
    d.currentZone = d.currentZone || 0;
    v = 2;
  }
  if (v < 3) {
    d.stats.totalPlayTime = d.stats.totalPlayTime || 0;
    v = 3;
  }
  if (v < 4) {
    d.amber = d.amber || 0;
    d.era = d.era || 1;
    d.amberPerks = d.amberPerks || {};
    for (let p of AMBER_SHOP) d.amberPerks[p.id] = d.amberPerks[p.id] || 0;
    d.stats.worldtreeChopped = d.stats.worldtreeChopped || 0;
    d.stats.questsCompleted = d.stats.questsCompleted || 0;
    d.stats.totalAmber = d.stats.totalAmber || 0;
    d.stats.eventsTriggered = d.stats.eventsTriggered || 0;
    d.quests = d.quests || [];
    for (let k in TECH_TREE) d.techs[k] = d.techs[k] || false;
    v = 4;
  }
  if (v < 5) {
    d.luxury = d.luxury || 0;
    d.upgrades = d.upgrades || {};
    d.upgrades.merchant = d.upgrades.merchant || 0;
    d.upgrades.planter = d.upgrades.planter || 0;
    d.weatherSeason = d.weatherSeason || 0;
    d.weatherTimer = d.weatherTimer || 0;
    d.stats.luxuryMade = d.stats.luxuryMade || 0;
    d.stats.exportsCompleted = d.stats.exportsCompleted || 0;
    d.techs.artisanGuild = d.techs.artisanGuild || false;
    v = 5;
  }
  if (v < 6) {
    d.demand = {};
    for (let r of DEMAND_RESOURCES) d.demand[r] = 1;
    d.demandTimer = 0;
    d.contracts = [];
    d.contractStats = {};
    d.tradeRoutes = [];
    d.bossTimer = 0;
    d.nextBoss = rand(180, 300);
    d.mutationStats = { golden: 0, ancient: 0, bossesDefeated: 0 };
    d.cosmetics = { axe: "default", theme: "default" };
    d.ascensionPerks = {};
    for (let n of ASCENSION_TREE) d.ascensionPerks[n.id] = false;
    for (let n of ASCENSION_TREE) {
      let ap = d.amberPerks[n.id];
      if (ap) d.ascensionPerks[n.id] = ap > 0;
    }
    v = 6;
  }
  if (v < 7) {
    d.epoch = d.epoch || 1;
    d.epochPoints = d.epochPoints || 0;
    d.epochPerks = d.epochPerks || {};
    for (let ep of EPOCH_PERKS) d.epochPerks[ep.id] = d.epochPerks[ep.id] || false;
    for (let k of ["logMulti", "goldMulti", "critDmg", "treeScanner", "doubleChop", "regrowBoost", "autoSell", "luckyDrop"])
      d.upgrades[k] = d.upgrades[k] || 0;
    d.stats.bossesDefeated = d.stats.bossesDefeated || 0;
    d.stats.goldenChopped = d.stats.goldenChopped || 0;
    d.stats.ancientChopped = d.stats.ancientChopped || 0;
    v = 7;
  }
  if (v < 8) {
    // v7 serialised each worker's whole target tree (a detached copy after reload) and per-tree
    // animation state. Keep only what the simulation needs.
    for (let w of d.workers || []) {
      delete w.target;
      delete w.px;
      delete w.py;
      w.ti = -1;
    }
    for (let z of d.zones || []) z.trees = (z.trees || []).map(compactTree);
    // bosses were never placed on the map in v7, so this counter was the only record
    d.stats.bossesDefeated = Math.max(d.stats.bossesDefeated || 0, d.mutationStats?.bossesDefeated || 0);
    d.settings = d.settings || {};
    v = 8;
  }
  d.saveVersion = SAVE_VERSION;
  return d;
}

/** Only the fields the simulation needs; animation state lives in the renderer. */
export function compactTree(t) {
  const o = { gx: t.gx, gy: t.gy, tier: t.tier, hp: t.hp, maxHp: t.maxHp, alive: !!t.alive, rt: t.rt || 0, sc: t.sc || 1 };
  if (t.mutation) o.mutation = t.mutation;
  if (t.boss !== undefined) o.boss = t.boss;
  return o;
}

// btoa only accepts Latin-1; go through UTF-8 so names/emoji can never break a save.
export function encodeSave(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Accepts an export code (base64 of UTF-8 or legacy Latin-1 JSON) or raw JSON (e.g. a downloaded file). */
export function decodeSave(str) {
  str = String(str).trim();
  if (str.startsWith("{")) return JSON.parse(str);
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  let json;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    json = bin;
  }
  const d = JSON.parse(json);
  if (!d || typeof d !== "object") throw new Error("Not a save");
  return d;
}

/** Writes the save, rotating the previous good one into a backup slot. Returns an error or null. */
export function writeStorage(storage, obj) {
  try {
    const prev = storage.getItem(SAVE_KEY);
    const json = JSON.stringify(obj);
    if (prev && prev !== json) storage.setItem(BACKUP_KEY, prev);
    storage.setItem(SAVE_KEY, json);
    return null;
  } catch (e) {
    return e;
  }
}

/** Reads the main slot, falling back to the backup if it is missing or corrupt. */
export function readStorage(storage) {
  for (const key of [SAVE_KEY, BACKUP_KEY]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      return decodeSave(raw);
    } catch {
      /* try next slot */
    }
  }
  return null;
}
