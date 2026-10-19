// The colour scheme of the web UI: light, dark, or auto, which is the system's.
// A classic script in the head of the page, so that the scheme is set before
// the page is first painted and a reload never shows the other one first. It
// sets `data-scheme` on the root element to `light` or `dark`, which the
// stylesheet and the pictures of maps go by, keeps it the system's while the
// choice is auto, and handles the switch at the right of the top bar. The
// choice is kept in this browser alone.

'use strict';

{
  const KEY = 'deorbit-theme';
  const CHOICES = ['light', 'dark', 'auto'];
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: light)');

  // What this browser was last told, or auto where it was told nothing, or where its storage cannot be read, as in some
  // private windows.
  const stored = () => {
    try {
      const choice = localStorage.getItem(KEY);
      return CHOICES.includes(choice) ? choice : 'auto';
    } catch {
      return 'auto';
    }
  };

  // Held here as well, so that a choice that could not be stored still lasts as long as the page.
  let choice = stored();

  const apply = () => {
    const light = choice === 'auto' ? system.matches : choice === 'light';
    root.dataset.scheme = light ? 'light' : 'dark';
    for (const input of document.querySelectorAll('#theme input')) input.checked = input.value === choice;
  };

  apply();
  // The switch is not there yet while the head is read.
  document.addEventListener('DOMContentLoaded', apply);
  system.addEventListener('change', apply);
  document.addEventListener('change', ({ target }) => {
    if (!target.closest?.('#theme') || !CHOICES.includes(target.value)) return;
    choice = target.value;
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // Kept for this page only.
    }
    apply();
  });
  // A choice made in another tab of the page.
  addEventListener('storage', ({ key }) => {
    if (key !== KEY && key !== null) return;
    choice = stored();
    apply();
  });
}
