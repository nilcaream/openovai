// The file view's one control: the toggle between the drawn file and its raw text, in place, the
// title and the address as they were. Not kept anywhere: a reload draws the file again.
const toggle = document.querySelector("button.raw-toggle");
if (toggle !== null) {
  const drawn = document.querySelector("main.md");
  const text = document.querySelector("pre.raw");
  toggle.addEventListener("click", () => {
    const showRaw = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(showRaw));
    drawn.hidden = showRaw;
    text.hidden = !showRaw;
  });
}
