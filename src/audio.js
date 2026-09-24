// Tiny synthesized sound effects (no audio files). The AudioContext is created on the first user gesture.
export class Sfx {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.last = {};
  }
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  ok(name, minGap) {
    if (!this.ctx || !this.settings.sound || this.ctx.state !== "running") return false;
    const now = this.ctx.currentTime;
    if (now - (this.last[name] || 0) < minGap) return false;
    this.last[name] = now;
    this.master.gain.value = this.settings.volume ?? 0.6;
    return true;
  }
  env(node, t, a, peak, dur) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  noise(t, dur, freq, q, peak, type = "bandpass", sweepTo = null) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, peak, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
  tone(t, freq, dur, peak, type = "sine", slideTo = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, 0.005, peak, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  chop(crit) {
    if (!this.ok("chop", 0.04)) return;
    const t = this.ctx.currentTime,
      p = 0.9 + Math.random() * 0.2;
    this.noise(t, 0.09, 1400 * p, 1.5, 0.5);
    this.tone(t, 150 * p, 0.1, 0.45, "triangle", 70);
    if (crit) this.tone(t + 0.01, 1900, 0.18, 0.12, "sine", 2400);
  }
  fell(quiet) {
    if (!this.ok(quiet ? "fellq" : "fell", quiet ? 0.25 : 0.06)) return;
    const t = this.ctx.currentTime,
      v = quiet ? 0.25 : 1;
    this.noise(t, 0.5, 2500, 0.7, 0.35 * v, "lowpass", 180);
    this.tone(t + 0.05, 90, 0.35, 0.3 * v, "sawtooth", 45);
    this.tone(t + 0.35, 60, 0.2, 0.35 * v, "sine", 40);
  }
  coin() {
    if (!this.ok("coin", 0.08)) return;
    const t = this.ctx.currentTime;
    this.tone(t, 1320, 0.08, 0.15, "square");
    this.tone(t + 0.07, 1760, 0.16, 0.15, "square");
  }
  buy() {
    if (!this.ok("buy", 0.05)) return;
    const t = this.ctx.currentTime;
    this.tone(t, 520, 0.08, 0.18, "triangle", 780);
  }
  fanfare() {
    if (!this.ok("fanfare", 0.5)) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.09, f, 0.25, 0.16, "triangle"));
  }
  boss() {
    if (!this.ok("boss", 1)) return;
    const t = this.ctx.currentTime;
    this.tone(t, 110, 0.8, 0.35, "sawtooth", 55);
    this.noise(t, 0.8, 300, 2, 0.2, "bandpass", 80);
  }
  click() {
    if (!this.ok("click", 0.03)) return;
    this.tone(this.ctx.currentTime, 900, 0.03, 0.08, "square");
  }
}
