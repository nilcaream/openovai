// Vendored, unmodified below this line: highlight.js 11.12.0, es/languages/dust.min.js from the npm package @highlightjs/cdn-assets (https://www.npmjs.com/package/@highlightjs/cdn-assets, BSD-3-Clause).
/*! `dust` grammar compiled for Highlight.js 11.12.0 */
var hljsGrammar=(()=>{"use strict";return e=>({name:"Dust",aliases:["dst"],
case_insensitive:!0,subLanguage:"xml",contains:[{className:"template-tag",
begin:/\{[#\/]/,end:/\}/,illegal:/;/,contains:[{className:"name",
begin:/[a-zA-Z\.-]+/,starts:{endsWithParent:!0,relevance:0,
contains:[e.QUOTE_STRING_MODE]}}]},{className:"template-variable",begin:/\{/,
end:/\}/,illegal:/;/,keywords:"if eq ne lt lte gt gte select default math sep"}]
})})();export default hljsGrammar;