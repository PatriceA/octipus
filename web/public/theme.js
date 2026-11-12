// Apply the saved palette before the app or its styles paint.
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    let preference = 'system';
    try {
      const saved = localStorage.getItem('octipus-theme');
      if (['light', 'dark', 'system'].includes(saved)) preference = saved;
    } catch (error) { console.warn('Could not read appearance preference', error); }
    const dark = preference === 'dark' || (preference === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101b23' : '#eef1f3');
    window.dispatchEvent(new Event('octipus-theme-applied'));
  }
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => { if (event.key === 'octipus-theme' || event.key === null) apply(); });
  window.addEventListener('octipus-theme-change', apply);
  apply();
})();
