// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/tap.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `tap` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>({name:"Test Anything Protocol",
case_insensitive:!0,contains:[e.HASH_COMMENT_MODE,{className:"meta",variants:[{
begin:"^TAP version (\\d+)$"},{begin:"^1\\.\\.(\\d+)$"}]},{begin:/---$/,
end:"\\.\\.\\.$",subLanguage:"yaml",relevance:0},{className:"number",
begin:" (\\d+) "},{className:"symbol",variants:[{begin:"^ok"},{begin:"^not ok"}]
}]})})();export default hljsGrammar;