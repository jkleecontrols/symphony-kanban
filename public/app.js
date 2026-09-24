const OTHER_COLUMN = "(Other)";

let config = { states: [], active_states: [], terminal_states: [], agents: [], required_labels: [], default_agent: "" };
let snapshot = null;
let issues = [];
let logs = [];

let editingId = null;
let deleteArmedId = null;

const THEMES = ["apple", "pink", "blue"];
const THEME_KEY = "symphony.theme";

const el = (id) => document.getElementById(id);
const boardEl = el("board");
const composerEl = el("composer");
const composerForm = el("composerForm");

applyTheme(storedTheme() || "apple");
el("themes").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-theme-pick]");
  if (pick) applyTheme(pick.dataset.themePick);
});

el("refreshButton").addEventListener("click", () => refresh());
el("pollButton").addEventListener("click", async () => {
  await send("/api/poll", "POST");
  await refresh();
});
el("composerToggle").addEventListener("click", () => toggleComposer(composerEl.hidden));
el("composerCancel").addEventListener("click", () => toggleComposer(false));
composerForm.addEventListener("submit", onComposerSubmit);

boardEl.addEventListener("click", onBoardClick);
boardEl.addEventListener("change", onBoardChange);
boardEl.addEventListener("submit", onBoardSubmit);

config = await fetchJson("/api/config");
fillSelect(composerForm.elements.state, config.active_states.map((state) => ({ value: state, text: state })));
fillSelect(composerForm.elements.agent, agentOptions());
composerForm.elements.agent.value = config.default_agent || "";
el("composerHint").textContent = config.required_labels.length
  ? `Labels ${config.required_labels.join(", ")} are added automatically.`
  : "";

await refresh();
setInterval(() => refresh(), 3000);

async function refresh() {
  try {
    [snapshot, issues, logs] = await Promise.all([
      fetchJson("/api/state"),
      fetchJson("/api/issues"),
      fetchJson("/api/logs")
    ]);
  } catch (error) {
    return showBanner(`Could not load data from the server: ${error.message}`);
  }

  if (editingId && !issues.some((issue) => issue.id === editingId)) editingId = null;
  if (deleteArmedId && !issues.some((issue) => issue.id === deleteArmedId)) deleteArmedId = null;

  renderMetrics();
  el("freezeNotice").hidden = !editingId;
  if (!editingId) renderBoard();
  renderRuntime();
  renderLogs();
}

function toggleComposer(open) {
  composerEl.hidden = !open;
  if (open) composerForm.elements.title.focus();
  else composerForm.reset(), (composerForm.elements.agent.value = config.default_agent || "");
}

async function onComposerSubmit(event) {
  event.preventDefault();
  const form = composerForm.elements;
  const payload = {
    title: form.title.value,
    description: form.description.value || null,
    priority: form.priority.value === "" ? null : Number(form.priority.value),
    state: form.state.value,
    agent: form.agent.value || null,
    labels: parseLabels(form.labels.value),
    workspace_path: form.workspace_path.value.trim() || null,
    dispatchable: form.dispatchable.checked
  };

  try {
    await send("/api/issues", "POST", payload);
  } catch (error) {
    return showBanner(`Could not add the task: ${error.message}`);
  }
  clearBanner();
  composerForm.reset();
  composerForm.elements.agent.value = config.default_agent || "";
  composerForm.elements.title.focus();
  await refresh();
}

async function onBoardClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const { action, issueId } = trigger.dataset;

  if (action === "edit") {
    editingId = issueId;
    deleteArmedId = null;
    renderBoard();
    boardEl.querySelector(`[data-edit-form="${cssEscape(issueId)}"] [name="title"]`)?.focus();
    el("freezeNotice").hidden = false;
    return;
  }

  if (action === "cancel-edit") {
    editingId = null;
    el("freezeNotice").hidden = true;
    return refresh();
  }

  if (action === "arm-delete") {
    deleteArmedId = issueId;
    return renderBoard();
  }

  if (action === "cancel-delete") {
    deleteArmedId = null;
    return renderBoard();
  }

  if (action === "confirm-delete") {
    try {
      await send(`/api/issues/${encodeURIComponent(issueId)}`, "DELETE");
    } catch (error) {
      return showBanner(`Could not delete the task: ${error.message}`);
    }
    clearBanner();
    deleteArmedId = null;
    if (editingId === issueId) editingId = null;
    return refresh();
  }

  if (action === "archive") {
    try {
      await send(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", { state: "Archive" });
    } catch (error) {
      return showBanner(`Could not archive the task: ${error.message}`);
    }
    clearBanner();
    return refresh();
  }

  if (action === "retry") {
    try {
      await send(`/api/retry/${encodeURIComponent(issueId)}`, "POST");
    } catch (error) {
      return showBanner(`Could not retry the task: ${error.message}`);
    }
    return refresh();
  }
}

