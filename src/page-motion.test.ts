import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cancelPageTransition, getPageMotion, PAGE_COVER_MS, PAGE_REVEAL_MS, PAGE_SWITCH_MIN_MS, pageNavigationCommitted, registerPageLoading, transitionPage } from './page-motion';

function clock(t: TestContext, reduced = false) {
  let now = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: reduced }) } });
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cancelPageTransition();
  pageNavigationCommitted('/');
  const releases: (() => void)[] = [];
  t.after(() => {
    releases.forEach(release => release());
    cancelPageTransition();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return {
    tick(ms: number) { now += ms; t.mock.timers.tick(ms); },
    load() { const release = registerPageLoading(); releases.push(release); return release; },
  };
}

test('initial load hands one curtain from catalog to authentication and all task pages', t => {
  const { tick, load } = clock(t);
  const catalogDone = load();
  const id = getPageMotion()?.id;
  assert.equal(getPageMotion()?.phase, 'waiting');
  tick(2000);
  catalogDone();
  const authDone = load();
  tick(1000);
  authDone();
  const tasksDone = load();
  // Long paginated task loads must not reveal an empty page after 15 seconds.
  tick(30_000);
  assert.equal(getPageMotion()?.id, id);
  assert.equal(getPageMotion()?.phase, 'waiting');
  tasksDone();
  tick(0);
  assert.equal(getPageMotion()?.phase, 'revealing');
  tick(PAGE_REVEAL_MS);
  assert.equal(getPageMotion(), null);
});

test('navigation waits for the route commit and its data before revealing', t => {
  const { tick, load } = clock(t);
  let navigated = false;
  transitionPage(() => { navigated = true; }, '/workbench');
  tick(PAGE_COVER_MS - 1);
  assert.equal(navigated, false);
  tick(1);
  assert.equal(navigated, true);
  tick(3000);
  assert.equal(getPageMotion()?.phase, 'waiting');
  const done = load();
  assert.equal(pageNavigationCommitted('/workbench'), true);
  tick(3000);
  assert.equal(getPageMotion()?.phase, 'waiting');
  done();
  tick(0);
  tick(PAGE_REVEAL_MS);
  assert.equal(getPageMotion(), null);
});

test('fast completion or a rendered error still gets one minimum loading cycle', t => {
  const { tick, load } = clock(t);
  const done = load();
  done();
  tick(PAGE_SWITCH_MIN_MS - PAGE_REVEAL_MS - 1);
  assert.equal(getPageMotion()?.phase, 'waiting');
  tick(1);
  assert.equal(getPageMotion()?.phase, 'revealing');
  tick(PAGE_REVEAL_MS);
  assert.equal(getPageMotion(), null);
});

test('new loading during reveal cancels removal and preserves the curtain', t => {
  const { tick, load } = clock(t);
  load()();
  tick(PAGE_SWITCH_MIN_MS - PAGE_REVEAL_MS);
  const id = getPageMotion()?.id;
  const done = load();
  tick(PAGE_REVEAL_MS + 1000);
  assert.deepEqual(getPageMotion(), { id, phase: 'waiting' });
  done();
  tick(0);
  tick(PAGE_REVEAL_MS);
  assert.equal(getPageMotion(), null);
});

test('a superseded navigation cannot commit its old destination', t => {
  const { tick } = clock(t);
  const commits: string[] = [];
  transitionPage(() => commits.push('old'), '/updates');
  transitionPage(() => { commits.push('new'); pageNavigationCommitted('/workbench'); }, '/workbench');
  tick(PAGE_COVER_MS);
  assert.deepEqual(commits, ['new']);
  tick(PAGE_SWITCH_MIN_MS - PAGE_COVER_MS - PAGE_REVEAL_MS);
  tick(PAGE_REVEAL_MS);
  assert.equal(getPageMotion(), null);
});

test('reduced motion still waits for data without enforcing an animation cycle', t => {
  const { tick, load } = clock(t, true);
  const done = load();
  tick(30_000);
  assert.equal(getPageMotion()?.phase, 'waiting');
  done();
  tick(0);
  assert.equal(getPageMotion(), null);
});
