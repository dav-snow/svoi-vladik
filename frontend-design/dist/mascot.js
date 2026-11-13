(function () {
  "use strict";

  const scriptURL = document.currentScript ? document.currentScript.src : document.baseURI;
  const assetBase = new URL("assets/mascot/", scriptURL);
  const states = Object.freeze({
    "location-unknown": [800, 666],
    "interesting-places": [800, 666],
    "talking": [700, 800],
    "directions": [731, 800],
    "surprised": [700, 800],
    "first-visit": [800, 800]
  });

  function safeState(state) {
    return typeof state === "string" && Object.hasOwn(states, state) ? state : "talking";
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text ?? "");
    return node;
  }

  function assignImage(img, state) {
    const id = safeState(state);
    img.src = new URL(id + ".webp", assetBase).href;
    img.width = states[id][0];
    img.height = states[id][1];
    img.dataset.mascotState = id;
    return img;
  }

  function image(state, className = "") {
    const img = element("img", "svoi-mascot-image" + (className ? " " + className : ""));
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.dataset.mascotImage = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    return assignImage(img, state);
  }

  function setState(container, state) {
    if (!container) return null;
    const img = container.tagName === "IMG" ? container : container.querySelector?.("[data-mascot-image]");
    if (!img) return null;
    const id = safeState(state);
    if (img.dataset.mascotState === id) return img;
    assignImage(img, id);
    if (container.dataset) container.dataset.mascotState = id;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion && typeof img.animate === "function") {
      img.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
    }
    return img;
  }

  function show(state, title, text, actions = []) {
    const panel = element("section", "svoi-mascot-panel");
    panel.dataset.mascotState = safeState(state);

    const figure = element("div", "svoi-mascot-figure");
    figure.setAttribute("aria-hidden", "true");
    const artwork = image(state);
    artwork.loading = "eager";
    figure.append(artwork);

    const copy = element("div", "svoi-mascot-copy");
    copy.append(
      element("p", "svoi-mascot-eyebrow", "ГИД ПО ЛЕНИНСКОМУ"),
      element("h2", "svoi-mascot-title", title),
      element("p", "svoi-mascot-text", text)
    );
    panel.append(figure, copy);

    if (Array.isArray(actions)) {
      const controls = element("div", "svoi-mascot-actions");
      for (const action of actions) {
        if (!action || typeof action.label !== "string" || typeof action.run !== "function") continue;
        const control = element("button", "svoi-mascot-action" + (action.primary === true ? " is-primary" : ""), action.label);
        control.type = "button";
        control.addEventListener("click", () => action.run());
        controls.append(control);
      }
      if (controls.childElementCount) panel.append(controls);
    }
    return panel;
  }

  window.SvoiMascot = Object.freeze({
    image,
    setState,
    show,
    renderCard: show,
    states: Object.freeze(Object.keys(states))
  });
})();
