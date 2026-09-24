import { describe, it, expect } from "vitest";
import { fmt, fmtTime, softCost, esc } from "../src/util.js";

describe("fmt", () => {
  it("formats small and suffixed numbers", () => {
    expect(fmt(0)).toBe("0");
    expect(fmt(999.9)).toBe("999");
    expect(fmt(1234)).toBe("1.2K");
    expect(fmt(2.5e6)).toBe("2.5M");
    expect(fmt(1e15)).toBe("1.0Qa");
    expect(fmt(3e18)).toBe("3.0Qi");
  });
  it("does not print 1000.0K at the boundary", () => {
    expect(fmt(999_990)).toBe("1.0M");
  });
  it("falls back to exponent notation past the last suffix", () => {
    expect(fmt(1e40)).toBe("1.00e40");
    expect(fmt(Infinity)).toBe("∞");
  });
});

describe("fmtTime", () => {
  it("formats durations", () => {
    expect(fmtTime(42)).toBe("42s");
    expect(fmtTime(125)).toBe("2m");
    expect(fmtTime(3 * 3600 + 5 * 60)).toBe("3h 5m");
  });
});

describe("softCost", () => {
  it("grows geometrically and steepens after levels 10 and 25", () => {
    expect(softCost(10, 1.5, 0)).toBe(10);
    expect(softCost(10, 1.5, 1)).toBe(15);
    const r9 = softCost(10, 1.5, 10) / softCost(10, 1.5, 9);
    const r11 = softCost(10, 1.5, 11) / softCost(10, 1.5, 10);
    expect(r11).toBeGreaterThan(r9);
  });
});

describe("esc", () => {
  it("escapes html", () => {
    expect(esc(`<img src=x onerror="a">`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
  });
});
