const NS = "http://www.w3.org/2000/svg";
const CARD_X = 650;
const CARD_W = 250;
const ROW = 82;
const ROLE_W = 104;

function svg(tag, attrs = {}, label = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (label != null) node.textContent = label;
  return node;
}

function short(value, length = 28) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function projectName(value) {
  return value ? value.split("/").filter(Boolean).at(-1) || value : "Unassigned project";
}

function point(event, canvas) {
  const box = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - box.left) * canvas.viewBox.baseVal.width / box.width,
    y: (event.clientY - box.top) * canvas.viewBox.baseVal.height / box.height
  };
}

function linkPath(from, to, lane) {
  const out = CARD_X + CARD_W + 12;
  const bend = out + 48 + lane * 24;
  return `M ${out} ${from} C ${bend} ${from}, ${bend} ${to}, ${out} ${to}`;
}

// Within a thread, a card sits below everything it depends on, so arrows run downwards
// and a plan reads above the work that carries it out.
export function orderCards(cards) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const depths = new Map();
  const depthOf = (card, seen = new Set()) => {
    if (depths.has(card.id)) return depths.get(card.id);
    if (seen.has(card.id)) return 0;
    seen.add(card.id);
    const blockers = (card.blocked_by || []).map((blocker) => byId.get(blocker.id)).filter(Boolean);
    const depth = blockers.length ? 1 + Math.max(...blockers.map((blocker) => depthOf(blocker, seen))) : 0;
    depths.set(card.id, depth);
    return depth;
  };
  return [...cards].sort((a, b) => depthOf(a) - depthOf(b) || a.title.localeCompare(b.title));
}

