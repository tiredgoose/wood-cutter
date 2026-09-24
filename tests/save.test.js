import { describe, it, expect } from "vitest";
import { migrateSave, encodeSave, decodeSave, writeStorage, readStorage, BACKUP_KEY } from "../src/save.js";
import { SAVE_KEY, SAVE_VERSION } from "../src/data.js";

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

describe("encode/decode", () => {
  it("round-trips unicode (btoa alone would throw)", () => {
    const d = { name: "Bjørn 🪓 the Swift", n: 5 };
    expect(decodeSave(encodeSave(d))).toEqual(d);
  });
  it("reads legacy base64-of-JSON codes", () => {
    const d = { saveVersion: 7, gold: 12 };
    expect(decodeSave(btoa(JSON.stringify(d)))).toEqual(d);
  });
  it("reads raw JSON (downloaded save files)", () => {
    expect(decodeSave('{"gold":3}')).toEqual({ gold: 3 });
  });
  it("rejects garbage", () => {
    expect(() => decodeSave("not a save!!")).toThrow();
  });
});

describe("migrateSave", () => {
  it("upgrades a v1 save to the current version", () => {
    const d = migrateSave({ logs: 5, gold: 10, upgrades: { axe: 2 } });
    expect(d.saveVersion).toBe(SAVE_VERSION);
    expect(d.stats.treesChopped).toBe(0);
    expect(d.epochPerks.cosmicAxe).toBe(false);
    expect(d.ascensionPerks.headStart).toBe(false);
  });
  it("v7 -> v8 drops serialised worker targets and tree animation state", () => {
    const tree = { gx: 1, gy: 2, tier: 0, hp: 8, maxHp: 8, alive: true, rt: 0, sc: 1, sw: 3, wb: 0.2, fa: 0, falling: false, fd: 1, mutation: null };
    const d = migrateSave({
      saveVersion: 7,
      stats: {},
      mutationStats: { bossesDefeated: 3 },
      workers: [{ name: "A", type: "chopper", gx: 0, gy: 0, target: { ...tree }, px: 1, py: 2 }],
      zones: [{ bi: 0, trees: [tree] }],
    });
    expect(d.workers[0].target).toBeUndefined();
    expect(d.workers[0].ti).toBe(-1);
    expect(d.zones[0].trees[0]).toEqual({ gx: 1, gy: 2, tier: 0, hp: 8, maxHp: 8, alive: true, rt: 0, sc: 1 });
    expect(d.stats.bossesDefeated).toBe(3);
  });
});

describe("storage", () => {
  it("keeps the previous save in a backup slot and falls back to it", () => {
    const s = memStorage();
    expect(writeStorage(s, { gold: 1 })).toBeNull();
    writeStorage(s, { gold: 2 });
    expect(JSON.parse(s.getItem(BACKUP_KEY)).gold).toBe(1);
    s.setItem(SAVE_KEY, "corrupt{{{");
    expect(readStorage(s).gold).toBe(1);
  });
  it("reads a legacy base64 main slot", () => {
    const s = memStorage();
    s.setItem(SAVE_KEY, btoa(JSON.stringify({ gold: 9 })));
    expect(readStorage(s).gold).toBe(9);
  });
  it("reports write failures instead of swallowing them", () => {
    const s = memStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(writeStorage(s, { gold: 1 })).toBeInstanceOf(Error);
  });
});
