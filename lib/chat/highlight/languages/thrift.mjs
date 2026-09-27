// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/thrift.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `thrift` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>{
const t=["bool","byte","i16","i32","i64","double","string","binary"];return{
name:"Thrift",keywords:{
keyword:["namespace","const","typedef","struct","enum","service","exception","void","oneway","set","list","map","required","optional"],
type:t,literal:"true false"},
contains:[e.QUOTE_STRING_MODE,e.NUMBER_MODE,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{
className:"class",beginKeywords:"struct enum service exception",end:/\{/,
illegal:/\n/,contains:[e.inherit(e.TITLE_MODE,{starts:{endsWithParent:!0,
excludeEnd:!0}})]},{begin:"\\b(set|list|map)\\s*<",keywords:{
type:[...t,"set","list","map"]},end:">",contains:["self"]}]}}})()
;export default hljsGrammar;