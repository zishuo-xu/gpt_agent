import assert from "node:assert/strict";
import test from "node:test";
import { htmlToMainText, htmlToText } from "./html-text.js";

test("HTML→文本：剥离 script/style 与注释", () => {
  assert.equal(
    htmlToText(
      "<html><head><style>body{color:red}</style></head><body><p>正文</p>" +
        "<script>alert('x')</script><!-- 注释 --><div>尾部</div></body></html>",
    ),
    "正文\n尾部",
  );
});

test("HTML→文本：块级元素换行、内联标签剥离、实体解码", () => {
  assert.equal(
    htmlToText(
      "<p>第一段</p><p>第二段 <b>加粗</b> &amp; <i>斜体</i></p><ul><li>项一</li><li>项二</li></ul>",
    ),
    "第一段\n第二段 加粗 & 斜体\n项一\n项二",
  );
});

test("HTML→文本：数字实体与空白归一", () => {
  assert.equal(
    htmlToText("<p>a&nbsp;&nbsp;b&#10;c&#x41;</p><p>  首尾空白  </p>"),
    "a b\ncA\n首尾空白",
  );
});

test("HTML→文本：br/hr 换行与连续空行合并", () => {
  assert.equal(
    htmlToText("<div>第一行<br>第二行<br/>第三行</div><div></div><div>第四行</div>"),
    "第一行\n第二行\n第三行\n第四行",
  );
});

test("HTML→文本：空输入与纯文本原样", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText("纯文本 no tags"), "纯文本 no tags");
});

test("htmlToMainText：剥离 nav/header/footer/aside 导航噪音，主内容保留", () => {
  const html =
    "<html><head><title>t</title></head><body>" +
    "<nav><a>首页</a><a>文档</a><a>关于</a></nav>" +
    "<header><h1>站点标题</h1><p>标语</p></header>" +
    "<main><article><h2>正文标题</h2><p>正文第一段，有价值内容。</p></article></main>" +
    "<aside>相关链接 1 相关链接 2</aside>" +
    "<footer>© 2026 版权信息</footer>" +
    "</body></html>";
  const text = htmlToMainText(html);
  assert.match(text, /正文标题/);
  assert.match(text, /正文第一段/);
  assert.doesNotMatch(text, /首页/);
  assert.doesNotMatch(text, /站点标题/);
  assert.doesNotMatch(text, /相关链接/);
  assert.doesNotMatch(text, /版权信息/);
});

test("htmlToMainText：与 htmlToText 的兼容边界（无 chrome 时等价）", () => {
  const plain = "<p>只有正文</p><p>第二段</p>";
  assert.equal(htmlToMainText(plain), htmlToText(plain));
});
