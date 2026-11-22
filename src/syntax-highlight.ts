import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diffLang from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const EXT_TO_LANGUAGE: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  pl: "perl",
  plist: "xml",
  pm: "perl",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};


hljs.registerLanguage("bash", bash);

hljs.registerLanguage("c", c);

hljs.registerLanguage("cpp", cpp);

hljs.registerLanguage("csharp", csharp);

hljs.registerLanguage("css", css);

hljs.registerLanguage("diff", diffLang);

hljs.registerLanguage("dockerfile", dockerfile);

hljs.registerLanguage("go", go);

hljs.registerLanguage("ini", ini);

hljs.registerLanguage("java", java);

hljs.registerLanguage("javascript", javascript);

hljs.registerLanguage("json", json);

hljs.registerLanguage("kotlin", kotlin);

hljs.registerLanguage("less", less);

hljs.registerLanguage("lua", lua);

hljs.registerLanguage("makefile", makefile);

hljs.registerLanguage("markdown", markdown);

hljs.registerLanguage("perl", perl);

hljs.registerLanguage("php", php);

hljs.registerLanguage("plaintext", plaintext);

hljs.registerLanguage("python", python);

hljs.registerLanguage("ruby", ruby);

hljs.registerLanguage("rust", rust);

hljs.registerLanguage("scss", scss);

hljs.registerLanguage("sql", sql);

hljs.registerLanguage("swift", swift);

hljs.registerLanguage("typescript", typescript);

hljs.registerLanguage("xml", xml);

hljs.registerLanguage("yaml", yaml);



export default hljs;
