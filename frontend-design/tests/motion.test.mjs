/** Behavioral tests for the production motion controller; no browser or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/motion.js', import.meta.url), 'utf8');

function setup({ reduced = false } = {}) {
  const animations = [], nodes = [];
  let document;
  class Element {
    constructor(kind = 'div', rect = {}) {
      this.kind = kind;
      this.rect = { left: 80, top: 80, width: 120, height: 40, ...rect };
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
      this.dataset = {};
      this.styleValues = { opacity: '1', visibility: 'visible', borderRadius: '16px', overflowX: 'visible', overflowY: 'visible' };
      this.classList = { add() {} };
      this.open = false;
      this.focusCalls = 0;
      this.nativeCloseCalls = 0;
      nodes.push(this);
    }
    getBoundingClientRect() {
      return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
    }
    closest(selector) {
      for (let n = this; n; n = n.parentElement) if (selector === 'dialog[open]' && n.kind === 'dialog' && n.open) return n;
      return null;
    }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelector() { return this.children.find(child => child.kind === 'button') || null; }
    replaceChildren(...children) {
      for (const old of this.children) { old.parentElement = null; old.isConnected = false; }
      this.children = children;
      for (const child of children) { child.parentElement = this; child.isConnected = true; }
    }
    focus() { this.focusCalls++; document.activeElement = this; }
    showModal() { this.open = true; (this.querySelector() || this).focus(); }
    close() { this.open = false; this.nativeCloseCalls++; }
    animate() {
      let resolve, reject;
      const animation = {
        settled: false,
        finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
        finish() { if (!this.settled) { this.settled = true; resolve(); } },
        cancel() { if (!this.settled) { this.settled = true; reject(new Error('Animation cancelled')); } },
      };
      animations.push(animation);
      return animation;
    }
  }
  const body = new Element('body', { left: 0, top: 0, width: 1200, height: 800 });
  const trigger = new Element('button'); trigger.parentElement = body;
  document = {
    body, activeElement: trigger,
    querySelector: () => nodes.find(node => node.kind === 'dialog' && node.open) || null,
  };
  const window = { matchMedia: () => ({ matches: reduced }) };
  const context = vm.createContext({ window, document, Element, getComputedStyle: node => node.styleValues, innerWidth: 1200, innerHeight: 800 });
  vm.runInContext(source, context, { filename: 'motion.js' });
  function dialog() {
    const result = new Element('dialog', { left: 320, top: 160, width: 560, height: 420 });
    result.parentElement = body;
    result.replaceChildren(new Element('button'));
    return result;
  }
  const finishPending = () => animations.filter(a => !a.settled).forEach(a => a.finish());
  // Drain promise jobs only. No real clocks or sleeps; each WAAPI boundary is controlled.
  async function settle(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let turn = 0; turn < 30 && !done; turn++) {
      finishPending();
      for (let job = 0; job < 8; job++) await Promise.resolve();
    }
    assert.equal(done, true, 'motion promise must settle after its animations finish');
    return promise;
  }
  return { motion: window.SvoiMotion, animations, trigger, document, dialog, Element, settle };
}

test('reduced motion opens, replaces and closes without calling animate', async () => {
  const h = setup({ reduced: true }), dialog = h.dialog();
  let content = '';
  assert.equal(await h.settle(h.motion.open(dialog, () => { content = 'first'; }, h.trigger)), true);
  assert.equal(await h.settle(h.motion.open(dialog, () => { content = 'second'; })), true);
  assert.equal(content, 'second');
  assert.equal(await h.settle(h.motion.close(dialog)), true);
  assert.equal(dialog.open, false);
  assert.equal(h.animations.length, 0);
});

test('native modal remains open until the close animations finish', async () => {
  const h = setup(), dialog = h.dialog();
  await h.settle(h.motion.open(dialog, null, h.trigger));
  const closing = h.motion.close(dialog);
  assert.equal(dialog.open, true);
  assert.equal(dialog.nativeCloseCalls, 0);
  assert.equal(dialog.dataset.motionPhase, 'closing');
  assert.equal(await h.settle(closing), true);
  assert.equal(dialog.open, false);
  assert.equal(dialog.nativeCloseCalls, 1);
});

test('rapid close then reopen cannot close the reopened modal', async () => {
  const h = setup(), dialog = h.dialog();
  await h.settle(h.motion.open(dialog, null, h.trigger));
  const closing = h.motion.close(dialog);
  let content = '';
  const reopening = h.motion.open(dialog, () => { content = 'new session'; }, h.trigger);
  assert.equal(await h.settle(reopening), true);
  assert.equal(await closing, false);
  assert.equal(content, 'new session');
  assert.equal(dialog.open, true);
  assert.equal(dialog.nativeCloseCalls, 0);
});

test('latest replacement wins and cancelled replacement callback is never applied', async () => {
  const h = setup(), dialog = h.dialog(), applied = [];
  await h.settle(h.motion.open(dialog, null, h.trigger));
  const stale = h.motion.open(dialog, () => applied.push('stale'));
  const latest = h.motion.open(dialog, () => applied.push('latest'));
  assert.deepEqual(applied, []);
  assert.equal(await h.settle(latest), true);
  assert.equal(await stale, false);
  assert.deepEqual(applied, ['latest']);
  assert.equal(dialog.open, true);
});

test('focus returns to the connected external origin, never a detached or inner trigger', async () => {
  const h = setup(), first = h.dialog(), second = h.dialog();
  await h.settle(h.motion.open(first, null, h.trigger));
  const innerTrigger = first.children[0];
  await h.settle(h.motion.open(second, null, innerTrigger));
  const innerBeforeClose = innerTrigger.focusCalls;
  await h.settle(h.motion.close(second));
  assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.trigger.focusCalls, 1);
  assert.equal(innerTrigger.focusCalls, innerBeforeClose);

  const detached = setup(), dialog = detached.dialog();
  await detached.settle(detached.motion.open(dialog, null, detached.trigger));
  detached.trigger.isConnected = false;
  await detached.settle(detached.motion.close(dialog));
  assert.equal(detached.trigger.focusCalls, 0);
});
