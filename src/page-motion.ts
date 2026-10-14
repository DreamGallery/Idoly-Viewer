import { flushSync } from 'react-dom';

export const LOADING_CYCLE_MS = 1600;
export const PAGE_SWITCH_MIN_MS = LOADING_CYCLE_MS;
export const PAGE_COVER_MS = 240;
export const PAGE_REVEAL_MS = 280;
type Motion = { id: number; phase: 'covering' | 'waiting' | 'revealing' };
type Timer = ReturnType<typeof setTimeout>;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let motion: Motion | null = null;
let sequence = 0;
let committing = false;
let renderedPath = '';
let destination = '';
let awaitingCommit = false;
let startedAt = 0;
let minimumDuration = PAGE_SWITCH_MIN_MS;
let revealDuration = PAGE_REVEAL_MS;
let navigationTimer: Timer | undefined;
let revealTimer: Timer | undefined;
let finishTimer: Timer | undefined;
const listeners = new Set<() => void>();
const loading = new Set<symbol>();

export const getPageMotion = () => motion;
export const hasPageTransition = () => motion !== null;
export function pageNavigationCommitted(pathname: string) {
  const expected = motion !== null && (committing || destination === pathname);
  renderedPath = pathname;
  if (expected) { awaitingCommit = false; revealWhenReady(); }
  return expected;
}
export function subscribePageMotion(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: Motion | null) {
  motion = next;
  listeners.forEach(listener => listener());
}
function clearTimers() {
  clearTimeout(navigationTimer);
  clearTimeout(revealTimer);
  clearTimeout(finishTimer);
}
export function cancelPageTransition() {
  ++sequence;
  clearTimers();
  awaitingCommit = false;
  publish(null);
}
function revealWhenReady() {
  clearTimeout(revealTimer);
  // Keep the same curtain through lazy modules, authentication and paginated data.
  // Failed requests release their loading token when the page renders its error.
  if (motion?.phase !== 'waiting' || awaitingCommit || loading.size) return;
  const id = motion.id;
  const elapsed = performance.now() - startedAt;
  const remaining = Math.max(0, minimumDuration - revealDuration - elapsed);
  revealTimer = setTimeout(() => {
    if (motion?.id !== id || motion.phase !== 'waiting') return;
    publish({ ...motion, phase: 'revealing' });
    finishTimer = setTimeout(() => { if (motion?.id === id) publish(null); }, revealDuration);
  }, remaining);
}
export function registerPageLoading() {
  const token = Symbol();
  loading.add(token);
  if (!motion) {
    startedAt = performance.now();
    const reduced = prefersReducedMotion();
    minimumDuration = reduced ? 0 : PAGE_SWITCH_MIN_MS;
    revealDuration = reduced ? 0 : PAGE_REVEAL_MS;
    destination = renderedPath;
    awaitingCommit = false;
    publish({ id: ++sequence, phase: 'waiting' });
  } else if (motion.phase === 'revealing') {
    clearTimeout(finishTimer);
    publish({ ...motion, phase: 'waiting' });
  }
  revealWhenReady();
  return () => { loading.delete(token); revealWhenReady(); };
}

export function transitionPage(update: () => void, pathname: string, alreadyCovered = false) {
  clearTimers();
  const id = ++sequence;
  destination = pathname;
  awaitingCommit = pathname !== renderedPath;
  startedAt = performance.now();
  const reduced = prefersReducedMotion();
  minimumDuration = reduced ? 0 : PAGE_SWITCH_MIN_MS;
  revealDuration = reduced ? 0 : PAGE_REVEAL_MS;
  publish({ id, phase: alreadyCovered || reduced ? 'waiting' : 'covering' });
  navigationTimer = setTimeout(() => {
    if (motion?.id !== id) return;
    // Route changes happen only after the curtain covers the old content.
    committing = true;
    try { flushSync(update); } finally { committing = false; }
    if (motion?.id !== id) return;
    publish({ ...motion, phase: 'waiting' });
    revealWhenReady();
  }, alreadyCovered || reduced ? 0 : PAGE_COVER_MS);
}
