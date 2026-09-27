// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/profile.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `profile` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>({name:"Python profiler",
contains:[e.C_NUMBER_MODE,{begin:"[a-zA-Z_][\\da-zA-Z_]+\\.[\\da-zA-Z_]{1,3}",
end:":",excludeEnd:!0},{begin:"(ncalls|tottime|cumtime)",end:"$",
keywords:"ncalls tottime|10 cumtime|10 filename",relevance:10},{
begin:"function calls",end:"$",contains:[e.C_NUMBER_MODE],relevance:10
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,{className:"string",begin:"\\(",
end:"\\)$",excludeBegin:!0,excludeEnd:!0,relevance:0}]})})()
;export default hljsGrammar;