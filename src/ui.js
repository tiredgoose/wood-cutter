// DOM UI: HUD, shop panel, banners, tooltips, modals. Updated on a throttle with change detection.
import {
  VERSION,
  CHANGELOG,
  BIOMES,
  TREE_TYPES,
  UPGRADES,
  TECH_TREE,
  EPOCH_PERKS,
  WORKER_TYPES,
  ACHIEVEMENTS,
  ASCENSION_TREE,
  DEMAND_RESOURCES,
  AXE_COSMETICS,
  BOSS_TYPES,
} from "./data.js";
import { fmt, fmtTime, esc } from "./util.js";

const $ = (id) => document.getElementById(id);

const GROUPS = [
  { id: "build", icon: "🪓", label: "Build", tabs: [["upgrades", "Upgrades"], ["workers", "Workers"], ["tech", "Tech"], ["trade", "Trade"]] },
  { id: "prestige", icon: "🔶", label: "Prestige", tabs: [["amber", "Amber"], ["epoch", "Epoch"], ["cosmetics", "Cosmetics"]] },
  { id: "goals", icon: "📜", label: "Goals", tabs: [["quests", "Quests"], ["contracts", "Contracts"], ["achieve", "Trophies"]] },
  { id: "more", icon: "⚙️", label: "More", tabs: [["stats", "Stats"], ["save", "Save"], ["settings", "Settings"]] },
];
const TAB_GROUP = Object.fromEntries(GROUPS.flatMap((g) => g.tabs.map(([t]) => [t, g.id])));
const SECTION_LABELS = { tools: "⚒️ Tools", buildings: "🏗️ Buildings", magic: "✨ Magic", exploration: "🗺️ Exploration" };
const SELLS = [
  ["logs", "🪵", "Logs", "S", () => true],
  ["planks", "🪚", "Planks", "D", () => true],
  ["charcoal", "🔥", "Charcoal", "F", (g) => g.techs.charcoalKiln || g.charcoal > 0],
  ["furniture", "🪑", "Furniture", "G", (g) => g.techs.furnWorkshop || g.furniture > 0],
  ["luxury", "✨", "Luxury", "H", (g) => g.techs.artisanGuild || g.luxury > 0],
];

function row({ key, icon, name, desc, cost = "", level = "", locked = false, action = "", arg = "", cls = "", style = "" }) {
  const act = action && !locked ? ` data-action="${action}" data-arg="${esc(arg)}" role="button" tabindex="0"` : "";
  return {
    key,
    html: `<div class="upgrade-btn ${locked ? "locked" : ""} ${cls}" data-key="${esc(key)}"${act} style="${style}"><div class="icon">${icon}</div><div class="info"><div class="name">${name}</div><div class="desc">${desc}</div></div><div class="right"><div class="cost">${cost}</div><div class="level">${level}</div></div></div>`,
  };
}
const section = (key, text) => ({ key, html: `<div class="shop-section" data-key="${key}">${text}</div>` });
const note = (key, text) => ({ key, html: `<div class="shop-note" data-key="${key}">${text}</div>` });

export class UI {
  constructor({ settings, sfx, renderer, handlers }) {
    this.settings = settings;
    this.sfx = sfx;
    this.renderer = renderer;
    this.handlers = handlers; // app-level actions: import, download, newGame, saveSettings, ...
    this.tab = "upgrades";
    this.hudCache = {};
    this.dirty = true;
    this.lastShop = 0;
    this.lastHud = 0;
    this.shopContent = $("shopContent");
    this.bindDelegation();
    $("verBadge").textContent = "v" + VERSION;
  }

  setGame(game) {
    this.game = game;
    this.dirty = true;
    this.zoneHtml = "";
    this.bannerKey = "";
    game.on((type, d) => this.onGameEvent(type, d));
    this.renderTabs();
  }

