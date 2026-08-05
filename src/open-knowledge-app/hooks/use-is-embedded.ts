import { detectEmbeddedHostFromBrowser } from '@ok-core';
import { useState } from 'react';

export function useIsEmbedded(): boolean {
  const [embedded] = useState(() => detectEmbeddedHostFromBrowser() != null);
  return embedded;
}
