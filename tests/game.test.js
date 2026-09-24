import { describe, it, expect, beforeEach } from "vitest";
import { Game, SIM_DT } from "../src/game.js";
import { UPGRADES, TECH_TREE, BUILDINGS } from "../src/data.js";

let g;
beforeEach(() => {
  g = new Game();
});
const run = (seconds, dt = SIM_DT) => {
  for (let t = 0; t < seconds; t += dt) g.tick(dt);
};

describe("perks and upgrades that used to be no-ops", () => {
  it("Eternal Wisdom halves tech costs", () => {
    const before = g.techCost("deepRoots");
    g.epochPerks.eternalWisdom = true;
    expect(g.techCost("deepRoots")).toBe(Math.floor(TECH_TREE.deepRoots.cost * 0.5));
    expect(g.techCost("deepRoots")).toBeLessThan(before);
  });
  it("research uses the discounted cost", () => {
    g.epochPerks.eternalWisdom = true;
    g.gold = TECH_TREE.charcoalKiln.cost / 2;
    expect(g.research("charcoalKiln")).toBe(true);
    expect(g.gold).toBe(0);
  });
  it("Infinite Growth removes upgrade caps", () => {
    g.upgrades.treeScanner = UPGRADES.treeScanner.max;
    g.gold = 1e12;
    expect(g.canBuy("treeScanner")).toBe(false);
    g.epochPerks.infiniteGrowth = true;
    expect(g.buyUpgrade("treeScanner")).toBe(true);
    expect(g.upgrades.treeScanner).toBe(UPGRADES.treeScanner.max + 1);
  });
  it("Ascension perks bought in the Amber tab take effect", () => {
    const p = g.chopPower;
    g.amber = 100;
    expect(g.buyAscension("headStart")).toBe(true);
    expect(g.buyAscension("keenEdge")).toBe(true);
    expect(g.chopPower).toBe(p + 5);
  });
  it("Auto-Seller sells logs periodically", () => {
    g.upgrades.autoSell = 5;
    g.logs = 1000;
    g.tick(5);
    expect(g.logs).toBeLessThan(1000);
    expect(g.gold).toBeGreaterThan(0);
  });
  it("Double Strike can hit twice", () => {
    g.upgrades.doubleChop = 10; // 100%
    const t = g.cTrees.find((x) => x.alive);
    t.hp = t.maxHp = 1e6;
    g.chopTree(t, true);
    expect(1e6 - t.hp).toBeGreaterThanOrEqual(2 * g.chopPower);
  });
  it("Time Warp doubles production speed", () => {
    g.upgrades.sawmill = 1;
    g.logs = 1e6;
    g.tick(10);
    const normal = g.planks;
    g.planks = 0;
    g.epochPerks.timeWarp = true;
    g.tick(10);
    expect(g.planks).toBeCloseTo(normal * 2, -1);
  });
});

describe("bosses", () => {
  it("spawn on the map, can be defeated, and count towards stats", () => {
    g.bossTimer = 1e9;
    g.tick(SIM_DT);
    const boss = g.boss;
    expect(boss).toBeTruthy();
    expect(g.cTrees).toContain(boss);
    const gold = g.gold;
    while (boss.alive) g.chopTree(boss, true, 1e9);
    expect(g.stats.bossesDefeated).toBe(1);
    expect(g.gold).toBeGreaterThan(gold);
    expect(g.boss).toBeNull();
  });
});

describe("contracts and quests", () => {
  it("contracts progress and pay out", () => {
    g.contracts = [{ id: "trees-500", name: "x", desc: "", target: 3, stat: "treesChopped", reward: { type: "gold", amount: 100 }, timeLimit: 800, progress: 0, timeRemaining: 800 }];
    for (let i = 0; i < 3; i++) g.chopTree(g.cTrees.find((t) => t.alive), true, 1e9);
    expect(g.stats.contractsCompleted).toBe(1);
    expect(g.gold).toBeGreaterThanOrEqual(100);
  });
  it("contracts expire and are replaced", () => {
    const first = g.contracts[0];
    first.timeRemaining = 0.01;
    g.tick(SIM_DT);
    expect(g.contracts[0]).not.toBe(first);
  });
});

