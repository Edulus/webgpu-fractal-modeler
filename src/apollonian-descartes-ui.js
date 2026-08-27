// Browser-only compatibility for the canonical Apollonian / Descartes packing.
//
// Numeric id 8 still uses the historical internal key `penrose` so every shape
// id after it remains stable. The selector and wall note now live directly in
// index.html and are covered by the registry tests, so this module must not
// create or rewrite either of them. Its only remaining job is to keep the old
// internal key out of the HUD until the renderer's public shape metadata is
// generated from one registry.

const INTERNAL_KEY = 'penrose';
const PUBLIC_HUD = 'apollonian-descartes';

export function installApollonianDescartesUI() {
  if (typeof document === 'undefined') return;

  const install = () => {
    const select = document.getElementById('sel-fractal');
    const hud = document.getElementById('hud');
    if (!select || !hud || typeof MutationObserver === 'undefined') return;

    const syncHudName = () => {
      const text = hud.textContent || '';
      if (select.value === INTERNAL_KEY && text.startsWith(`${INTERNAL_KEY} ·`)) {
        hud.textContent = PUBLIC_HUD + text.slice(INTERNAL_KEY.length);
      }
    };

    new MutationObserver(syncHudName).observe(hud, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    syncHudName();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
