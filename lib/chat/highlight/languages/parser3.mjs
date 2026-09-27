// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/parser3.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `parser3` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>{const a=e.COMMENT(/\{/,/\}/,{
contains:["self"]});return{name:"Parser3",subLanguage:"xml",relevance:0,
contains:[e.COMMENT("^#","$"),e.COMMENT(/\^rem\{/,/\}/,{relevance:10,
contains:[a]}),{className:"meta",begin:"^@(?:BASE|USE|CLASS|OPTIONS)$",
relevance:10},{className:"title",
begin:"@[\\w\\-]+\\[[\\w^;\\-]*\\](?:\\[[\\w^;\\-]*\\])?(?:.*)$"},{
className:"variable",begin:/\$\{?[\w\-.:]+\}?/},{className:"keyword",
begin:/\^[\w\-.:]+/},{className:"number",begin:"\\^#[0-9a-fA-F]+"
},e.C_NUMBER_MODE]}}})();export default hljsGrammar;