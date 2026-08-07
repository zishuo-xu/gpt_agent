import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "./html-text.js";

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
