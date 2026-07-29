// Adapted from Lina by SameerJS6 (https://lina.sameer.sh) via Fluid
// Functionalism. Touch-primary devices keep native momentum and rubber-band
// scrolling instead of mounting a custom scrollbar.

import { useEffect, useState } from "react";

export function useTouchPrimary() {
  const [isTouchPrimary, setIsTouchPrimary] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const update = () => {
      const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
      const prefersTouch = window.matchMedia("(pointer: coarse)").matches;
      setIsTouchPrimary(hasTouch && prefersTouch);
    };

    const mediaQuery = window.matchMedia("(pointer: coarse)");
    mediaQuery.addEventListener("change", update, { signal });
    window.addEventListener("pointerdown", update, { signal });
    update();

    return () => controller.abort();
  }, []);

  return isTouchPrimary;
}
