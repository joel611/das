// Talks to the local server through the Rust `api` command (it adds the token).
const $ = (id) => document.getElementById(id);
const call = async (method, path, body) => {
  const r = await window.__TAURI__.core.invoke("api", { method, path, body: body === undefined ? null : JSON.stringify(body) });
  if (r.status >= 400) throw new Error(r.body?.error ?? `${method} ${path}: ${r.status}`);
  return r.body;
};
const banner = (msg) => {
  $("banner").hidden = !msg;
  $("banner").textContent = msg ?? "";
};

function showSettings(s) {
  $("roots").value = s.roots.join("\n");
  $("port").value = s.port;
  $("token").placeholder = s.hasToken ? "(set)" : "(none)";
  $("key").placeholder = s.hasOpenrouterKey ? "(set)" : "(none)";
  $("pinned").hidden = !s.envOverrides.length;
  $("pinned").textContent = `Pinned by environment variables (file value ignored): ${s.envOverrides.join(", ")}`;
  $("trust").hidden = !s.trustAdvice;
  $("advice").textContent = s.trustAdvice ?? "";
}

function showHooks(h) {
  const parts = Object.entries(h.events).map(([e, v]) => `${e}: ${v}`);
  $("hooks").textContent = `${h.state}${h.state !== "missing" && !h.portMatches ? " (port differs from settings)" : ""}. ${parts.join(", ")}`;
}

function showDevices(list) {
  const ul = $("devices");
  ul.replaceChildren(
    ...(list.length ? list : [null]).map((d) => {
      const li = document.createElement("li");
      li.textContent = d ? `${d.device} [${d.capabilities.join(", ")}] since ${new Date(d.connectedAt).toLocaleTimeString()}` : "none";
      return li;
    }),
  );
}

async function refresh() {
  try {
    showSettings(await call("GET", "/admin/settings"));
    showHooks(await call("GET", "/admin/hooks"));
    showDevices(await call("GET", "/v1/devices"));
    banner(null);
  } catch (e) {
    banner(`Server not reachable: ${e}`);
  }
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { roots: $("roots").value.split("\n").map((r) => r.trim()).filter(Boolean), port: Number($("port").value) };
  if ($("clearToken").checked) body.token = "";
  else if ($("token").value) body.token = $("token").value;
  if ($("clearKey").checked) body.openrouterKey = "";
  else if ($("key").value) body.openrouterKey = $("key").value;
  try {
    const s = await call("PUT", "/admin/settings", body);
    for (const id of ["token", "key"]) $(id).value = "";
    $("clearToken").checked = $("clearKey").checked = false;
    showSettings(s);
    $("saved").textContent = s.restartRequired ? "Saved. The server restarts on the new port in a moment." : "Saved.";
    banner(null);
  } catch (e) {
    $("saved").textContent = "";
    banner(String(e.message ?? e));
  }
});

for (const [id, method, path] of [["install", "POST", "/admin/hooks/install"], ["uninstall", "DELETE", "/admin/hooks"]]) {
  $(id).addEventListener("click", async () => {
    try {
      showHooks(await call(method, path));
      banner(null);
    } catch (e) {
      banner(String(e.message ?? e));
    }
  });
}

refresh();
setInterval(() => {
  call("GET", "/v1/devices").then(showDevices).catch(() => {});
}, 3000);
