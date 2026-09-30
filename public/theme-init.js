// Apply the saved choice before the page paints. Storage may be unavailable.
(() => {
  let theme = "light";
  try { if (localStorage.getItem("campus-theme-v1") === "dark") theme = "dark"; } catch { /* use light */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
