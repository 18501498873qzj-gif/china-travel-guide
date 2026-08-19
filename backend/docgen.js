// .doc 文档生成模块
// 将 Markdown 攻略内容转换为 Word 可打开的 .doc 文件
// 采用 HTML 包装 + Word XML 头的方式，生成 Word 能直接打开的 .doc（无需第三方二进制依赖）

// 将 Markdown 转为简单 HTML（支持标题、加粗、列表、段落）
function markdownToHtml(md) {
  const lines = md.split('\n');
  const html = [];
  let inList = false;

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }
    // 标题
    if (trimmed.startsWith('### ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) { html.push('<ul>'); inList = true; }
      // 处理加粗
      let content = escapeHtml(trimmed.slice(2));
      content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html.push(`<li>${content}</li>`);
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      // 处理加粗
      let content = escapeHtml(trimmed);
      content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html.push(`<p>${content}</p>`);
    }
  }
  if (inList) html.push('</ul>');
  return html.join('\n');
}

// 生成 .doc 文件内容（Word 可打开的 HTML 格式，带 Word XML 命名空间）
function generateDoc(markdownContent, title = '中国旅行攻略') {
  const bodyHtml = markdownToHtml(markdownContent);
  const doc = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${title}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
@page { size: A4; margin: 2.54cm; }
body { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; font-size: 11pt; line-height: 1.6; color: #333; }
h1 { font-size: 20pt; color: #1a1a1a; border-bottom: 2pt solid #333; padding-bottom: 4pt; margin-top: 18pt; }
h2 { font-size: 15pt; color: #c0392b; margin-top: 16pt; }
h3 { font-size: 12pt; color: #2c3e50; margin-top: 12pt; }
p { margin: 4pt 0; }
ul { margin: 4pt 0 4pt 18pt; }
li { margin: 2pt 0; }
strong { color: #c0392b; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  return doc;
}

module.exports = { generateDoc, markdownToHtml };
