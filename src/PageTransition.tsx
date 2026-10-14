import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Link, useLinkClickHandler, useResolvedPath, type LinkProps } from 'react-router-dom';
import LoadingIndicator from './LoadingIndicator';
import { cancelPageTransition, getPageMotion, PAGE_COVER_MS, PAGE_REVEAL_MS, pageNavigationCommitted, subscribePageMotion, transitionPage } from './page-motion';

export default function PageTransition({ pageKey, pathname, children }: { pageKey: string; pathname: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const previous = useRef({ pageKey, pathname });
  const motion = useSyncExternalStore(subscribePageMotion, getPageMotion);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { pageKey, pathname };
    const expected = pageNavigationCommitted(pathname);
    // History navigation has already committed; cover before the next paint.
    if (before.pageKey !== pageKey && !expected) {
      transitionPage(() => {}, pathname, true);
    }
  }, [pageKey, pathname]);
  useLayoutEffect(() => {
    if (element.current) element.current.inert = Boolean(motion);
  }, [motion]);
  useLayoutEffect(() => cancelPageTransition, []);
  return <>
    <div className="page-transition" ref={element} aria-busy={Boolean(motion)}>{children}</div>
    {motion && <div key={motion.id} className="page-curtain" data-phase={motion.phase}
      style={{ '--page-cover-duration': `${PAGE_COVER_MS}ms`, '--page-reveal-duration': `${PAGE_REVEAL_MS}ms` } as CSSProperties}>
      <LoadingIndicator />
    </div>}
  </>;
}

export function PageLink({ to, onClick, target, replace, state, preventScrollReset, relative, ...props }: LinkProps) {
  const destination = useResolvedPath(to, { relative });
  const navigate = useLinkClickHandler(to, { target, replace, state, preventScrollReset, relative });
  return <Link {...props} to={to} target={target} replace={replace} state={state} preventScrollReset={preventScrollReset} relative={relative} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (target && target !== '_self') || props.download) return;
    event.preventDefault();
    transitionPage(() => navigate(event), destination.pathname);
  }} />;
}
