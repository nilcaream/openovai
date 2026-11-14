// The diff view's controls: one file at a time with the list of files beside it, which can be
// hidden; side by side or unified; folds opened one at a time or all at once; next and previous
// change and file. The layout and whether the list is shown are kept in the browser's storage
// (when it has any) and set before the first paint: this runs in the head, before the body.
const DIFF_KEYS = { layout: "openovai-diff-layout", files: "openovai-diff-files", wrap: "openovai-diff-wrap" };

function diffKept(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}

function diffKeep(key, value) {
  try { localStorage.setItem(key, value); } catch (error) {}
}

document.documentElement.classList.toggle("unified", diffKept(DIFF_KEYS.layout) === "unified");
document.documentElement.classList.toggle("no-files", diffKept(DIFF_KEYS.files) === "hidden");
document.documentElement.classList.toggle("no-wrap", diffKept(DIFF_KEYS.wrap) === "off");

document.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  const main = document.querySelector("main.files-shown");
  if (main === null) return;
  const sections = [...main.querySelectorAll("section.file")];
  const links = [...document.querySelectorAll("nav.files a")];
  const position = document.querySelector(".bar .position");
  const layout = document.querySelector(".bar .layout");
  const filesToggle = document.querySelector(".bar .toggle-files");
  const wrap = document.querySelector(".bar .wrap");
  const hscroll = document.querySelector(".hscroll");
  // Where a change is put when it is gone to: this far below the file's head, so a few lines
  // above it show.
  const ABOVE = 48;
  let shown = -1;
  let current = null;

  const pressed = () => {
    layout.setAttribute("aria-pressed", String(root.classList.contains("unified")));
    filesToggle.setAttribute("aria-pressed", String(!root.classList.contains("no-files")));
    wrap.setAttribute("aria-pressed", String(!root.classList.contains("no-wrap")));
    measure();
  };
  pressed();

  // Lines not wrapped: every line of the file shown is moved left by the one scrollbar's position
  // (--x, a transform of each line's span in diff.css), so both sides scroll together, short lines
  // too, as one editor's would. The scrollbar is as wide as the longest line's overflow past the
  // room its cell gives it; a transform does not change a span's width, so nothing is reset first.
  const shift = () => main.style.setProperty("--x", String(hscroll.scrollLeft));
  function measure() {
    if (!root.classList.contains("no-wrap") || shown < 0) {
      hscroll.hidden = true;
      main.style.setProperty("--x", "0");
      return;
    }
    let over = 0;
    let padding = null;
    for (const line of sections[shown].querySelectorAll(root.classList.contains("unified") ? "table.unified td.c > .l" : "table.side td.c > .l")) {
      if (line.offsetParent === null) continue;
      const cell = line.parentElement;
      if (padding === null) {
        const style = getComputedStyle(cell);
        padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      }
      over = Math.max(over, Math.ceil(line.offsetWidth - (cell.clientWidth - padding)));
    }
    hscroll.hidden = over <= 0;
    if (!hscroll.hidden) hscroll.firstElementChild.style.width = `${hscroll.clientWidth + over}px`;
    shift();
  }
  hscroll.addEventListener("scroll", shift);
  new ResizeObserver(() => measure()).observe(main);
  main.addEventListener("wheel", (event) => {
    if (hscroll.hidden) return;
    const across = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    if (across === 0 || (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) return;
    hscroll.scrollLeft += across;
    event.preventDefault();
  }, { passive: false });

  // A section's body, fetched once, the first time it is shown.
  function load(section) {
    const body = section.querySelector(".body");
    if (body.dataset.loading === undefined) {
      body.dataset.loading = "";
      body.textContent = "Loading…";
      body.loaded = fetch(body.dataset.src, { credentials: "same-origin" })
        .then((answer) => answer.text().then((text) => ({ ok: answer.ok, status: answer.status, text })))
        .then(({ ok, status, text }) => {
          body.innerHTML = ok || text.startsWith("<p") ? text : `<p class="note">This file did not load (${status}).</p>`;
        })
        .catch(() => {
          body.innerHTML = `<p class="note">This file did not load: the server did not answer.</p>`;
        });
    }
    return body.loaded;
  }

  async function show(index) {
    if (index < 0 || index >= sections.length) return;
    if (index !== shown) {
      sections.forEach((section, at) => { section.hidden = at !== index; });
      links.forEach((link, at) => link.classList.toggle("active", at === index));
      links[index].scrollIntoView({ block: "nearest" });
      position.textContent = `${index + 1} / ${sections.length}`;
      history.replaceState(null, "", `#f${index + 1}`);
      shown = index;
      if (current !== null) current.classList.remove("current");
      current = null;
      main.scrollTop = 0;
      hscroll.scrollLeft = 0;
    }
    await load(sections[index]);
    measure();
  }

  // The first row of every change in the layout shown, in the file shown.
  const starts = () => [...sections[shown].querySelectorAll(root.classList.contains("unified") ? "table.unified tr.start" : "table.side tr.start")];

  function goTo(row) {
    if (current !== null) current.classList.remove("current");
    current = row;
    row.classList.add("current");
    const head = sections[shown].querySelector(".file-head").getBoundingClientRect().height;
    main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - head - ABOVE;
  }

  // The next or previous change: from the one last gone to while it is on screen, else from what
  // is on screen; past the last in a file, the first of the next file that has one.
  async function change(by) {
    const rows = starts();
    const view = main.getBoundingClientRect();
    const onScreen = current !== null && rows.includes(current) && current.getBoundingClientRect().bottom > view.top && current.getBoundingClientRect().top < view.bottom;
    let target;
    if (onScreen) {
      target = rows[rows.indexOf(current) + by];
    } else {
      const line = view.top + sections[shown].querySelector(".file-head").getBoundingClientRect().height + ABOVE;
      target = by > 0 ? rows.find((row) => row.getBoundingClientRect().top > line + 2) : rows.findLast((row) => row.getBoundingClientRect().top < line - 2);
    }
    if (target !== undefined) {
      goTo(target);
      return;
    }
    for (let index = shown + by; index >= 0 && index < sections.length; index += by) {
      await show(index);
      const next = starts();
      if (next.length > 0) {
        goTo(by > 0 ? next[0] : next.at(-1));
        return;
      }
    }
  }

  function unfold(section, fold, open) {
    for (const body of section.querySelectorAll(`tbody[data-fold="${fold}"]`)) {
      body.hidden = body.classList.contains("fold") ? open : !open;
    }
  }

  function everyFold(open) {
    for (const section of sections) {
      for (const body of section.querySelectorAll("tbody.fold")) unfold(section, body.dataset.fold, open);
    }
    measure();
  }

  document.querySelector(".bar").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button === null) return;
    if (button.dataset.go === "file") show(shown + Number(button.dataset.by));
    else if (button.dataset.go === "change") change(Number(button.dataset.by));
    else if (button.classList.contains("expand")) everyFold(true);
    else if (button.classList.contains("collapse")) everyFold(false);
    else if (button === layout) {
      root.classList.toggle("unified");
      diffKeep(DIFF_KEYS.layout, root.classList.contains("unified") ? "unified" : "side");
      current = null;
      pressed();
    } else if (button === wrap) {
      root.classList.toggle("no-wrap");
      diffKeep(DIFF_KEYS.wrap, root.classList.contains("no-wrap") ? "off" : "on");
      pressed();
    } else if (button === filesToggle) {
      root.classList.toggle("no-files");
      diffKeep(DIFF_KEYS.files, root.classList.contains("no-files") ? "hidden" : "shown");
      pressed();
    }
  });

  document.querySelector("nav.files").addEventListener("click", (event) => {
    const link = event.target.closest("a[data-index]");
    if (link === null) return;
    event.preventDefault();
    show(Number(link.dataset.index));
  });

  main.addEventListener("click", (event) => {
    const button = event.target.closest("button.unfold");
    if (button === null) return;
    unfold(button.closest("section.file"), button.closest("tbody").dataset.fold, true);
    measure();
  });

  // A selection stays on the side it starts on: the other side's code is not selectable meanwhile.
  main.addEventListener("mousedown", (event) => {
    const cell = event.target.closest("table.side td.c");
    if (cell !== null) cell.closest("table").dataset.select = cell.classList.contains("a") ? "a" : "b";
  });

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest("input, textarea, select") !== null) return;
    if (event.key === "n" || (event.key === "F7" && !event.shiftKey)) change(1);
    else if (event.key === "p" || (event.key === "F7" && event.shiftKey)) change(-1);
    else if (event.key === "]") show(shown + 1);
    else if (event.key === "[") show(shown - 1);
    else return;
    event.preventDefault();
  });

  const fromHash = () => {
    const found = /^#f(\d+)$/.exec(location.hash);
    return found === null ? 0 : Math.min(Math.max(Number(found[1]) - 1, 0), sections.length - 1);
  };
  window.addEventListener("hashchange", () => show(fromHash()));
  show(fromHash());
});
