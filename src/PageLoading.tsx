import { useLayoutEffect } from 'react';
import { registerPageLoading } from './page-motion';

// Page content stays behind the shared curtain until this placeholder unmounts.
export default function PageLoading() {
  useLayoutEffect(registerPageLoading, []);
  return null;
}
