# 中国旅行攻略生成器

针对境外游客旅行中国的攻略生成网站。用户填写旅行偏好后，系统结合飞书知识库和 DeepSeek AI 生成 .doc 格式攻略。

## 项目结构

```
travel-guide/
├── frontend/
│   └── index.html          # 前端单页应用（旅行偏好表单 + 下载）
└── backend/
    ├── index.js            # veFaaS 函数入口（串联飞书+DeepSeek+文档生成）
    ├── feishu.js           # 飞书 Base API 封装（动态读取知识库）
    ├── deepseek.js         # DeepSeek API 封装
    ├── docgen.js           # .doc 文档生成
    ├── prompt.js           # 优化后的提示词
    └── package.json
```

## 三个核心改造点

1. **输出 .doc 文档**：后端将 AI 生成的 Markdown 攻略转为带 Word XML 头的 HTML 格式 .doc 文件，Word/WPS 可直接打开
2. **优化提示词**：采用"在中国生活10年的外国旅行作家"角色，强制 5 段式结构（亮点/本地人玩法/独家体验/避坑/实用信息），禁止废话，要求精确数字
3. **飞书知识库接入**：后端实时调用飞书 Base API，动态读取知识库字段和记录，AI 优先采用知识库数据

---

## 配置步骤

### 1. DeepSeek API Key

前往 https://platform.deepseek.com/ 注册并创建 API Key。

### 2. 飞书应用凭证

1. 前往飞书开放平台 https://open.feishu.cn/app 创建"企业自建应用"
2. 获取 **App ID** 和 **App Secret**
3. 在「权限管理」中开通：
   - `bitable:app` （多维表格读取权限）
   - `bitable:app:readonly` （只读多维表格）
4. 在「应用发布」版本中提交审核并发布

### 3. 飞书知识库授权

1. 打开你的知识库：`https://fcnsle06t1xv.feishu.cn/base/CYerbwWeMaPiRYsvoYpc6S4GnTg`
2. 点击右上角「...」→「添加协作者」
3. 搜索你创建的飞书应用名称，添加为协作者，权限选「可阅读」

### 4. 获取 Base Token 和 Table ID

从你的飞书知识库 URL 中提取：
```
https://fcnsle06t1xv.feishu.cn/base/CYerbwWeMaPiRYsvoYpc6S4GnTg?table=tblzg0RT7hJaNd4h&view=vewz3y8Vrf
```
- **App Token (Base Token)**: `CYerbwWeMaPiRYsvoYpc6S4GnTg`
- **Table ID**: `tblzg0RT7hJaNd4h`

---

## 本地运行

### 后端

```bash
cd travel-guide/backend

# 设置环境变量（PowerShell）
$env:DEEPSEEK_API_KEY="你的deepseek key"
$env:FEISHU_APP_ID="你的飞书app_id"
$env:FEISHU_APP_SECRET="你的飞书app_secret"
$env:FEISHU_APP_TOKEN="CYerbwWeMaPiRYsvoYpc6S4GnTg"
$env:FEISHU_TABLE_ID="tblzg0RT7hJaNd4h"

# 启动
node index.js
```

后端运行在 `http://localhost:3000`。

### 前端

直接用浏览器打开 `frontend/index.html`，或在 backend 目录下用任意静态服务器托管 frontend 目录。

前端代码已配置：本地访问时自动请求 `localhost:3000`，部署后同源请求。

---

## 部署到 veFaaS

### 1. 部署后端函数

在 Trae 中加载 veFaaS 技能，将 `backend/` 目录部署为 serverless 函数：
- 运行时：Node.js 18+
- 入口：`index.handler`
- 环境变量配置上述 5 个变量

### 2. 部署前端

将 `frontend/index.html` 部署为静态站点，或在 veFaaS 中作为另一个函数托管。

### 3. 更新前端 API 地址

部署后，编辑 `frontend/index.html`，将 `API_URL` 的部署分支改为你的 veFaaS 函数地址：
```js
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://你的vefaas函数地址';
```

---

## 验证清单

- [ ] 后端启动后，POST `/` 能返回 .doc 文件
- [ ] 飞书知识库读取成功（看后端日志 `[INFO] 读取飞书知识库成功，共 X 条记录`）
- [ ] 生成的 .doc 能用 Word/WPS 打开
- [ ] 攻略内容符合 5 段式结构，含具体数字
- [ ] 前端表单提交后能下载 .doc 文件
