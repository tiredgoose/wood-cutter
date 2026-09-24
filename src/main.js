import { VERSION, SAVE_KEY } from "./data.js";
import { Game, SIM_DT } from "./game.js";
import { Renderer } from "./render.js";
import { UI } from "./ui.js";
import { Sfx } from "./audio.js";
import { bindInput } from "./input.js";
import { encodeSave, decodeSave, writeStorage, readStorage, BACKUP_KEY } from "./save.js";
import { fmtTime } from "./util.js";

const SETTINGS_KEY = "woodcutter_settings";
const AUTOSAVE_MS = 30000;
const CATCHUP_MIN_S = 3; // gaps longer than this (sleep, hidden tab) are fast-forwarded
const WELCOME_MIN_S = 60;

const $ = (id) => document.getElementById(id);
const canvas = $("game"),
  wrap = $("canvasWrap");

// ------------------------------------------------------------------ settings (per device)
const settings = Object.assign(
  { sound: true, volume: 0.6, damageNumbers: true, effects: matchMedia("(prefers-reduced-motion: reduce)").matches ? "low" : "high" },
  safeJSON(() => localStorage.getItem(SETTINGS_KEY)),
);
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: settings just won't persist */
  }
}
function safeJSON(get) {
  try {
    return JSON.parse(get()) || {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ core objects
let game = null;
let lastSave = 0,
  saveError = null;
const sfx = new Sfx(settings);
const renderer = new Renderer(canvas, new Game(), settings);
const ui = new UI({
  settings,
  sfx,
  renderer,
  handlers: {
    setSetting(key, el) {
      if (key === "lowFx") settings.effects = el.checked ? "low" : "high";
      else settings[key] = el.checked;
      saveSettings();
    },
    genCode() {
      $("exportArea").value = encodeSave(game.getSaveData());
    },
    async copyCode() {
      const ta = $("exportArea");
      if (!ta.value) ta.value = encodeSave(game.getSaveData());
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch {
        ta.select();
        document.execCommand("copy");
      }
      ui.notify("Copied save code to clipboard");
    },
    download() {
      const blob = new Blob([JSON.stringify(game.getSaveData())], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `woodcutter-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    importCode() {
      const area = $("importArea");
      if (!area.value.trim()) return ui.notify("Paste a save code first");
      importText(area.value);
    },
    importFile() {
      $("fileInput").click();
    },
    saveNow() {
      saveGame();
      ui.notify(saveError ? "⚠️ Save failed" : "Saved");
    },
    newGame() {
      if (!confirm("Delete your save and start over? This cannot be undone.")) return;
      game = null; // stop pagehide/autosave from writing it back
      try {
        localStorage.removeItem(SAVE_KEY);
        localStorage.removeItem(BACKUP_KEY);
      } catch {
        /* ignore */
      }
      location.reload();
    },
    changelog() {
      ui.showChangelog();
    },
    zoomIn() {
      renderer.zoomAt(renderer.W / 2, renderer.H / 2, 1.25);
    },
    zoomOut() {
      renderer.zoomAt(renderer.W / 2, renderer.H / 2, 0.8);
    },
    closeChangelog() {
      $("changelog").hidden = true;
    },
    closeWelcome() {
      $("welcomeBack").hidden = true;
    },
    saveStatus() {
      if (saveError) return `⚠️ Saving failed: ${saveError.message || saveError}. Export your save to keep it safe.`;
      return lastSave ? `Autosaves every 30s and when you leave. Last saved ${fmtTime((Date.now() - lastSave) / 1000)} ago.` : "Not saved yet.";
    },
    titleNew() {
      if (readStorage(localStorage) && !confirm("Start a new game? Your existing save will be overwritten.")) return;
      startGame(null);
    },
    titleContinue() {
      startGame(readStorage(localStorage));
    },
    titleImport() {
      const code = prompt("Paste your save code:");
      if (code) importText(code, true);
    },
  },
});

function importText(text, fromTitle = false) {
  let data;
  try {
    data = decodeSave(text);
  } catch {
    return fromTitle ? alert("Invalid save code") : ui.notify("Invalid save code");
  }
  startGame(data, { imported: true });
  saveGame();
}
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) importText(await f.text());
});
document.addEventListener("input", (e) => {
  if (e.target.dataset?.setting === "volume") {
    settings.volume = +e.target.value;
    saveSettings();
  }
});

bindInput({
  canvas,
  getGame: () => game,
  renderer,
  ui,
  sfx,
  onToggleMute() {
    settings.sound = !settings.sound;
    saveSettings();
    ui.notify(settings.sound ? "🔊 Sound on" : "🔇 Sound off");
    ui.dirty = true;
  },
});

// ------------------------------------------------------------------ lifecycle
function startGame(data, { imported = false } = {}) {
  const g = new Game();
  let away = 0;
  if (data) {
    try {
      g.loadSaveData(data);
    } catch (e) {
      console.error(e);
      alert("That save could not be loaded.");
      return;
    }
    if (!imported && g.savedAt) away = (Date.now() - g.savedAt) / 1000;
  }
  game = g;
  window.game = g; // handy for debugging from the console
  renderer.setGame(g);
  ui.setGame(g);
  $("titleScreen").classList.add("hidden");
  if (away > WELCOME_MIN_S) ui.showWelcome(g.simulateOffline(away));
  if (imported) ui.notify("Save imported!");
  lastSave = Date.now();
  lastFrame = performance.now();
}

function saveGame() {
  if (!game) return;
  saveError = writeStorage(localStorage, game.getSaveData());
  if (saveError) console.warn("Save failed", saveError);
  else lastSave = Date.now();
}

function catchUp(seconds) {
  if (!game || seconds < CATCHUP_MIN_S) return;
  // the tab was open (just hidden / asleep), so this runs at full efficiency
  const sum = game.simulateOffline(seconds, { efficiency: 1 });
  if (seconds > WELCOME_MIN_S) ui.showWelcome(sum);
}

let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (!game) return;
  if (document.hidden) {
    hiddenAt = Date.now();
    saveGame();
  } else if (hiddenAt) {
    catchUp((Date.now() - hiddenAt) / 1000);
    hiddenAt = 0;
    lastFrame = performance.now();
  }
});
window.addEventListener("pagehide", saveGame);
window.addEventListener("beforeunload", saveGame);

// ------------------------------------------------------------------ main loop
let lastFrame = performance.now(),
  acc = 0;
function frame(now) {
  let elapsed = (now - lastFrame) / 1000;
  lastFrame = now;
  if (game) {
    if (elapsed > CATCHUP_MIN_S) {
      // a hidden tab is caught up by the visibilitychange handler; this covers sleep / frozen tabs
      if (!hiddenAt) catchUp(elapsed);
      elapsed = 0;
    }
    acc += elapsed;
    let steps = 0;
    while (acc >= SIM_DT && steps < 12) {
      game.tick(SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (steps === 12) acc = 0; // too slow to keep up; drop the backlog instead of spiralling
    if (renderer.hovered && !renderer.hovered.alive) {
      renderer.hovered = null;
      ui.treeTip(null);
    }
    renderer.update(Math.min(elapsed, 0.1));
    renderer.draw();
    ui.frame(now);
    if (Date.now() - lastSave > AUTOSAVE_MS) saveGame();
  } else {
    // title screen: animate the forest in the background
    renderer.game.tick(Math.min(elapsed, 0.1), true);
    renderer.update(Math.min(elapsed, 0.1));
    renderer.draw();
  }
  requestAnimationFrame(frame);
}

function resize() {
  renderer.resize(wrap.clientWidth, wrap.clientHeight);
}
new ResizeObserver(resize).observe(wrap);
resize();
requestAnimationFrame(frame);

// ------------------------------------------------------------------ title screen & PWA
$("titleVer").textContent = "v" + VERSION;
if (readStorage(localStorage)) $("btnContinue").hidden = false;
else $("btnPlay").textContent = "▶ Play";

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed", e));
}