async function onBoardChange(event) {
  const field = event.target.closest("[data-inline]");
  if (!field) return;
  const { inline, issueId } = field.dataset;
  const body = inline === "state" ? { state: field.value } : { agent: field.value || null };

  try {
    await send(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", body);
  } catch (error) {
    return showBanner(`Could not apply the change: ${error.message}`);
  }
  clearBanner();
  await refresh();
}

async function onBoardSubmit(event) {
  const form = event.target.closest("[data-edit-form]");
  if (!form) return;
  event.preventDefault();
  const issueId = form.dataset.editForm;
  const fields = form.elements;

  try {
    await send(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", {
      title: fields.title.value,
      description: fields.description.value || null,
      priority: fields.priority.value === "" ? null : Number(fields.priority.value),
      labels: parseLabels(fields.labels.value),
      agent: fields.agent.value || null,
      workspace_path: fields.workspace_path.value.trim() || null,
      dispatchable: fields.dispatchable.checked
    });
  } catch (error) {
    return showBanner(`Could not save the task: ${error.message}`);
  }
  clearBanner();
  editingId = null;
  el("freezeNotice").hidden = true;
  await refresh();
}

function renderMetrics() {
  const required = config.required_labels;
  const terminal = new Set(config.terminal_states.map(lower));
  const dispatchable = issues.filter((issue) => issue.dispatchable && required.every((label) => issue.labels.includes(label))).length;
  el("metrics").innerHTML = [
    metric("Tasks", issues.length),
    metric("Running", snapshot.claims.length, snapshot.claims.length > 0),
    metric("Dispatchable", dispatchable),
    metric("Terminal", issues.filter((issue) => terminal.has(lower(issue.state))).length)
  ].join("");
}

function renderBoard() {
  const claimByIssue = new Map(snapshot.claims.map((claim) => [claim.issue_id, claim]));
  const failureByIssue = snapshot.failures;
  const columns = [...config.states];
  const known = new Set(columns.map(lower));
  const leftovers = issues.filter((issue) => !known.has(lower(issue.state)));
  if (leftovers.length) columns.push(OTHER_COLUMN);

  boardEl.innerHTML = columns.map((column) => {
    const columnIssues = column === OTHER_COLUMN
      ? leftovers
      : issues.filter((issue) => lower(issue.state) === lower(column));
    return `
      <section class="column">
        <header><h2>${escapeHtml(column)}</h2><span class="count">${columnIssues.length}</span></header>
        <div class="cards">
          ${columnIssues.map((issue) => card(issue, claimByIssue.get(issue.id), failureByIssue[issue.id])).join("")}
        </div>
      </section>
    `;
  }).join("");
  boardEl.style.setProperty("--columns", String(columns.length));
}

function card(issue, claim, failure) {
  if (editingId === issue.id) return editCard(issue);

  const classes = ["card"];
  if (claim) classes.push("running");
  if (!issue.dispatchable || issue.blocked_by.length) classes.push("blocked");
  if (failure) classes.push("failed");

  const agentName = claim?.codex_live_session?.agent || issue.agent;
  const blockedBy = issue.blocked_by.map((blocker) => blocker.identifier || blocker.id).filter(Boolean);

  return `
    <article class="${classes.join(" ")}">
      <div class="eyebrow">
        ${escapeHtml(issue.identifier)} · P${issue.priority ?? "-"}
        ${agentName ? `<span class="agent-badge">${escapeHtml(agentLabel(agentName))}</span>` : `<span class="agent-badge muted">no AI</span>`}
        ${claim ? '<span class="spinner" role="status" aria-label="session running"></span>' : ""}
      </div>
      <h3>${escapeHtml(issue.title)}</h3>
      ${issue.description ? `<p class="description">${escapeHtml(issue.description)}</p>` : ""}
      ${issue.workspace_path ? `<span class="folder">${escapeHtml(shortenPath(issue.workspace_path))}</span>` : ""}
      <div class="tags">${issue.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")}</div>
      <p class="meta">
        ${issue.dispatchable ? "auto-dispatch on" : "auto-dispatch off"}
        ${claim ? ` · running (${escapeHtml(claim.status)}, attempt ${claim.attempt})` : ""}
        ${blockedBy.length ? ` · blocked by ${escapeHtml(blockedBy.join(", "))}` : ""}
      </p>
      ${claim ? `<p class="meta live"><span class="live-dot"></span>${escapeHtml(claim.codex_live_session?.last_codex_message || "session starting…")}</p>` : ""}
      ${failure ? `<p class="meta error">retry ${escapeHtml(failure.retry_after || "now")}: ${escapeHtml(failure.last_error || "")}</p>` : ""}
      <div class="card-actions">
        <select data-inline="state" data-issue-id="${escapeAttr(issue.id)}" title="State">
          ${config.states.map((state) => `<option value="${escapeAttr(state)}" ${lower(state) === lower(issue.state) ? "selected" : ""}>${escapeHtml(state)}</option>`).join("")}
        </select>
        <select data-inline="agent" data-issue-id="${escapeAttr(issue.id)}" title="Assigned AI">
          <option value="">No AI</option>
          ${agentOptions().map((option) => `<option value="${escapeAttr(option.value)}" ${option.value === issue.agent ? "selected" : ""}>${escapeHtml(option.text)}</option>`).join("")}
        </select>
      </div>
      <div class="card-actions">
        <button type="button" data-action="edit" data-issue-id="${escapeAttr(issue.id)}">Edit</button>
        ${isArchivable(issue) ? `<button type="button" data-action="archive" data-issue-id="${escapeAttr(issue.id)}">Archive</button>` : ""}
        ${failure ? `<button type="button" data-action="retry" data-issue-id="${escapeAttr(issue.id)}">Retry</button>` : ""}
        ${deleteArmedId === issue.id
          ? `<button type="button" class="danger" data-action="confirm-delete" data-issue-id="${escapeAttr(issue.id)}">Delete?</button>
             <button type="button" data-action="cancel-delete" data-issue-id="${escapeAttr(issue.id)}">Cancel</button>`
          : `<button type="button" data-action="arm-delete" data-issue-id="${escapeAttr(issue.id)}">Delete</button>`}
      </div>
    </article>
  `;
}

