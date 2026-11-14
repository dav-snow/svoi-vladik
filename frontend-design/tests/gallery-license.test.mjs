/** Synthetic gallery mapping: licence metadata is kept and unsafe URLs dropped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function harness() {
  const elements = new Map();
  const node = () => ({
    hidden: false, disabled: false, textContent: '', value: '', children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, toggleAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, createElement: node, importNode: value => value, querySelectorAll: () => [] },
    DOMParser: class { parseFromString() { return { documentElement: { setAttribute() {} } }; } },
    window: { isSecureContext: true, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0, clearTimeout() {}, AbortSignal, URL, console,
    location: { href: 'http://127.0.0.1:8000/', origin: 'http://127.0.0.1:8000' },
    innerWidth: 1280, innerHeight: 800,
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  return expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

test('gallery keeps credit, licence and a safe licence URL', () => {
  const run = harness();
  const images = run(`placeGalleryImages([{
    url: '/assets/places/house--1.jpg',
    alt: 'Дом',
    caption: 'старая подпись с URL',
    source_url: 'https://example.com/photo',
    credit: 'LoreMasterTes',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0'
  }], null)`);
  assert.equal(images.length, 1);
  assert.equal(images[0].credit, 'LoreMasterTes');
  assert.equal(images[0].license, 'CC BY-SA 4.0');
  assert.equal(images[0].license_url, 'https://creativecommons.org/licenses/by-sa/4.0');
  assert.equal(images[0].source_url, 'https://example.com/photo');
});

test('gallery drops a non-https licence URL but keeps the rest', () => {
  const run = harness();
  const images = run(`placeGalleryImages([{
    url: '/assets/places/house--1.jpg',
    credit: 'Автор',
    license: 'CC BY-SA 4.0',
    license_url: 'http://creativecommons.org/licenses/by-sa/4.0'
  }], null)`);
  assert.equal(images.length, 1);
  assert.equal(images[0].license_url, null);
  assert.equal(images[0].license, 'CC BY-SA 4.0');
});