export function createGraph(host, { onConnect, onRemove, onThreadDrop, onRole, onError }) {
  let drag = null;

  function render(issues, { project = "", liveIds = new Set(), agents = new Map(), roles = [] } = {}) {
    // Redrawing would close a role menu the user has open.
    if (drag || host.querySelector("select:focus")) return;
    const visible = project ? issues.filter((issue) => issue.project === project) : issues;
    const groups = new Map();
    for (const issue of visible) {
      const key = issue.project || "";
      if (!groups.has(key)) groups.set(key, new Map());
      const threads = groups.get(key);
      const thread = issue.thread || "";
      if (!threads.has(thread)) threads.set(thread, []);
      threads.get(thread).push(issue);
    }

    const positions = new Map();
    const rows = [];
    const threadRows = [];
    const projectRows = [];
    let y = 66;
    for (const [name, threads] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const first = y;
      for (const [thread, cards] of [...threads].sort(([a], [b]) => a.localeCompare(b))) {
        const start = y;
        for (const issue of orderCards(cards)) {
          positions.set(issue.id, y);
          rows.push({ issue, y, thread, project: name });
          y += ROW;
        }
        if (thread) threadRows.push({ project: name, thread, y: (start + y - ROW) / 2 });
        y += 16;
      }
      projectRows.push({ project: name, y: (first + y - ROW - 16) / 2 });
      y += 32;
    }

    const height = Math.max(420, y + 40);
    const width = 1130;
    host.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "graph-empty";
      empty.textContent = "No cards in this project.";
      host.append(empty);
      return;
    }
    const help = document.createElement("p");
    help.className = "graph-help";
    help.textContent = "Drag the dot on a card to another card to set a dependency. Click an arrow to remove it. Drag a card onto a thread to move it.";
    host.append(help);
    const canvas = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": "Project, thread and task dependencies" });
    const defs = svg("defs");
    const marker = svg("marker", { id: "graph-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "graph-arrowhead" }));
    defs.append(marker);
    canvas.append(defs);
    const hierarchy = svg("g", { class: "graph-hierarchy" });
    const projectAt = new Map(projectRows.map((row) => [row.project, row.y]));
    const threadAt = new Map(threadRows.map((row) => [`${row.project}\0${row.thread}`, row.y]));
    for (const row of threadRows) {
      hierarchy.append(svg("path", { d: `M 250 ${projectAt.get(row.project)} C 280 ${projectAt.get(row.project)}, 270 ${row.y}, 300 ${row.y}` }));
    }
    for (const row of rows) {
      const fromX = row.thread ? 540 : 250;
      const fromY = row.thread ? threadAt.get(`${row.project}\0${row.thread}`) : projectAt.get(row.project);
      hierarchy.append(svg("path", { d: `M ${fromX} ${fromY} C ${fromX + 40} ${fromY}, ${CARD_X - 40} ${row.y}, ${CARD_X} ${row.y}` }));
    }
    canvas.append(hierarchy);

    const dependencies = svg("g", { class: "graph-dependencies" });
    let lane = 0;
    const byId = new Map(visible.map((issue) => [issue.id, issue]));
    for (const target of visible) for (const blocker of target.blocked_by || []) {
      const source = byId.get(blocker.id);
      if (!source || !positions.has(target.id)) continue;
      const d = linkPath(positions.get(source.id), positions.get(target.id), lane++ % 7);
      dependencies.append(svg("path", { d, class: "graph-dependency", "marker-end": "url(#graph-arrow)" }));
      const hit = svg("path", { d, class: "graph-dependency-hit", "data-source": source.id, "data-target": target.id, tabindex: 0, role: "button", "aria-label": `Remove dependency: ${source.title} before ${target.title}` });
      hit.append(svg("title", {}, `Remove dependency: ${source.title} → ${target.title}`));
      dependencies.append(hit);
    }
    canvas.append(dependencies);

    for (const row of projectRows) {
      const node = svg("g", { class: "graph-node graph-project" });
      node.append(svg("rect", { x: 30, y: row.y - 25, width: 220, height: 50, rx: 12 }));
      node.append(svg("text", { x: 44, y: row.y + 5 }, short(projectName(row.project), 23)));
      node.append(svg("title", {}, row.project || "Unassigned project"));
      canvas.append(node);
    }
    for (const row of threadRows) {
      const node = svg("g", { class: "graph-node graph-thread", "data-thread": row.thread, "data-project": row.project });
      node.append(svg("rect", { x: 300, y: row.y - 25, width: 240, height: 50, rx: 12 }));
      node.append(svg("text", { x: 315, y: row.y + 5 }, short(row.thread, 24)));
      node.append(svg("title", {}, `Thread: ${row.thread}. Drop a card here to move it.`));
      canvas.append(node);
    }
    for (const row of rows) {
      const { issue } = row;
      const node = svg("g", { class: "graph-node graph-card", "data-card": issue.id });
      node.append(svg("rect", { x: CARD_X, y: row.y - 29, width: CARD_W, height: 58, rx: 12 }));
      node.append(svg("circle", { cx: CARD_X + 15, cy: row.y - 12, r: 5, class: liveIds.has(issue.id) ? "graph-live" : `graph-state-${issue.state.toLowerCase().replace(/[^a-z]+/g, "-")}` }));
      node.append(svg("text", { x: CARD_X + 28, y: row.y - 8, class: "graph-card-title" }, short(issue.title, 28)));
      // What this session is for: a menu on the card's top edge, so it costs the title no room.
      const frame = svg("foreignObject", { x: CARD_X + CARD_W - 24 - ROLE_W, y: row.y - 40, width: ROLE_W, height: 22 });
      const select = document.createElement("select");
      select.className = issue.role ? "graph-role" : "graph-role graph-role-unset";
      select.dataset.role = issue.id;
      select.title = `Role of ${issue.title}`;
      for (const role of ["", ...new Set([...roles, issue.role].filter(Boolean))]) {
        const option = document.createElement("option");
        option.value = role;
        option.textContent = role || "role…";
        option.selected = role === (issue.role || "");
        select.append(option);
      }
      frame.append(select);
      node.append(frame);
      node.append(svg("text", { x: CARD_X + 15, y: row.y + 14, class: "graph-card-meta" }, short([issue.identifier, agents.get(issue.id) || issue.agent, issue.branch_name].filter(Boolean).join(" · "), 39)));
      node.append(svg("circle", { cx: CARD_X + CARD_W, cy: row.y, r: 10, class: "graph-handle", "data-handle": issue.id, role: "button", "aria-label": `Draw dependency from ${issue.title}` }));
      node.append(svg("title", {}, `${issue.title}${issue.role ? ` (${issue.role})` : ""} — drag card to a thread, or drag the handle to another card`));
      canvas.append(node);
    }
    const preview = svg("path", { class: "graph-preview", hidden: "" });
    canvas.append(preview);
    host.append(canvas);

    canvas.addEventListener("pointerdown", (event) => {
      if (event.target.closest("select")) return;
      const handle = event.target.closest("[data-handle]");
      const card = event.target.closest("[data-card]");
      if (!handle && !card) return;
      drag = { type: handle ? "link" : "card", source: (handle || card).dataset.handle || card.dataset.card, pointerId: event.pointerId, start: point(event, canvas), moved: false };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const here = point(event, canvas);
      if (Math.hypot(here.x - drag.start.x, here.y - drag.start.y) > 8) drag.moved = true;
      if (drag.type === "link" && drag.moved) {
        preview.removeAttribute("hidden");
        preview.setAttribute("d", `M ${CARD_X + CARD_W + 10} ${positions.get(drag.source)} L ${here.x} ${here.y}`);
      }
    });
    canvas.addEventListener("pointerup", async (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const operation = drag;
      drag = null;
      preview.setAttribute("hidden", "");
      if (!operation.moved) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const card = target?.closest?.("[data-card]");
      const thread = target?.closest?.("[data-thread]");
      try {
        if (operation.type === "link" && card && card.dataset.card !== operation.source) await onConnect(operation.source, card.dataset.card);
        if (operation.type === "card" && thread) await onThreadDrop(operation.source, thread.dataset.thread, thread.dataset.project);
      } catch (error) { onError(error); }
    });
    canvas.addEventListener("pointercancel", () => { drag = null; preview.setAttribute("hidden", ""); });
    canvas.addEventListener("click", async (event) => {
      const hit = event.target.closest("[data-source][data-target]");
      if (!hit) return;
      try { await onRemove(hit.dataset.source, hit.dataset.target); }
      catch (error) { onError(error); }
    });
    canvas.addEventListener("change", async (event) => {
      const select = event.target.closest("[data-role]");
      if (!select) return;
      select.blur();
      try { await onRole(select.dataset.role, select.value); }
      catch (error) { onError(error); }
    });
    canvas.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const hit = event.target.closest("[data-source][data-target]");
      if (!hit) return;
      event.preventDefault();
      try { await onRemove(hit.dataset.source, hit.dataset.target); }
      catch (error) { onError(error); }
    });
  }

  return { render };
}
