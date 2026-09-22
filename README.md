# 骑马钉小册子 PDF 拼版（Booklet Imposer）

供小型印刷店使用的小册子 PDF 拼版 Web 应用。上传 PDF 后，系统按**每张纸容纳 4 页**的骑马钉规则自动重排页码，提供每张纸正反页序预览，并可下载拼版后的 PDF。支持各页**尺寸或旋转方向不一致**的 PDF：拼版前自动计算统一面板，每页 1:1 居中适配。

技术栈：Node.js + Express + 原生 HTML/CSS/JavaScript + [pdf-lib](https://pdf-lib.js.org/)。

## 拼版规则

- 每张纸正反两面共放置 4 个页面（每面左右各一页）。
- 页数不是 4 的倍数时，在**文档末尾补空白页**后再拼版。
- 页码排列（从外向内，逐层递进）：
  - 第 1 张纸 **正面**：`末页 | 首页`
  - 第 1 张纸 **背面**：`第 2 页 | 倒数第 2 页`
  - 第 2 张纸 **正面**：`倒数第 3 页 | 第 3 页`
  - 第 2 张纸 **背面**：`第 4 页 | 倒数第 4 页`
  - ……依次向内递进。
- 输出纸张为横向，每张纸尺寸 = `2 × 统一面板宽` × `统一面板高`（如 A4 竖版小册子 → A3 横向）。

## 混合尺寸适配

当上传的 PDF 各页尺寸或旋转方向（PDF `/Rotate`，支持页树继承）不一致时：

1. 先读取每页**按 `/Rotate` 转正后**的宽高；
2. 取全部页面「宽的最大值 × 高的最大值」作为**统一面板尺寸**；
3. 每个页面保持原尺寸 **1:1（不缩放）**居中放入对应半区，空余区域透明留白（不填充底色）；带旋转的页面先转正再居中；
4. 页序排列与末尾补白规则完全不变。

所有页面尺寸、方向一致时，统一面板即原始页面尺寸，效果与原先一致。拼版摘要中会显示统一面板尺寸（mm / pt）、采用的面板方向（竖向 / 横向 / 正方形）与每张输出纸尺寸；检测到混合尺寸时还会给出适配说明。

## 一条命令启动（Docker Compose）

需安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up -d --build
```

镜像构建时自动完成 `npm install`，容器启动即服务就绪，无需手动安装依赖。

启动后访问：

```
http://localhost:3000
```

停止：

```bash
docker compose down
```

## 本地运行（不使用 Docker）

要求 Node.js >= 18。

```bash
npm install
npm start
```

然后访问 http://localhost:3000 。

## 配置

通过环境变量配置（在 `docker-compose.yml` 的 `environment` 中修改）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（容器内端口） |
| `MAX_FILE_SIZE_MB` | `50` | 单个上传 PDF 的大小上限（MB） |

如需更换宿主机映射端口，修改 `docker-compose.yml` 中 `ports` 的左侧端口，例如 `"8080:3000"`，然后访问 http://localhost:8080 。

## 使用方式

1. 浏览器打开应用，点击或拖入要拼版的 PDF。
2. 点击「开始拼版」。
3. 查看拼版摘要（原始页数 / 补白页数 / 用纸张数 / 统一面板尺寸 / 面板方向 / 输出纸张尺寸）与每张纸正反面的页码预览；斜纹块表示补的空白页。若检测到页面尺寸或旋转方向不一致，摘要中会出现混合尺寸适配说明。
4. 点击「下载拼版 PDF」保存，文件名自动在原文件名后加 `-拼版` 后缀。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/impose` | multipart 表单字段 `pdf` 上传 PDF；返回拼版 PDF，页序方案在响应头 `X-Imposition-Plan`（URL 编码的 JSON） |
| `GET` | `/api/health` | 健康检查，返回 `{ "ok": true }` |

`X-Imposition-Plan` 在原页序字段基础上新增 `panel` 对象：

```json
{
  "panel": {
    "width": 595.28,
    "height": 841.89,
    "widthMm": 210,
    "heightMm": 297,
    "orientation": "portrait",
    "mixedSize": true
  }
}
```

字段说明：`width`/`height` 为统一面板尺寸（pt，输出每张纸 = `2×width` × `height`）；`widthMm`/`heightMm` 为毫米值（仅用于界面展示）；`orientation` 为 `portrait`（竖向）/ `landscape`（横向）/ `square`（正方形）；`mixedSize` 表示源 PDF 是否存在尺寸或旋转方向不一致的页面。

## 目录结构

```
.
├── server.js            # Express 服务与上传/下载接口
├── lib/impose.js        # 骑马钉页序计算、统一面板计算与 pdf-lib 拼版核心
├── public/              # 原生前端（index.html / style.css / app.js）
├── Dockerfile
├── docker-compose.yml
└── package.json
```
