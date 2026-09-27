// The file view's one control: a web page's "open in browser", which asks the server to hand the
// file to the desktop, as the page's link to it does. The cookie is the page's secret here; when
// the file is not opened, the server's reason is said beside the control.
const opens = document.querySelector("button.opens");
if (opens !== null) {
  const said = opens.nextElementSibling;
  opens.addEventListener("click", async () => {
    said.textContent = "";
    const answered = await fetch(opens.dataset.opens, { method: "POST" }).catch(() => null);
    if (answered?.ok) return;
    said.textContent = answered === null ? "The server did not answer." : ((await answered.json().catch(() => ({}))).error ?? `Not opened (${answered.status}).`);
  });
}
