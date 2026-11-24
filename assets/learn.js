/* learn.js — the search box above the glossary on the Learn page. */

Site.pages.learn = function () {
  const input = Site.el("gl-filter");
  if (!input) return;
  const items = [...document.querySelectorAll(".glossary > div")];
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const item of items) {
      const hit = !q || item.textContent.toLowerCase().includes(q);
      item.hidden = !hit;
      if (hit) shown++;
    }
    Site.el("gl-empty").hidden = shown > 0;
  });
};
