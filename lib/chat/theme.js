// The file view's theme, the one the page keeps: dark when the page was left dark, light otherwise,
// and the theme-color meta repainted from the head bubble's ground, as the page does, so an
// installed app's title bar follows. Run after the stylesheets, which is what makes that ground
// known here. A file of its own because the view allows no inline script.
try { document.documentElement.dataset.theme = localStorage.getItem("openovai-theme") === "dark" ? "dark" : "light"; }
catch (error) { document.documentElement.dataset.theme = "light"; }
const themeMeta = document.querySelector('meta[name="theme-color"]');
themeMeta.content = getComputedStyle(document.documentElement).getPropertyValue("--panel-2").trim() || themeMeta.content;
