// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/step21.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `step21` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>({name:"STEP Part 21",
aliases:["p21","step","stp"],case_insensitive:!0,keywords:{
$pattern:"[A-Z_][A-Z0-9_.]*",keyword:["HEADER","ENDSEC","DATA"]},contains:[{
className:"meta",begin:"ISO-10303-21;",relevance:10},{className:"meta",
begin:"END-ISO-10303-21;",relevance:10
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,e.COMMENT("/\\*\\*!","\\*/"),e.C_NUMBER_MODE,e.inherit(e.APOS_STRING_MODE,{
illegal:null}),e.inherit(e.QUOTE_STRING_MODE,{illegal:null}),{
className:"string",begin:"'",end:"'"},{className:"symbol",variants:[{begin:"#",
end:"\\d+",illegal:"\\W"}]}]})})();export default hljsGrammar;