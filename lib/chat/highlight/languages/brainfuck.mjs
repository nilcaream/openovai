// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/brainfuck.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `brainfuck` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>{const a={className:"literal",
begin:/[+-]+/,relevance:0};return{name:"Brainfuck",aliases:["bf"],
contains:[e.COMMENT(/[^\[\]\.,\+\-<> \r\n]/,/[\[\]\.,\+\-<> \r\n]/,{contains:[{
match:/[ ]+[^\[\]\.,\+\-<> \r\n]/,relevance:0}],returnEnd:!0,relevance:0}),{
className:"title",begin:"[\\[\\]]",relevance:0},{className:"string",
begin:"[\\.,]",relevance:0},{begin:/(?=\+\+|--)/,contains:[a]},a]}}})()
;export default hljsGrammar;