/** Screen geometry only: no map, network, storage, timers or device location. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function selectedMapAnchor(');
const end = source.indexOf('function selectPlace(', start);
assert.ok(start >= 0 && end > start);
const helpers = source.slice(start, end);
const load = globals => vm.runInNewContext(helpers + '\n({selectedMapAnchor,selectedMapCamera})', globals);
const { selectedMapAnchor } = load({});

// Measured mobile acceptance case: progress on the left, zoom on the right,
// attribution above the sheet. Only the lane below zoom fits the selected pin.
const mobileObstacles = [
  { left: 12, top: 72, right: 306, bottom: 393 },
  { left: 322, top: 80, right: 378, bottom: 234 },
  { left: 326, top: 12, right: 378, bottom: 64 },
  { left: 12, top: 16, right: 306, bottom: 56 },
  { left: 0, top: 445, right: 390, bottom: 742 },
  { left: 278, top: 404, right: 390, bottom: 430 },
];

test('mobile journey selects the free lane below zoom with room for a 46px pin', () => {
  const point = selectedMapAnchor(390, 742, mobileObstacles);
  assert.equal(point.x, 348); assert.equal(point.y, 319);
  for (const rect of mobileObstacles) {
    const gap = 46 / 2 + 7;
    assert.ok(point.x <= rect.left - gap || point.x >= rect.right + gap || point.y <= rect.top - gap || point.y >= rect.bottom + gap);
  }
});

test('desktop keeps the large clear map center and ignores off-map or empty obstacles', () => {
  const point = selectedMapAnchor(1440, 900, [
    { left: 20, top: 650, right: 420, bottom: 820 },
    { left: 1360, top: 80, right: 1416, bottom: 234 },
    { left: 1200, top: 810, right: 1416, bottom: 874 },
    { left: -400, top: 0, right: -10, bottom: 900 },
    { left: 600, top: 300, right: 600, bottom: 600 },
  ]);
  assert.equal(point.x, 720); assert.equal(point.y, 450);
});

test('a fully covered or too small viewport offers no unsafe anchor', () => {
  assert.equal(selectedMapAnchor(390, 742, [{ left: 0, top: 0, right: 390, bottom: 742 }]), null);
  assert.equal(selectedMapAnchor(60, 100, []), null);
  assert.equal(selectedMapAnchor(390, 0, []), null);
});

function node(rect, options = {}) {
  return {
    hidden: options.hidden || false,
    style: { display: options.display || 'block', visibility: options.visibility || 'visible', opacity: options.opacity ?? '1' },
    getClientRects: () => options.noRects ? [] : [rect],
    getBoundingClientRect: () => ({ ...rect, width: rect.width ?? rect.right - rect.left, height: rect.height ?? rect.bottom - rect.top }),
  };
}

test('DOM adapter ignores hidden overlays and compensates the bottom-anchored pin label', () => {
  const frame = { left: 100, top: 80, right: 490, bottom: 822, width: 390, height: 742 };
  const shift = rect => ({ left: rect.left + frame.left, top: rect.top + frame.top, right: rect.right + frame.left, bottom: rect.bottom + frame.top });
  const full = shift({ left: 0, top: 0, right: 390, bottom: 742 });
  const overlays = [...mobileObstacles.map(rect => node(shift(rect))), node(full, { hidden: true }), node(full, { display: 'none' }), node(full, { visibility: 'hidden' }), node(full, { opacity: '0' }), node(full, { noRects: true }), node({ ...full, width: 0 })];
  // Long two-line label: the coordinate at pin.bottom lies 75px below the bubble.
  const bubble = node({ left: 542, top: 300, right: 588, bottom: 346 });
  const pin = node({ left: 500, top: 300, right: 630, bottom: 398 });
  pin.querySelector = () => bubble;
  const { selectedMapCamera } = load({ ui: { map: node(frame) }, state: { markers: new Map([['public-place', { getElement: () => pin }]]) }, document: { querySelectorAll: () => overlays }, getComputedStyle: n => n.style });
  const camera = selectedMapCamera({ id: 'public-place' });
  // The projected public coordinate moves down by the label height, keeping
  // the actual bubble center at the free anchor rather than under zoom.
  assert.equal(camera.offset[0] + frame.width / 2, 348);
  assert.equal(camera.offset[1] + frame.height / 2 - 75, 319);
  assert.deepEqual(JSON.parse(JSON.stringify(camera.padding)), { top: 0, bottom: 0, left: 0, right: 0 });
});

test('DOM adapter requests the existing camera fallback when the marker cannot be measured', () => {
  const { selectedMapCamera } = load({ ui: { map: node({ left: 0, top: 0, right: 390, bottom: 742 }) }, state: { markers: new Map() }, document: { querySelectorAll: () => [] } });
  assert.equal(selectedMapCamera({ id: 'not-yet-rendered' }), null);
});
