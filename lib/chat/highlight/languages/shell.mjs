// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/shell.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `shell` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return s=>({name:"Shell Session",
aliases:["console","shellsession"],contains:[{className:"meta.prompt",
begin:/^\s{0,3}[./~\w\d[\]()@-]*[>%$#][ ]?/,starts:{end:/[^\\](?=\s*$)/,
subLanguage:"bash"}}]})})();export default hljsGrammar;