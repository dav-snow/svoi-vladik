(function () {
  "use strict";
  const running = new Set();
  const origins = new WeakMap();
  const closing = new WeakMap();
  let active = null;
  let revision = 0;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = "cubic-bezier(.18,.9,.25,1.08)";

  function visible(node) {
    if (!(node instanceof Element) || !node.isConnected || node === document.body || node.closest("dialog[open]")) return false;
    const rect = node.getBoundingClientRect();
    const css = getComputedStyle(node);
    if (css.visibility === "hidden" || Number(css.opacity) === 0) return false;
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (Number(style.opacity) === 0) return false;
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    return right - left > 3 && bottom - top > 3;
  }
  function radius(node) {
    const rect = node.getBoundingClientRect();
    return Math.min(parseFloat(getComputedStyle(node).borderRadius) || 0, rect.width / 2, rect.height / 2);
  }
  function flip(from, to, corner = 16) {
    const x = Math.max(.02, from.width / Math.max(1, to.width));
    const y = Math.max(.02, from.height / Math.max(1, to.height));
    return { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${x}, ${y})`, transformOrigin: "0 0", borderRadius: `${corner / x}px / ${corner / y}px` };
  }
  function play(node, frames, options) {
    if (reduced() || typeof node.animate !== "function") return null;
    const animation = node.animate(frames, { fill: "both", ...options });
    running.add(animation);
    return animation;
  }
  function release(list) {
    for (const animation of list.filter(Boolean)) { animation.cancel(); running.delete(animation); }
  }
  function cancelRunning() { release([...running]); }
  async function wait(list) {
    await Promise.all(list.filter(Boolean).map(animation => animation.finished.catch(() => {})));
  }
  function children(dialog) { return [...dialog.children]; }
  function fadeOut(snapshot, duration = 80) {
    return snapshot.map(([node, opacity]) => play(node, [{ opacity }, { opacity: 0 }], { duration, easing: "ease-out" }));
  }
  function fadeIn(dialog, delay) {
    return children(dialog).map(node => play(node, [
      { opacity: 0, transform: "translateY(7px)", filter: "blur(2px)" },
      { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" }
    ], { duration: 180, delay, easing: "cubic-bezier(.2,.7,.3,1)" }));
  }
  function focus(node) {
    if (!node?.isConnected || typeof node.focus !== "function") return;
    try { node.focus({ preventScroll: true }); } catch { /* Native focus management remains available. */ }
  }

  async function open(dialog, replaceContentCallback, trigger) {
    if (!dialog?.isConnected || typeof dialog.showModal !== "function") throw new TypeError("SvoiMotion.open expects a connected dialog");
    const old = active?.open ? active : document.querySelector("dialog[open]");
    const supplied = trigger || document.activeElement;
    const origin = visible(supplied) ? supplied : (old ? origins.get(old) : null);
    const source = old?.getBoundingClientRect() || (visible(origin) ? origin.getBoundingClientRect() : null);
    const corner = old ? radius(old) : (visible(origin) ? radius(origin) : 18);
    const oldOpacity = old ? getComputedStyle(old).opacity : 1;
    const contentOpacity = old ? children(old).map(node => [node, getComputedStyle(node).opacity]) : [];
    const ticket = ++revision;
    cancelRunning();
    closing.delete(dialog);
    let outgoing = [];
    if (old) {
      old.dataset.motionPhase = "open";
      const hold = { ...flip(source, old.getBoundingClientRect(), corner), opacity: oldOpacity };
      outgoing = [play(old, [hold, hold], { duration: 80 }), ...fadeOut(contentOpacity)];
      await wait(outgoing);
      if (ticket !== revision) { release(outgoing); return false; }
    }
    try {
      if (typeof replaceContentCallback === "function") replaceContentCallback();
    } catch (error) { release(outgoing); throw error; }
    if (ticket !== revision) { release(outgoing); return false; }
    release(outgoing);
    dialog.classList.add("sv-motion-dialog");
    dialog.dataset.motionKind = old ? "replace" : "enter";
    dialog.dataset.motionPhase = "opening";
    origins.set(dialog, origin);
    active = dialog;
    if (!dialog.open) dialog.showModal();
    const nativeFocus = document.activeElement;
    // Keep a modal in the top layer throughout a dialog-to-dialog replacement.
    if (old && old !== dialog && old.open) {
      old.close();
      delete old.dataset.motionPhase;
      focus(nativeFocus);
    }
    if (!dialog.contains(document.activeElement)) {
      focus(dialog.querySelector("[autofocus], button:not(:disabled), a[href], input, select, textarea, [tabindex='0']") || dialog);
    }
    const target = dialog.getBoundingClientRect();
    const finalRadius = getComputedStyle(dialog).borderRadius;
    const start = source ? flip(source, target, corner) : { transform: "translateY(18px) scale(.97)", transformOrigin: "center", borderRadius: finalRadius };
    const duration = old ? 340 : 440;
    const animations = [play(dialog, [
      { ...start, opacity: source ? .72 : 0, filter: "blur(2px)" },
      { offset: .72, transform: "translateY(-1px) scale(1.004)", transformOrigin: "0 0", borderRadius: finalRadius, opacity: 1, filter: "blur(0px)" },
      { transform: "none", transformOrigin: "0 0", borderRadius: finalRadius, opacity: 1, filter: "blur(0px)" }
    ], { duration, easing: ease }), ...fadeIn(dialog, old ? 75 : 110)];
    await wait(animations);
    release(animations);
    if (ticket !== revision || active !== dialog || !dialog.open) return false;
    dialog.dataset.motionPhase = "open";
    return true;
  }

  function close(dialog) {
    if (!dialog?.open || (active && active !== dialog)) return Promise.resolve(false);
    if (closing.has(dialog)) return closing.get(dialog);
    const ticket = ++revision;
    const source = dialog.getBoundingClientRect();
    const opacity = getComputedStyle(dialog).opacity;
    const corner = radius(dialog);
    const trigger = origins.get(dialog);
    const contentOpacity = children(dialog).map(node => [node, getComputedStyle(node).opacity]);
    cancelRunning();
    dialog.dataset.motionPhase = "closing";
    const natural = dialog.getBoundingClientRect();
    const from = { ...flip(source, natural, corner), opacity, filter: "blur(0px)" };
    const to = visible(trigger)
      ? { ...flip(trigger.getBoundingClientRect(), natural, radius(trigger)), opacity: 0, filter: "blur(3px)" }
      : { transform: "translateY(16px) scale(.98)", transformOrigin: "center", opacity: 0, filter: "blur(2px)" };
    const animations = [play(dialog, [from, to], { duration: 200, easing: "cubic-bezier(.4,0,.8,.25)" }), ...fadeOut(contentOpacity, 100)];
    const pending = (async () => {
      await wait(animations);
      release(animations);
      if (ticket !== revision || active && active !== dialog || !dialog.open) return false;
      dialog.close();
      delete dialog.dataset.motionPhase;
      if (active === dialog) active = null;
      if (visible(trigger)) focus(trigger);
      return true;
    })();
    closing.set(dialog, pending);
    pending.then(() => { if (closing.get(dialog) === pending) closing.delete(dialog); });
    return pending;
  }

  // App owns cancel/Escape, backdrop and close-button handlers; route each to close().
  window.SvoiMotion = Object.freeze({ open, close });
})();