  onGameEvent(type, d) {
    switch (type) {
      case "shop":
      case "zone":
        this.dirty = true;
        break;
      case "notify":
        this.notify(d);
        break;
      case "achievement":
        this.toast(`🏆 <b>${esc(d.name)}</b> <span class="toast-sub">${esc(d.bonus)}</span>`);
        this.sfx.fanfare();
        break;
      case "event":
        this.sfx.fanfare();
        break;
      case "bossSpawn":
        this.sfx.boss();
        break;
      case "bossDown":
      case "reward":
        this.sfx.coin();
        break;
      case "sale":
        this.sfx.coin();
        break;
      case "buy":
        this.sfx.buy();
        break;
      case "prestige":
        this.sfx.fanfare();
        break;
      case "hit":
        if (d.manual) this.sfx.chop(d.crit);
        break;
      case "fell":
        this.sfx.fell(!d.manual);
        break;
    }
  }

  // ------------------------------------------------------------ click delegation
  bindDelegation() {
    const handle = (el) => {
      const a = el.dataset.action,
        arg = el.dataset.arg;
      this.sfx.unlock();
      this.act(a, arg, el);
    };
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (el) handle(el);
    });
    document.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-action][role=button]")) {
        e.preventDefault();
        handle(e.target);
      }
    });
  }
  act(a, arg, el) {
    const g = this.game;
    switch (a) {
      case "group":
        this.setTab(GROUPS.find((x) => x.id === arg).tabs[0][0]);
        break;
      case "tab":
        this.setTab(arg);
        break;
      case "buyUpgrade":
        g.buyUpgrade(arg);
        break;
      case "research":
        g.research(arg);
        break;
      case "hire":
        g.hireWorker();
        break;
      case "sell":
        g.sellAll(arg);
        break;
      case "ascension":
        g.buyAscension(arg);
        break;
      case "epochPerk":
        g.buyEpochPerk(arg);
        break;
      case "era":
        if (confirm(`Start Era ${g.era + 1}? This resets seasons, techs and all progress except amber and ascension perks.`)) g.doEra();
        break;
      case "epoch":
        if (confirm(`Transcend to Epoch ${g.epoch + 1}? This resets everything except Epoch Perks and Epoch Points.`)) g.doEpoch();
        break;
      case "prestige":
        if (g.canEpoch()) this.act("epoch");
        else if (g.canEra()) this.act("era");
        else if (confirm(`Start Season ${g.season + 1}? You keep amber and perks; resources, upgrades and most workers reset.`)) g.prestige();
        break;
      case "route":
        g.connectZones(0, +arg);
        break;
      case "zone":
        if (g.unlockedZones.includes(+arg)) g.switchZone(+arg);
        else g.unlockZone(+arg);
        break;
      case "axe":
        g.equipAxe(arg);
        break;
      case "setting":
        this.handlers.setSetting(arg, el);
        this.dirty = true;
        break;
      case "resetView":
        this.renderer.fitView();
        break;
      default:
        if (this.handlers[a]) this.handlers[a](arg, el);
    }
    this.dirty = true;
  }

  setTab(tab) {
    this.tab = tab;
    this.dirty = true;
    this.shopContent.innerHTML = "";
    this.rows = null;
    this.renderTabs();
    this.shopContent.parentElement.scrollTop = 0;
  }
  renderTabs() {
    const gid = TAB_GROUP[this.tab];
    let h = `<div class="group-tabs">`;
    for (let g of GROUPS)
      h += `<button class="group-tab ${g.id === gid ? "active" : ""}" data-action="group" data-arg="${g.id}"><span>${g.icon}</span>${g.label}</button>`;
    h += `</div><div class="sub-tabs">`;
    for (let [t, label] of GROUPS.find((g) => g.id === gid).tabs)
      h += `<button class="shop-tab ${t === this.tab ? "active" : ""}" data-action="tab" data-arg="${t}">${label}</button>`;
    h += `</div>`;
    $("shopTabs").innerHTML = h;
  }

  // ------------------------------------------------------------ per-frame entry point
  frame(now) {
    if (now - this.lastHud > 200) {
      this.lastHud = now;
      this.updateHud();
      this.updateBanners();
    }
    if (this.dirty || now - this.lastShop > 500) {
      this.lastShop = now;
      this.dirty = false;
      this.renderShop();
      this.renderZones();
    }
  }

  setText(id, v) {
    if (this.hudCache[id] === v) return;
    this.hudCache[id] = v;
    $(id).textContent = v;
  }
  setShown(id, show) {
    const k = id + "#shown";
    if (this.hudCache[k] === show) return;
    this.hudCache[k] = show;
    $(id).hidden = !show;
  }
  updateHud() {
    const g = this.game,
      rt = g.rateTracker;
    const rate = (v) => (v > 0.1 ? `+${v < 10 ? v.toFixed(1) : fmt(v)}/s` : "");
    this.setText("hudLogs", fmt(g.logs));
    this.setText("hudPlanks", fmt(g.planks));
    this.setText("hudGold", fmt(g.gold));
    this.setText("hudCharcoal", fmt(g.charcoal));
    this.setText("hudFurniture", fmt(g.furniture));
    this.setText("hudLuxury", fmt(g.luxury));
    this.setText("hudAmber", fmt(g.amber));
    this.setText("hudEpoch", String(g.epoch));
    this.setText("hudLogsRate", rate(rt.lr));
    this.setText("hudPlanksRate", rate(rt.pr));
    this.setText("hudGoldRate", rate(rt.gr));
    this.setShown("hudCharcoalItem", g.techs.charcoalKiln || g.charcoal > 0);
    this.setShown("hudFurnitureItem", g.techs.furnWorkshop || g.furniture > 0);
    this.setShown("hudLuxuryItem", g.techs.artisanGuild || g.luxury > 0);
    this.setShown("hudAmberItem", g.amber > 0 || g.season > 1 || g.era > 1 || g.epoch > 1);
    this.setShown("hudEpochItem", g.epoch > 1 || g.epochPoints > 0);
    const w = g.curWeather;
    this.setText("hudSeasonIcon", w.icon);
    this.setText("hudSeason", w.name);
    const d = g.dayTime;
    const [tod, ti] = d < 0.2 ? ["Night", "🌙"] : d < 0.3 ? ["Dawn", "🌅"] : d < 0.6 ? ["Day", "☀️"] : d < 0.7 ? ["Afternoon", "🌤️"] : d < 0.8 ? ["Dusk", "🌇"] : ["Night", "🌙"];
    this.setText("hudTime", tod);
    this.setText("hudTimeIcon", ti);
    this.setText("hudProgress", `S${g.season} · E${g.era}`);
  }

  updateBanners() {
    const g = this.game;
    // prestige banner
    let key = "",
      html = "";
    if (g.canEpoch()) (key = "epoch"), (html = "🌌 <b>New Epoch!</b> — Ultimate reset, keep Epoch Perks →");
    else if (g.canEra()) (key = "era"), (html = "⭐ <b>New Era!</b> — Major reset for Era bonuses →");
    else if (g.canPrestige()) (key = "season" + g.amberPerSeason), (html = `🍂 <b>New Season!</b> — Reset for +${g.amberPerSeason} 🔶 Amber →`);
    if (key !== this.bannerKey) {
      this.bannerKey = key;
      const pb = $("prestigeBanner");
      pb.hidden = !key;
      pb.innerHTML = html;
      pb.className = key.replace(/\d+/, "");
    }
    // season progress bar under the banner area
    const req = g.prestigeReq();
    const pct = Math.min(100, (g.totalLogs / req) * 100);
    const pbar = $("seasonProgress");
    pbar.style.setProperty("--p", pct.toFixed(1) + "%");
    this.setText("seasonProgressText", `Season ${g.season}: ${fmt(g.totalLogs)} / ${fmt(req)} logs`);
    // random event banner
    const ev = g.activeEvent;
    const eb = $("eventBanner");
    const evKey = ev ? `${ev.name}|${Math.ceil(ev._timer)}` : "";
    if (this.hudCache.ev !== evKey) {
      this.hudCache.ev = evKey;
      eb.hidden = !ev;
      if (ev) eb.innerHTML = `${ev.icon} <b>${esc(ev.name)}:</b> ${esc(ev.desc)} <span class="ev-time">${Math.ceil(ev._timer)}s</span>`;
    }
  }

  renderZones() {
    const g = this.game;
    let h = "";
    for (let i = 0; i < BIOMES.length; i++) {
      const b = BIOMES[i],
        u = g.unlockedZones.includes(i),
        a = g.currentZone === i;
      const boss = g.zones[i].trees.some((t) => t.alive && t.mutation === "boss");
      h += u
        ? `<button class="zone-tab ${a ? "active" : ""}" data-action="zone" data-arg="${i}">${b.emoji} ${b.name}${boss ? " 💀" : ""}</button>`
        : `<button class="zone-tab locked ${g.gold >= b.cost ? "affordable" : ""}" data-action="zone" data-arg="${i}" title="Unlock ${b.name} for ${fmt(b.cost)} gold">${b.emoji} 🔒 ${fmt(b.cost)}🪙</button>`;
    }
    if (h !== this.zoneHtml) {
      this.zoneHtml = h;
      $("zoneTabs").innerHTML = h;
    }
  }

  /** Replace only the rows whose HTML changed, so clicks aren't eaten by re-renders. */
  renderShop() {
    const rows = this.buildRows();
    const el = this.shopContent;
    const same = this.rows && this.rows.length === rows.length && this.rows.every((r, i) => r.key === rows[i].key);
    if (!same) {
      el.innerHTML = rows.map((r) => r.html).join("");
    } else {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].html === this.rows[i].html) continue;
        const old = el.children[i];
        if (old) old.outerHTML = rows[i].html;
      }
    }
    this.rows = rows;
  }

  buildRows() {
    const g = this.game,
      R = [];
    switch (this.tab) {
      case "upgrades": {
        const secs = {};
        for (let k in UPGRADES) (secs[UPGRADES[k].sec] ??= []).push(k);
        for (let s in secs) {
          R.push(section("s-" + s, SECTION_LABELS[s] || s));
          for (let k of secs[s]) {
            const u = UPGRADES[k],
              lv = g.upgrades[k],
              max = g.maxLevel(k),
              isMax = lv >= max;
            R.push(
              row({
                key: k,
                icon: u.icon,
                name: u.name,
                desc: u.desc,
                cost: isMax ? "MAX" : "🪙 " + fmt(g.uCost(k)),
                level: `Lv ${lv}${isMax || max === Infinity ? "" : "/" + max}`,
                locked: !g.canBuy(k),
                action: "buyUpgrade",
                arg: k,
              }),
            );
          }
        }
        R.push(section("s-sell", "💰 Sell <span class='hint'>(S D F G H)</span>"));
        for (let [res, icon, name, key, vis] of SELLS) {
          if (!vis(g)) continue;
          const have = Math.floor(g[res]);
          const dm = g.demand[res] || 1;
          R.push(
            row({
              key: "sell-" + res,
              icon,
              name: `Sell ${name}`,
              desc: `${fmt(have)} × ${g.sellPrice(res).toFixed(1)}g <span class="${dm >= 1 ? "up" : "down"}">(${dm >= 1 ? "▲" : "▼"} ${dm.toFixed(1)}x demand)</span>`,
              cost: have > 0 ? "🪙 " + fmt(Math.floor(have * g.sellPrice(res))) : "—",
              level: `[${key}]`,
              locked: have <= 0,
              action: "sell",
              arg: res,
            }),
          );
        }
        break;
      }
      case "workers": {
        const c = g.workerCost();
        R.push(
          row({ key: "hire", icon: "👷", name: "Hire Worker", desc: "Choppers fell trees, merchants sell planks at the market, planters tend stumps", cost: "🪙 " + fmt(c), level: `${g.workers.length} hired`, locked: g.gold < c, action: "hire" }),
        );
        const counts = { chopper: 0, merchant: 0, planter: 0 };
        for (let w of g.workers) counts[w.type]++;
        R.push(section("crew", `👥 Crew — 🪓 ${counts.chopper} · 🛒 ${counts.merchant} · 🌱 ${counts.planter}`));
        g.workers.forEach((w, i) => {
          const wt = WORKER_TYPES.find((x) => x.type === w.type);
          const st = { walk: "walking", chop: "chopping", tend: "tending", sell: "selling", idle: "idle" }[w.state] || "";
          R.push({
            key: "w" + i,
            html: `<div class="worker-card" data-key="w${i}"><div class="icon">${wt.icon}</div><div style="flex:1"><div class="wname">${esc(w.name)}</div><div class="wstat">${wt.name} · ⚡${(+w.speed).toFixed(1)} 💪${(+w.power).toFixed(1)}</div></div><div class="wstate">${st}</div></div>`,
          });
        });
        break;
      }
      case "tech": {
        R.push(section("s-tech", "🔬 Research"));
        for (let k in TECH_TREE) {
          const t = TECH_TREE[k],
            done = g.techs[k],
            reqMet = t.req.every((r) => g.techs[r]);
          if (!reqMet && !done)
            R.push(row({ key: k, icon: "❓", name: "???", desc: "Requires: " + t.req.map((r) => TECH_TREE[r].name).join(", "), cost: "🔒", locked: true }));
          else
            R.push(
              row({ key: k, icon: t.icon, name: t.name, desc: t.desc, cost: done ? "✅" : "🪙 " + fmt(g.techCost(k)), locked: !done && !g.canResearch(k), action: done ? "" : "research", arg: k, cls: done ? "done" : "" }),
            );
        }
        break;
      }
      case "trade": {
        R.push(section("s-routes", "🛣️ Trade Routes"));
        R.push(note("n-routes", `Each route from ${BIOMES[0].name} earns 100 🪙/s, even offline.`));
        for (let i = 1; i < BIOMES.length; i++) {
          const b = BIOMES[i],
            conn = g.hasRoute(0, i);
          R.push(
            row({ key: "r" + i, icon: b.emoji, name: b.name, desc: conn ? "Connected" : "Not connected", cost: conn ? "✅" : "🪙 " + fmt(g.tradeRouteCost), locked: !conn && g.gold < g.tradeRouteCost, action: conn ? "" : "route", arg: i, cls: conn ? "done" : "" }),
          );
        }
        R.push(section("s-income", `💰 Trade income: +${fmt(g.getTradeIncome())}/s from ${g.tradeRoutes.length} routes`));
        R.push(section("s-demand", "📊 Market Demand <span class='hint'>(affects manual sales)</span>"));
        for (let r of DEMAND_RESOURCES) {
          const dm = g.demand[r] || 1;
          R.push({ key: "d-" + r, html: `<div class="stat-row" data-key="d-${r}"><span class="slabel">${r}</span><span class="sval ${dm >= 1 ? "up" : "down"}">${dm >= 1 ? "High" : "Low"} ${dm.toFixed(2)}x</span></div>` });
        }
        break;
      }
      case "amber": {
        R.push(section("s-amber", `🔶 Amber: ${fmt(g.amber)}`));
        R.push(note("n-amber", `Era ${g.era} · Season ${g.season} · Next season gives +${g.amberPerSeason} 🔶`));
        if (g.canEra())
          R.push(row({ key: "era", icon: "⭐", name: `Ascend to Era ${g.era + 1}`, desc: "Reset everything. Amber and ascension perks persist.", cost: "Ascend", action: "era", cls: "special gold" }));
        const branches = { speed: "⚡ Speed", yield: "📈 Yield", automation: "🤖 Automation" };
        for (let br in branches) {
          R.push(section("b-" + br, branches[br]));
          for (let n of ASCENSION_TREE.filter((x) => x.branch === br)) {
            const owned = g.ascensionPerks[n.id];
            const reqMissing = n.req.filter((r) => !g.ascensionPerks[r]);
            R.push(
              row({
                key: n.id,
                icon: n.icon,
                name: n.name,
                desc: n.desc + (reqMissing.length && !owned ? ` <span class="down">· needs ${reqMissing.map((r) => ASCENSION_TREE.find((x) => x.id === r).name).join(", ")}</span>` : ""),
                cost: owned ? "✅" : `<span class="amber">🔶 ${n.cost}</span>`,
                locked: !owned && !g.canBuyAscension(n.id),
                action: owned ? "" : "ascension",
                arg: n.id,
                cls: owned ? "done" : "",
              }),
            );
          }
        }
        break;
      }
      case "epoch": {
        R.push(section("s-epoch", `🌌 Epoch ${g.epoch} · ${g.epochPoints} points`));
        R.push(note("n-epoch", g.canEpoch() ? "Ready to transcend!" : `Reach Era ${5 + (g.epoch - 1) * 3} to transcend (now Era ${g.era}). Transcending grants points equal to your Era.`));
        if (g.canEpoch())
          R.push(row({ key: "epoch", icon: "🌌", name: `Transcend to Epoch ${g.epoch + 1}`, desc: "Ultimate reset. Epoch Perks persist.", cost: "Transcend", action: "epoch", cls: "special violet" }));
        R.push(section("s-perks", "✨ Epoch Perks"));
        for (let ep of EPOCH_PERKS) {
          const owned = g.epochPerks[ep.id];
          R.push(
            row({ key: ep.id, icon: ep.icon, name: ep.name, desc: ep.desc, cost: owned ? "✅" : `🌌 ${ep.cost}`, locked: !owned && g.epochPoints < ep.cost, action: owned ? "" : "epochPerk", arg: ep.id, cls: owned ? "done" : "" }),
          );
        }
        break;
      }
      case "cosmetics": {
        R.push(section("s-axe", "🪓 Axe Cosmetics"));
        R.push(note("n-axe", "Unlocked by reaching new eras. Changes your axe colour and chip sparks."));
        for (let ax of AXE_COSMETICS) {
          const unlocked = g.era >= ax.era,
            eq = g.cosmetics.axe === ax.id;
          R.push(
            row({
              key: ax.id,
              icon: `<span class="swatch" style="background:${ax.color}"></span>`,
              name: ax.name,
              desc: unlocked ? (eq ? "Equipped" : "Click to equip") : `Unlocks at Era ${ax.era}`,
              cost: eq ? "✅" : unlocked ? "Equip" : `Era ${ax.era}`,
              locked: !unlocked,
              action: eq ? "" : "axe",
              arg: ax.id,
              cls: eq ? "done" : "",
            }),
          );
        }
        break;
      }
      case "quests": {
        R.push(section("s-q", `📜 Active Quests (${g.stats.questsCompleted} completed)`));
        for (let q of g.quests) R.push(this.questCard("q-" + q.id, q, `Reward: ${q.reward.type === "gold" ? "🪙 " + fmt(q.reward.amount) : "🔶 " + q.reward.amount}`));
        break;
      }
      case "contracts": {
        R.push(section("s-c", `📋 Contracts (${g.stats.contractsCompleted || 0} completed)`));
        for (let c of g.contracts)
          R.push(this.questCard("c-" + c.id, c, `⏱ ${fmtTime(c.timeRemaining)} · Reward: ${c.reward.type === "gold" ? "🪙 " + fmt(c.reward.amount) : "🔶 " + c.reward.amount}`));
        break;
      }
      case "achieve": {
        R.push(section("s-a", `🏆 Achievements (${g.achievementsEarned.length}/${ACHIEVEMENTS.length})`));
        for (let a of ACHIEVEMENTS) {
          const e = g.achievementsEarned.includes(a.id);
          R.push(row({ key: a.id, icon: e ? a.icon : "🔒", name: e ? a.name : "???", desc: a.desc, cost: `<span class="${e ? "up" : ""}">${a.bonus}</span>`, locked: !e }));
        }
        break;
      }
      case "stats": {
        const sr = (l, v) => ({ key: "st-" + l, html: `<div class="stat-row" data-key="st-${l}"><span class="slabel">${l}</span><span class="sval">${v}</span></div>` });
        R.push(section("s-stats", "📊 Stats"));
        R.push(sr("Play Time", fmtTime(g.stats.totalPlayTime)));
        R.push(sr("Epoch / Era / Season", `${g.epoch} / ${g.era} / ${g.season}`));
        R.push(sr("Weather", g.curWeather.name));
        R.push(sr("Chop Power", fmt(g.chopPower)));
        R.push(sr("Crit", `${Math.round(g.critChance * 100)}% × ${g.critMultiplier.toFixed(1)}`));
        R.push(sr("Yield Multiplier", "×" + g.yieldMul.toFixed(2)));
        R.push(sr("Gold Multiplier", "×" + g.goldMul.toFixed(2)));
        R.push(sr("Trees Chopped", fmt(g.stats.treesChopped)));
        R.push(sr("Gold Earned", fmt(g.stats.totalGold)));
        R.push(sr("Amber Earned", fmt(g.stats.totalAmber)));
        R.push(sr("Furniture", fmt(g.stats.furnitureMade)));
        R.push(sr("Luxury Made", fmt(g.stats.luxuryMade)));
        R.push(sr("Crits", fmt(g.stats.crits)));
        R.push(sr("Bosses Defeated", fmt(g.stats.bossesDefeated)));
        R.push(sr("Quests", g.stats.questsCompleted));
        R.push(sr("Events", g.stats.eventsTriggered));
        R.push(sr("Workers", g.workers.length));
        R.push(sr("Techs", Object.values(g.techs).filter(Boolean).length + "/" + Object.keys(TECH_TREE).length));
        R.push(sr("Achievements", g.achievementsEarned.length + "/" + ACHIEVEMENTS.length));
        R.push(section("s-rates", "⚡ Rates"));
        R.push(sr("Logs/s", g.rateTracker.lr.toFixed(2)));
        R.push(sr("Planks/s", g.rateTracker.pr.toFixed(2)));
        R.push(sr("Gold/s", g.rateTracker.gr.toFixed(2)));
        break;
      }
      case "save": {
        R.push(section("s-save", "💾 Export"));
        R.push({
          key: "export",
          html: `<div class="save-area" data-key="export"><textarea id="exportArea" readonly placeholder="Click Generate to create a save code"></textarea><div class="save-btns"><button data-action="genCode">Generate</button><button data-action="copyCode">Copy</button><button data-action="download">Download file</button></div></div>`,
        });
        R.push(section("s-import", "📥 Import"));
        R.push({
          key: "import",
          html: `<div class="save-area" data-key="import"><textarea id="importArea" placeholder="Paste a save code…"></textarea><div class="save-btns"><button data-action="importCode">Import code</button><button data-action="importFile">Load file…</button></div></div>`,
        });
        R.push(section("s-danger", "⚠️ Danger zone"));
        R.push({ key: "reset", html: `<div class="save-area" data-key="reset"><div class="save-btns"><button data-action="saveNow">Save now</button><button class="danger" data-action="newGame">Delete save & restart</button></div></div>` });
        R.push(note("n-save", this.handlers.saveStatus()));
        break;
      }
      case "settings": {
        const s = this.settings;
        const tog = (key, label, on) => ({
          key: "set-" + key,
          html: `<label class="setting" data-key="set-${key}"><span>${label}</span><input type="checkbox" data-action="setting" data-arg="${key}" ${on ? "checked" : ""}></label>`,
        });
        R.push(section("s-set", "⚙️ Settings"));
        R.push(tog("sound", "🔊 Sound effects <span class='hint'>(M)</span>", s.sound));
        R.push({
          key: "set-volume",
          html: `<label class="setting" data-key="set-volume"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-setting="volume"></label>`,
        });
        R.push(tog("damageNumbers", "💥 Damage numbers", s.damageNumbers));
        R.push(tog("lowFx", "🐢 Reduced effects (weather, particles, sway)", s.effects === "low"));
        R.push({ key: "set-view", html: `<div class="save-area" data-key="set-view"><div class="save-btns"><button data-action="resetView">Reset camera <span class='hint'>(0)</span></button><button data-action="changelog">Changelog</button></div></div>` });
        R.push(section("s-controls", "🎮 Controls"));
        R.push(note("n-controls", "Click / tap a tree to chop · Drag to pan · Wheel / pinch or + − to zoom · S D F G H sell · M mute"));
        break;
      }
    }
    return R;
  }
  questCard(key, q, footer) {
    const pct = Math.min(100, Math.floor((q.progress / q.target) * 100));
    return {
      key,
      html: `<div class="quest-card" data-key="${key}"><div class="qname">${esc(q.name)}</div><div class="qdesc">${esc(q.desc)} — ${fmt(q.progress)}/${fmt(q.target)}</div><div class="qprog"><div class="qfill" style="width:${pct}%"></div></div><div class="qreward">${footer}</div></div>`,
    };
  }

  // ------------------------------------------------------------ transient messages
  notify(msg) {
    const el = $("notification");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this._nt);
    this._nt = setTimeout(() => el.classList.remove("show"), 2600);
  }
  toast(html) {
    const el = $("achieveToast");
    el.innerHTML = html;
    el.classList.add("show");
    clearTimeout(this._at);
    this._at = setTimeout(() => el.classList.remove("show"), 3200);
  }

  treeTip(tree, x, y) {
    const tip = $("tooltip");
    if (!tree) {
      tip.hidden = true;
      return;
    }
    const g = this.game,
      T = TREE_TYPES[tree.tier];
    let name = T.name;
    if (tree.mutation === "golden") name = "✨ Golden " + name;
    else if (tree.mutation === "ancient") name = "🏛️ Ancient " + name;
    else if (tree.mutation === "boss") name = "💀 " + (BOSS_TYPES[tree.boss] || BOSS_TYPES[0]).name;
    let h = `<b>${name}</b> <span class="hint">T${tree.tier + 1}</span>`;
    if (g.upgrades.treeScanner > 0 || tree.mutation === "boss") {
      const ym = tree.ym || (tree.mutation === "golden" ? 5 : tree.mutation === "ancient" ? 10 : 1);
      h += `<br>HP ${fmt(Math.max(0, tree.hp))}/${fmt(tree.maxHp)} · ${Math.ceil(tree.hp / Math.max(1, g.chopPower))} hits`;
      h += `<br>Yield ~${fmt(Math.ceil(T.y * g.yieldMul * ym))} 🪵`;
    } else h += `<br><span class="hint">🔍 Tree Scanner reveals HP & yield</span>`;
    tip.innerHTML = h;
    tip.hidden = false;
    const r = tip.parentElement.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 6) + "px";
    tip.style.top = Math.max(6, y - 12) + "px";
  }

  showWelcome(sum) {
    const g = sum.gains;
    const line = (icon, v) => (v >= 1 ? `<div>${icon} +${fmt(v)}</div>` : "");
    let h = `<div class="wb-away">Away for <b>${fmtTime(sum.away)}</b></div>`;
    h += `<div class="wb-note">Your crew worked ${fmtTime(sum.simulated)} at ${Math.round(sum.efficiency * 100)}% efficiency${sum.capped ? " (offline cap reached)" : ""}.</div>`;
    const body =
      line("🌲 trees", sum.trees) + line("🪵", g.logs) + line("🪚", g.planks) + line("🪙", g.gold) + line("🔥", g.charcoal) + line("🪑", g.furniture) + line("✨", g.luxury) + line("🔶", g.amber);
    h += `<div class="wb-stats">${body || "<div>Nothing much happened — hire workers or buy automation to earn while away.</div>"}</div>`;
    if (!this.game.techs.timberNetwork) h += `<div class="hint">Research 🌐 Timber Network for 100% offline progress up to 24h.</div>`;
    $("wbStats").innerHTML = h;
    $("welcomeBack").hidden = false;
  }
  showChangelog() {
    let h = "";
    for (let c of CHANGELOG) h += `<div class="cl-entry"><div class="cl-ver">v${c.ver}</div><ul class="cl-items">${c.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`;
    $("clContent").innerHTML = h;
    $("changelog").hidden = false;
  }
}
