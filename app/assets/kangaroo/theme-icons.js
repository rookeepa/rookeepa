// Optional: keep the favicon and Apple icon aligned with <html data-theme>.
// Load this as a module from the pack directory. No dependencies.
const base = new URL('.', import.meta.url);
const preference = window.matchMedia('(prefers-color-scheme: dark)');
function syncIcons() {
  const selected = document.documentElement.dataset.theme;
  const theme = ['light', 'dark'].includes(selected) ? selected : preference.matches ? 'dark' : 'light';
  for (const [id, rel, file, type] of [
    ['kangaroo-favicon', 'icon', 'favicon.ico', 'image/x-icon'],
    ['kangaroo-apple-icon', 'apple-touch-icon', 'app-icon-180.png', 'image/png']
  ]) {
    let link = document.getElementById(id);
    if (!link) { link = document.createElement('link'); link.id = id; document.head.appendChild(link); }
    link.rel = rel; link.type = type; link.href = new URL(`${theme}/${file}`, base).href;
  }
}
new MutationObserver(syncIcons).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
preference.addEventListener('change', syncIcons);
syncIcons();
