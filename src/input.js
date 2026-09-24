// Pointer / wheel / keyboard input. Pointer events cover mouse, touch and pen with one code path.
const DRAG_THRESHOLD = 6;

export function bindInput({ canvas, getGame, renderer, ui, sfx, onToggleMute }) {
  const pointers = new Map();
  let pinchDist = 0;
  let panned = false;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const g = getGame();
    if (!g) return;
    sfx.unlock();
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, { ...p, sx: p.x, sy: p.y, button: e.button, moved: false });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    panned = false;
  });

  canvas.addEventListener("pointermove", (e) => {
    const g = getGame();
    if (!g) return;
    const p = local(e);
    const ptr = pointers.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType === "mouse") {
        const t = renderer.pickTree(p.x, p.y);
        renderer.hovered = t;
        ui.treeTip(t, p.x, p.y);
      }
      return;
    }
    const dx = p.x - ptr.x,
      dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    if (Math.abs(p.x - ptr.sx) + Math.abs(p.y - ptr.sy) > DRAG_THRESHOLD) ptr.moved = true;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
      pinchDist = d;
      renderer.pan(dx / 2, dy / 2);
      panned = true;
    } else if (ptr.moved) {
      renderer.pan(dx, dy);
      panned = true;
      ui.treeTip(null);
    }
  });

  const end = (e) => {
    const g = getGame();
    const ptr = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!g || !ptr || e.type === "pointercancel") return;
    if (!ptr.moved && !panned && ptr.button === 0 && pointers.size === 0) {
      const p = local(e);
      const t = renderer.pickTree(p.x, p.y);
      if (t) g.chopTree(t, true);
      if (e.pointerType !== "mouse") {
        renderer.hovered = t;
        ui.treeTip(t, p.x, p.y);
        clearTimeout(end._tip);
        end._tip = setTimeout(() => {
          renderer.hovered = null;
          ui.treeTip(null);
        }, 1400);
      } else ui.treeTip(t, p.x, p.y);
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && !pointers.size) {
      renderer.hovered = null;
      ui.treeTip(null);
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = local(e);
      // trackpad pinch arrives as ctrl+wheel with small deltas
      const k = e.ctrlKey ? 0.01 : 0.0015;
      renderer.zoomAt(p.x, p.y, Math.exp(-e.deltaY * k));
    },
    { passive: false },
  );

  document.addEventListener("keydown", (e) => {
    const g = getGame();
    if (!g || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    const sells = { s: "logs", d: "planks", f: "charcoal", g: "furniture", h: "luxury" };
    if (sells[key]) g.sellAll(sells[key]);
    else if (key === "+" || key === "=") renderer.zoomAt(renderer.W / 2, renderer.H / 2, 1.2);
    else if (key === "-" || key === "_") renderer.zoomAt(renderer.W / 2, renderer.H / 2, 1 / 1.2);
    else if (key === "0") renderer.fitView();
    else if (key === "m") onToggleMute();
    else if (key === "arrowleft") renderer.pan(40, 0);
    else if (key === "arrowright") renderer.pan(-40, 0);
    else if (key === "arrowup") renderer.pan(0, 40);
    else if (key === "arrowdown") renderer.pan(0, -40);
    else return;
    e.preventDefault();
  });
}
