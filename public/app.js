const states = ["Ready", "In Progress", "Human Review", "Done", "Canceled"];
let snapshot = null;
let issues = [];
let logs = [];

document.getElementById("refreshButton").addEventListener("click", refresh);
document.getElementById("pollButton").addEventListener("click", async () => {
  await fetch("/api/poll", { method: "POST" });
  await refresh();
});

setInterval(refresh, 3000);
await refresh();

async function refresh() {
  [snapshot, issues, logs] = await Promise.all([
    fetchJson("/api/state"),
    fetchJson("/api/issues"),
    fetchJson("/api/logs")
  ]);
  renderMetrics();
  renderBoard();
  renderRuntime();
  renderLogs();
}

function renderMetrics() {
  const running = snapshot.claims.length;
  const failures = Object.keys(snapshot.failures).length;
  const dispatchable = issues.filter((issue) => issue.dispatchable && issue.labels.includes("symphony")).length;
  const terminal = issues.filter((issue) => ["Done", "Canceled"].includes(issue.state)).length;
  document.getElementById("metrics").innerHTML = [
    metric("Running claims", running),
    metric("Dispatchable", dispatchable),
    metric("Failures", failures),
    metric("Terminal", terminal)
  ].join("");
}

function renderBoard() {
  const claimByIssue = new Map(snapshot.claims.map((claim) => [claim.issue_id, claim]));
  const failureByIssue = snapshot.failures;
  document.getElementById("board").innerHTML = states.map((state) => {
    const stateIssues = issues.filter((issue) => issue.state === state);
    return `
      <section class="column">
        <header><h2>${escapeHtml(state)}</h2><span class="count">${stateIssues.length}</span></header>
        <div class="cards">
          ${stateIssues.map((issue) => card(issue, claimByIssue.get(issue.id), failureByIssue[issue.id])).join("")}
        </div>
      </section>
    `;
  }).join("");

  document.querySelectorAll("[data-state-select]").forEach((select) => {
    select.addEventListener("change", async (event) => {
      const id = event.target.dataset.issueId;
      await fetch(`/api/issues/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: event.target.value })
      });
      await refresh();
    });
  });

  document.querySelectorAll("[data-retry]").forEach((button) => {
    button.addEventListener("click", async () => {
      await fetch(`/api/retry/${encodeURIComponent(button.dataset.issueId)}`, { method: "POST" });
      await refresh();
    });
  });
}

function card(issue, claim, failure) {
  const classes = ["card"];
  if (claim) classes.push("running");
  if (!issue.dispatchable || issue.blocked_by.length) classes.push("blocked");
  if (failure) classes.push("failed");
  return `
    <article class="${classes.join(" ")}">
      <div class="eyebrow">${escapeHtml(issue.identifier)} · P${issue.priority ?? "-"}</div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="description">${escapeHtml(issue.description || "")}</p>
      <div class="tags">${issue.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")}</div>
      <p class="meta">${issue.dispatchable ? "dispatchable" : "not dispatchable"}${claim ? ` · ${escapeHtml(claim.status)} attempt ${claim.attempt}` : ""}</p>
      ${claim?.codex_live_session?.last_codex_message ? `<p class="meta">${escapeHtml(claim.codex_live_session.last_codex_message)}</p>` : ""}
      ${failure ? `<p class="meta">retry after ${escapeHtml(failure.retry_after || "now")}: ${escapeHtml(failure.last_error || "")}</p>` : ""}
      <div class="card-actions">
        <select data-state-select data-issue-id="${escapeAttr(issue.id)}">
          ${states.map((state) => `<option value="${escapeAttr(state)}" ${state === issue.state ? "selected" : ""}>${escapeHtml(state)}</option>`).join("")}
        </select>
        ${failure ? `<button data-retry data-issue-id="${escapeAttr(issue.id)}">Retry</button>` : ""}
      </div>
    </article>
  `;
}

function renderRuntime() {
  document.getElementById("runtime").textContent = JSON.stringify(snapshot, null, 2);
}

function renderLogs() {
  document.getElementById("logs").innerHTML = logs.slice(-80).reverse().map((log) => `
    <div class="log">
      <strong>${escapeHtml(log.event)}</strong> <span class="meta">${escapeHtml(log.ts)} ${escapeHtml(log.level)}</span>
      <div>${escapeHtml(JSON.stringify(log))}</div>
    </div>
  `).join("");
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed`);
  return response.json();
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
