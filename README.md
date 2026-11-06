# 标签盒

一个帮你管理大量标签页的浏览器扩展（Manifest V3），同时支持 **Google Chrome** 与 **Microsoft Edge**（Chromium 内核）。

## 功能

1. **双工作区**：顶部双向箭头在「标签页管理」和「书签管理」之间切换，记住上次使用的模块。
2. **按域名分组**：弹窗里按域名收拢显示；默认开启**自动分组**，新开同域名标签页会自动并入标签组。
3. **去重方式**：标签页保留原有「自动去重」勾选项，开启时自动关闭较早的重复标签页；关闭后可用底部「关闭重复标签页」先预览、再确认。书签使用「检测 → 预览 → 确认 → 结果」流程，不会自动删除。
4. **快速搜索**：标签页按标题 / 网址 / 域名搜索；书签按标题 / 网址 / 域名 / 文件夹搜索，默认搜索全部书签。`Alt+T` 打开弹窗搜索，`↑↓` 选择，回车打开。
5. **全局快速搜索**：任意网页按 `Alt+K`（Mac 为 `Option+K`）直接打开搜索面板，默认搜索标签页，按 `Tab` 或点击顶部标签切换到书签搜索；打开条目后自动关闭面板。`chrome://` 等无法注入脚本的页面会在独立小窗口中打开同一套搜索面板。快捷键可在 `chrome://extensions/shortcuts` 中修改。
6. **书签浏览**：默认展示全部书签，文件夹与书签分层展示；支持逐级进入、返回上级、文件夹筛选、最近添加 / 名称排序。
7. **批量操作**：标签页可进入选择模式，批量收藏到指定书签文件夹（重复网址默认跳过）或批量关闭；书签可批量移动、删除，并可新建目标文件夹。每个操作都有确认页和逐条结果，失败项可重试。
8. **访问统计与清理**：可按近 1 / 2 / 3 天未访问筛选闲置标签页并关闭；排序有「最新访问优先」和「最久未用优先」。
9. **右键快捷入口**：在网页上右键可看到「标签盒」子菜单，包含快速搜索、分组、关重复、关同域名标签页等。

版本更新交给浏览器扩展商店，扩展本身不检查更新，也不发起任何网络请求。

## 多语言

界面文案、扩展名称与描述支持**中文**和**英文**，默认英文（`_locales/en` 为 `default_locale`）。

- 语言由浏览器的界面语言决定，无需手动切换：中文浏览器显示「标签盒」，其他语言一律显示「Tab Box」。
- 文案在 `_locales/<locale>/messages.json`，`manifest.json` 里用 `__MSG_extName__` 这类占位引用。
- 中文只覆盖 `zh_CN`（简体）。`zh_TW` / `zh_HK` 目前会回落到英文；要支持繁中，加一个 `_locales/zh_TW` 目录即可。
- 新增语言只需要复制一份 `messages.json` 翻译并放进对应目录，代码不用改。

## 安装

推荐从 Release 下载 zip 后解压安装：https://github.com/anliluZoe/tab-box-extension/releases

Release 里有三个 zip，别拿错：

| 文件 | 用途 |
| --- | --- |
| `tab-box-v*.zip` | 给用户手动安装：解压得到 `tab-box` 文件夹 |
| `tab-box-v*-edge-store.zip` | 给商店：`manifest.json` 在根目录，上传 Edge 加载项商店用 |
| `tab-box-v*-chrome-store.zip` | 给商店：`manifest.json` 在根目录，上传 Chrome Web Store 用 |

解压后会得到 `tab-box` 文件夹，加载扩展时选择这个文件夹即可。

### Microsoft Edge

1. 地址栏打开：`edge://extensions/`
2. 打开左下角 **开发人员模式**
3. 点击 **加载解压缩的扩展**
4. 选择解压出的 `tab-box` 文件夹
5. 若失败：看页面顶部红色错误提示，或点扩展卡片里的「错误」查看原因

### Chrome

1. 打开 `chrome://extensions/`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择解压出的 `tab-box` 文件夹

发布到 Chrome Web Store 时，在 [开发者后台](https://chrome.google.com/webstore/devconsole) 的「软件包」页面上传 `tab-box-v*-chrome-store.zip`，更新 listing 后提交审核。

## 打包

需要 PowerShell 7+；Windows 自带的 Windows PowerShell 5.1 也可运行（把命令里的 `pwsh` 换成 `powershell -ExecutionPolicy Bypass`）。

```powershell
# 只打 Chrome Web Store 包
pwsh -File scripts/build-chrome-package.ps1

# 只打 Edge 加载项商店包
pwsh -File scripts/build-edge-package.ps1

# 一次打两个
pwsh -File scripts/build-store-package.ps1 -Browser Both
```

输出在 `dist/`：

- `tab-box-<version>-chrome-store.zip`
- `tab-box-<version>-edge-store.zip`

两个商店包结构相同，`manifest.json` 都在 zip 根目录，可直接上传对应商店。GitHub Actions 在发布时也会自动生成这两个包。

## 说明

- 数据只存在本地，不会上传。书签读写通过 `chrome.bookmarks` 完成，仅在用户确认后执行。
- 新增 `bookmarks` 权限用于书签浏览、搜索、移动、删除和收藏；新增 `favicon` 权限用于在本地读取书签图标，不发起网络请求。
- 全局快速搜索使用 `Alt+K`，需要 `activeTab` + `scripting` 权限：只有在按下快捷键或点击右键入口时，才向当前标签页注入 `quick-search.js`，不申请全站访问权限，也不会在网页中常驻运行。
- `chrome://`、扩展商店、PDF 阅读器等系统页面无法注入内容脚本，此时 `Alt+K` 会打开 `quick-search.html` 独立小窗口，面板与数据源保持一致。
- 标签页去重沿用原有自动去重逻辑；书签去重采用「检测 → 预览 → 确认 → 结果」流程，不会自动删除书签。
- 刚安装时访问次数都是 0，用一段时间后才有参考价值。
- 若标签组 API 不可用，「按域名分组」按钮会自动禁用，搜索和统计仍可用。
