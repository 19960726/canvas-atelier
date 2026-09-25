import type { WheelEvent } from 'react';

const LOCAL_WHEEL_CONTROL = 'input, textarea, select, video[controls], [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]';

export function handleNodeWheelCapture(event: WheelEvent<HTMLElement>): void {
  const target = event.target;
  const node = event.currentTarget;
  // React portals can bubble through the node even when their DOM is outside
  // the canvas (for example, the image detail viewer with its own wheel zoom).
  if (!(target instanceof Element) || !node.contains(target)) return;
  // React Flow already honors explicit boundaries. Let their own wheel
  // handlers run, including the reference tray's horizontal scrolling.
  if (target.closest('.nowheel')) return;
  const control = target.closest(LOCAL_WHEEL_CONTROL);
  if (control !== null && node.contains(control)) {
    event.stopPropagation();
    return;
  }
  for (let element: Element | null = target; element !== null && element !== node; element = element.parentElement) {
    const style = getComputedStyle(element);
    const scrollsY = /^(auto|scroll)$/u.test(style.overflowY || style.overflow) && element.scrollHeight > element.clientHeight;
    const scrollsX = /^(auto|scroll)$/u.test(style.overflowX || style.overflow) && element.scrollWidth > element.clientWidth;
    if (scrollsY || scrollsX) {
      // Leave the browser's default scrolling intact, including at the end of
      // a scrollable prompt or result; it must not turn into a canvas zoom.
      event.stopPropagation();
      return;
    }
  }
}
