// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/ebnf.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `ebnf` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return a=>{const e=a.COMMENT(/\(\*/,/\*\)/)
;return{name:"Extended Backus-Naur Form",illegal:/\S/,contains:[e,{
className:"attribute",begin:/^[ ]*[a-zA-Z]+([\s_-]+[a-zA-Z]+)*/},{begin:/=/,
end:/[.;]/,contains:[e,{className:"meta",begin:/\?.*\?/},{className:"string",
variants:[a.APOS_STRING_MODE,a.QUOTE_STRING_MODE,{begin:"`",end:"`"}]}]}]}}})()
;export default hljsGrammar;