import { TILE_W, TILE_H } from "./data.js";

export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => Math.random() * (b - a) + a;
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const clamp = (v, l, h) => Math.max(l, Math.min(h, v));

const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];

/** Short human number: 1234 -> 1.2K, 1e20 -> 100.0Qi, beyond Dc -> 1.23e36 */
export function fmt(n) {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : "0";
  if (n < 0) return "-" + fmt(-n);
  if (n < 1000) return Math.floor(n).toString();
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIXES.length) return n.toExponential(2).replace("+", "");
  let v = n / Math.pow(1000, tier);
  // guard against 999.95 rounding up to "1000.0K"
  if (v >= 999.95 && tier + 1 < SUFFIXES.length) return (v / 1000).toFixed(1) + SUFFIXES[tier + 1];
  return v.toFixed(1) + SUFFIXES[tier];
}

export function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function isoToScreen(gx, gy) {
  return { x: ((gx - gy) * TILE_W) / 2, y: ((gx + gy) * TILE_H) / 2 };
}

export function softCost(base, mul, lvl) {
  if (lvl < 10) return Math.floor(base * Math.pow(mul, lvl));
  if (lvl < 25) return Math.floor(base * Math.pow(mul, 10) * Math.pow(mul * 1.15, lvl - 10));
  return Math.floor(base * Math.pow(mul, 10) * Math.pow(mul * 1.15, 15) * Math.pow(mul * 1.4, lvl - 25));
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function toHex(r, g, b) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
export function lerpC(a, b, t) {
  const [ar, ag, ab] = hex(a),
    [br, bg, bb] = hex(b);
  return toHex(lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}
/** Add `amt` to each channel (negative darkens). */
export function shadeC(c, amt) {
  const [r, g, b] = hex(c);
  return toHex(r + amt, g + amt, b + amt);
}

/** Escape text before interpolating into innerHTML (save imports can carry arbitrary strings). */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
