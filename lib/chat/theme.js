// The file view's theme, the one the page keeps: dark when the page was left dark, light otherwise.
// A file of its own because the view allows no inline script.
try { document.documentElement.dataset.theme = localStorage.getItem("openovai-theme") === "dark" ? "dark" : "light"; }
catch (error) { document.documentElement.dataset.theme = "light"; }