function editCard(issue) {
  return `
    <article class="card editing">
      <div class="eyebrow">${escapeHtml(issue.identifier)} · editing</div>
      <form data-edit-form="${escapeAttr(issue.id)}" autocomplete="off">
        <label><span>Title</span><input name="title" type="text" value="${escapeAttr(issue.title)}" required></label>
        <label><span>Description</span><textarea name="description" rows="3">${escapeHtml(issue.description || "")}</textarea></label>
        <label><span>Priority</span><input name="priority" type="number" min="1" step="1" value="${issue.priority ?? ""}"></label>
        <label><span>Labels</span><input name="labels" type="text" value="${escapeAttr(issue.labels.join(", "))}"></label>
        <label><span>Project folder</span><input name="workspace_path" type="text" value="${escapeAttr(issue.workspace_path || "")}" placeholder="blank = managed workspace"></label>
        <label><span>Assigned AI</span>
          <select name="agent">
            <option value="">No AI</option>
            ${agentOptions().map((option) => `<option value="${escapeAttr(option.value)}" ${option.value === issue.agent ? "selected" : ""}>${escapeHtml(option.text)}</option>`).join("")}
          </select>
        </label>
        <label class="check"><input name="dispatchable" type="checkbox" ${issue.dispatchable ? "checked" : ""}><span>Auto-dispatch</span></label>
        <div class="card-actions">
          <button type="submit" class="primary">Save</button>
          <button type="button" data-action="cancel-edit" data-issue-id="${escapeAttr(issue.id)}">Cancel</button>
        </div>
      </form>
    </article>
  `;
}

function renderRuntime() {
  el("runtime").textContent = JSON.stringify(snapshot, null, 2);
}

function renderLogs() {
  el("logs").innerHTML = logs.slice(-80).reverse().map((log) => `
    <div class="log">
      <strong>${escapeHtml(log.event)}</strong> <span class="meta">${escapeHtml(log.ts)} ${escapeHtml(log.level)}</span>
      <div>${escapeHtml(JSON.stringify(log))}</div>
    </div>
  `).join("");
}

function isArchivable(issue) {
  const state = lower(issue.state);
  return config.terminal_states.some((terminal) => lower(terminal) === state) && state !== "archive";
}

function agentOptions() {
  return config.agents.map((agent) => ({ value: agent.name, text: agent.label || agent.name }));
}

function agentLabel(name) {
  return config.agents.find((agent) => agent.name === name)?.label || name;
}

function fillSelect(select, options) {
  select.innerHTML = options.map((option) => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.text)}</option>`).join("");
}

function applyTheme(theme) {
  const picked = THEMES.includes(theme) ? theme : "apple";
  document.documentElement.dataset.theme = picked;
  for (const button of el("themes").querySelectorAll("[data-theme-pick]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themePick === picked));
  }
  try {
    localStorage.setItem(THEME_KEY, picked);
  } catch {
    // a private window or blocked storage: the theme just does not persist
  }
}

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function shortenPath(value) {
  return String(value).replace(/^\/Users\/[^/]+/, "~");
}

function parseLabels(value) {
  return String(value ?? "").split(",").map((label) => label.trim()).filter(Boolean);
}

function metric(label, value, live = false) {
  return `<div class="metric${live ? " is-live" : ""}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}${live ? ' <span class="spinner" role="status" aria-label="running"></span>' : ""}</strong>
  </div>`;
}

function showBanner(message) {
  const banner = el("banner");
  banner.textContent = message;
  banner.hidden = false;
}

function clearBanner() {
  el("banner").hidden = true;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await errorText(response, url));
  return response.json();
}

async function send(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await errorText(response, url));
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function errorText(response, url) {
  try {
    const payload = await response.json();
    if (payload?.error) return payload.error;
  } catch {
    // fall through to the status line
  }
  return `${url} ${response.status}`;
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
