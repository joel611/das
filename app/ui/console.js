// Typed stand-in for speech. Talks to the local server through the Rust `api` command (it adds the token).
const $ = (id) => document.getElementById(id);
const call = async (method, path, body) => {
  const r = await window.__TAURI__.core.invoke("api", { method, path, body: body === undefined ? null : JSON.stringify(body) });
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status}`);
  return r.body;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let device = "console";
let projects = [];

function drawProjects() {
  const q = $("filter").value.toLowerCase();
  const ul = $("projects");
  ul.replaceChildren();
  for (const p of projects.filter((p) => (p.name + p.path).toLowerCase().includes(q))) {
    const li = el("li");
    li.append(el("div", "", p.name), el("div", "meta", p.path));
    ul.append(li);
  }
  if (!ul.children.length) ul.append(el("li", "meta", projects.length ? "no match" : "none"));
}
$("filter").oninput = drawProjects;

async function refresh() {
  const info = $("srv");
  info.replaceChildren();
  try {
    projects = await call("GET", "/v1/projects");
  } catch (e) {
    projects = [];
    info.append(el("div", "warn-t", "Cannot load projects: " + e.message));
  }
  drawProjects();
  try {
    const s = await call("GET", "/admin/settings");
    info.append(el("div", s.hasOpenrouterKey ? "" : "warn-t", s.hasOpenrouterKey ? "OpenRouter key: set" : "OpenRouter key: NOT set (requests will error)"));
  } catch {}
  try {
    const st = await call("GET", "/v1/state");
    info.append(el("div", st.untrustedProjects ? "warn-t" : "", st.untrustedProjects ? st.untrustedProjects + " project(s) not trusted by Claude: real spawns there will fail" : "All listed projects trusted"));
  } catch {}
}

function bars(probs) {
  const box = el("div");
  for (const [name, p] of Object.entries(probs)) {
    const b = el("div", "bar");
    const t = el("div", "t");
    const i = el("i");
    i.style.width = Math.round(p * 100) + "%";
    t.append(i);
    b.append(el("span", "n", name), t, el("span", "", p.toFixed(2)));
    box.append(b);
  }
  return box;
}

const scrollDown = () => ($("log").scrollTop = $("log").scrollHeight);

function addYou(text) {
  const t = el("div", "turn you");
  t.append(el("span", "", text));
  $("log").append(t);
  scrollDown();
}

function addBot(r, ms, dry) {
  const t = el("div", "turn bot");
  const head = el("div");
  head.append(el("span", "tag " + r.status, r.status), document.createTextNode(" "), el("span", "say", r.text || ""));
  t.append(head);
  const m = [];
  if (r.project) m.push("project: " + r.project);
  if (r.sessionId) m.push("sessionId: " + r.sessionId);
  m.push(ms + " ms" + (dry ? " (dry run)" : ""));
  t.append(el("div", "meta", m.join(" | ")));
  const d = r.debug;
  if (d) {
    const box = el("div", "dbg");
    box.append(el("div", "", `choice: ${d.choice ?? "none"} | confidence: ${d.confidence.toFixed(2)} | band: ${d.band}`));
    box.append(bars(d.probabilities || {}));
    box.append(el("div", "meta", `thresholds: act ${d.thresholds.act}, ask ${d.thresholds.ask}`));
    box.append(el("div", "meta", `cwd: ${d.cwd ?? "-"}`));
    box.append(el("div", "meta", `worktree: ${d.worktree ?? "(project main)"}${d.name ? " | new worktree name: " + d.name : ""}`));
    box.append(el("div", "meta", `wouldSpawn: ${d.wouldSpawn}`));
    t.append(box);
  }
  $("log").append(t);
  scrollDown();
}

const syncWarn = () => ($("warn").hidden = $("dry").checked);
$("dry").onchange = () => {
  syncWarn();
  $("confirm").hidden = true;
};
syncWarn();

async function run(text, dry) {
  addYou(text);
  $("send").disabled = true;
  const t0 = performance.now();
  try {
    const body = await call("POST", "/v1/voice", { text, device, dryRun: dry, debug: dry });
    addBot(body, Math.round(performance.now() - t0), dry);
  } catch (e) {
    addBot({ status: "error", text: String(e.message) }, Math.round(performance.now() - t0), dry);
  } finally {
    $("send").disabled = false;
    $("text").focus();
  }
}

// A real send needs a second, explicit click (inline, since native dialogs are not reliable in the webview).
let pendingReal = null;
function send() {
  const text = $("text").value.trim();
  if (!text || $("send").disabled) return;
  if ($("dry").checked) {
    $("text").value = "";
    run(text, true);
    return;
  }
  pendingReal = text;
  $("confirm-text").textContent = text;
  $("confirm").hidden = false;
  $("confirm").scrollIntoView({ block: "nearest" }); // never leave the safety prompt off-screen
}
$("confirm-yes").onclick = () => {
  const text = pendingReal;
  pendingReal = null;
  $("confirm").hidden = true;
  if (text && !$("dry").checked) {
    $("text").value = "";
    run(text, false);
  }
};
$("confirm-no").onclick = () => {
  pendingReal = null;
  $("confirm").hidden = true;
};

$("send").onclick = send;
$("text").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
};
$("newconv").onclick = () => {
  device = "console-" + Math.random().toString(36).slice(2, 8);
  $("log").replaceChildren();
  $("dev").textContent = "device: " + device;
};
$("dev").textContent = "device: " + device;
refresh();
