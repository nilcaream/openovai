// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/php-template.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `php-template` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return n=>({name:"PHP template",
subLanguage:"xml",contains:[{begin:/<\?(php|=)?/,end:/\?>/,subLanguage:"php",
contains:[{begin:"/\\*",end:"\\*/",skip:!0},{begin:'b"',end:'"',skip:!0},{
begin:"b'",end:"'",skip:!0},n.inherit(n.APOS_STRING_MODE,{illegal:null,
className:null,contains:null,skip:!0}),n.inherit(n.QUOTE_STRING_MODE,{
illegal:null,className:null,contains:null,skip:!0})]}]})})()
;export default hljsGrammar;