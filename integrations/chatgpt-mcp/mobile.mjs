// Move original controls for phones, preserving all upstream event handlers.
window.__parleySetupMobile = () => {
  const byId = id => document.getElementById(id);
  const media = matchMedia("(max-width: 760px), (max-width: 960px) and (max-height: 500px)");
  const actions = document.createElement("section");
  actions.id = "mobileRoomActions";
  actions.setAttribute("aria-label", "会话操作");
  const label = document.createElement("div");
  label.textContent = "会话操作"; label.className = "mobile-label";
  actions.append(label);
  byId("sidebar").insertBefore(actions, document.querySelector(".side-foot"));
  const more = document.createElement("details"); more.id = "mobileOptions";
  const summary = document.createElement("summary"); summary.textContent = "更多";
  const options = document.createElement("div"); options.className = "mobile-options-body";
  more.append(summary, options); byId("chipsRow").append(more);
  const moves = [["modeToggle", actions], ["newConvBtn", actions], ["hopWrap", options], ["routeHint", options]]
    .map(([id, destination]) => {
      const node = byId(id), marker = document.createComment("desktop " + id);
      node.before(marker); return { node, marker, destination };
    });
  const close = document.createElement("button"); close.id = "mobileNavClose";
  close.type = "button"; close.textContent = "关闭"; close.setAttribute("aria-label", "关闭会话列表");
  close.onclick = () => { byId("navToggle").click(); byId("navToggle").focus(); };
  document.querySelector(".logo").append(close);
  const layout = () => {
    for (const { node, marker, destination } of moves) {
      if (media.matches) destination.append(node); else marker.after(node);
    }
    if (!media.matches && document.body.classList.contains("nav-open")) byId("navToggle").click();
    more.open = false;
    drawerState();
  };
  const drawerState = () => {
    const closed = media.matches && !document.body.classList.contains("nav-open");
    byId("sidebar").inert = closed;
    byId("sidebar").setAttribute("aria-hidden", String(closed));
  };
  new MutationObserver(drawerState).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => {
    if (media.matches && document.body.classList.contains("nav-open")) byId("navToggle").click();
  }).observe(byId("roomTitle"), { childList: true, subtree: true, characterData: true });
  media.addEventListener("change", layout); layout();
  document.addEventListener("pointerdown", event => {
    if (more.open && !more.contains(event.target) && !event.target.closest("#hopMenu")) more.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") more.open = false;
  });
  // On phones Enter inserts a newline; the send button remains explicit.
  const input = byId("input");
  let desktopPlaceholder = input.placeholder;
  const placeholder = () => {
    if (input.placeholder !== "输入消息…") desktopPlaceholder = input.placeholder;
    const value = media.matches ? "输入消息…" : desktopPlaceholder;
    if (input.placeholder !== value) {
      input.placeholder = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  new MutationObserver(placeholder).observe(input, { attributes: true, attributeFilter: ["placeholder"] });
  media.addEventListener("change", placeholder); placeholder();
  input.addEventListener("keydown", event => {
    if (media.matches && event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.isComposing) {
      event.stopImmediatePropagation();
    }
  }, true);
  const viewport = () => {
    const height = Math.min(innerHeight, window.visualViewport?.height || innerHeight);
    document.documentElement.style.setProperty("--parley-visible-height", height + "px");
  };
  window.visualViewport?.addEventListener("resize", viewport);
  window.addEventListener("resize", viewport); viewport();
};