describe("workers", () => {
  it("choppers fell trees; merchants sell at the market; planters tend stumps", () => {
    g.gold = 1e9;
    for (let i = 0; i < 30; i++) g.hireWorker();
    g.planks = 1000;
    run(120);
    expect(g.stats.treesChopped).toBeGreaterThan(0);
    const merch = g.workers.filter((w) => w.type === "merchant");
    if (merch.length) expect(g.planks).toBeLessThan(1000);
  });
  it("targets survive save/load as references into the live map", () => {
    g.gold = 1e9;
    for (let i = 0; i < 10; i++) g.hireWorker();
    run(5);
    const json = JSON.stringify(g.getSaveData());
    for (const w of JSON.parse(json).workers) expect(w).not.toHaveProperty("target");
    const g2 = new Game();
    g2.loadSaveData(JSON.parse(json));
    for (const w of g2.workers) if (w.target) expect(g2.cTrees).toContain(w.target);
  });
  it("switching zones clears targets", () => {
    g.gold = 1e9;
    for (let i = 0; i < 5; i++) g.hireWorker();
    run(2);
    g.unlockZone(1);
    expect(g.workers.every((w) => !w.target)).toBe(true);
  });
});

describe("map", () => {
  it("never generates trees on building tiles and keeps one tree per tile", () => {
    const reserved = new Set(BUILDINGS.map((b) => `${Math.floor(b.pos.gx)},${Math.floor(b.pos.gy)}`));
    g.gold = 1e12;
    for (let i = 0; i < 6; i++) g.buyUpgrade("explore");
    for (let i = 0; i < 20; i++) g.triggerEvent({ effect: "ancientTree", duration: 0 });
    for (const z of g.zones) {
      const tiles = z.trees.map((t) => `${t.gx},${t.gy}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      for (const k of tiles) expect(reserved.has(k)).toBe(false);
    }
  });
});

describe("offline progress", () => {
  it("produces resources at reduced efficiency and respects the cap", () => {
    g.gold = 1e9;
    for (let i = 0; i < 10; i++) g.hireWorker();
    g.upgrades.autoChop = 10;
    const sum = g.simulateOffline(20 * 3600);
    expect(sum.capped).toBe(true);
    expect(sum.simulated).toBe(8 * 3600 * 0.5);
    expect(sum.trees).toBeGreaterThan(100);
  });
  it("Timber Network gives full efficiency and a 24h cap", () => {
    g.techs.timberNetwork = true;
    const sum = g.simulateOffline(30 * 3600);
    expect(sum.simulated).toBe(24 * 3600);
  });
  it("step size does not change results much", () => {
    const rates = [0.05, 1].map((dt) => {
      const x = new Game();
      x.checkAchievements = () => {};
      x.upgrades.autoChop = 10;
      x.upgrades.axe = 20;
      for (let t = 0; t < 600; t += dt) x.tick(dt, true);
      return x.stats.treesChopped;
    });
    expect(Math.abs(rates[0] - rates[1]) / rates[0]).toBeLessThan(0.25);
  });
});

describe("prestige", () => {
  it("season reset grants amber and keeps perks", () => {
    g.totalLogs = 1e6;
    g.ascensionPerks.headStart = true;
    expect(g.prestige()).toBe(true);
    expect(g.season).toBe(2);
    expect(g.amber).toBeGreaterThan(0);
    expect(g.gold).toBe(500); // Head Start
  });
  it("epoch reset clears amber perks of both kinds", () => {
    g.era = 5;
    g.amberPerks.keenEdge = 3;
    g.ascensionPerks.keenEdge = true;
    expect(g.doEpoch()).toBe(true);
    expect(g.perk("keenEdge")).toBe(0);
    expect(g.epochPoints).toBe(5);
  });
});

describe("save/load", () => {
  it("round-trips the full state", () => {
    g.gold = 1234;
    g.upgrades.axe = 7;
    g.techs.charcoalKiln = true;
    g.achievementsEarned.push("chop100");
    const d = JSON.parse(JSON.stringify(g.getSaveData()));
    const g2 = new Game();
    g2.loadSaveData(d);
    expect(g2.gold).toBe(1234);
    expect(g2.upgrades.axe).toBe(7);
    expect(g2.techs.charcoalKiln).toBe(true);
    expect(g2.chopPower).toBe(g.chopPower);
    expect(g2.savedAt).toBeTypeOf("number");
  });
  it("loads a v7-era save shape", () => {
    const old = {
      saveVersion: 7,
      gold: 50,
      stats: { treesChopped: 3 },
      upgrades: { axe: 1 },
      techs: {},
      workers: [{ name: "Old", type: "chopper", speed: 1, power: 1, gx: 1, gy: 1, target: { gx: 0, gy: 0, alive: true } }],
      zones: [],
    };
    const g2 = new Game();
    g2.loadSaveData(old);
    expect(g2.gold).toBe(50);
    expect(g2.workers[0].target).toBeNull();
    g2.tick(SIM_DT);
  });
});
