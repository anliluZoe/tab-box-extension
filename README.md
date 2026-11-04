# 标签盒

一个帮你管理大量标签页的浏览器扩展（Manifest V3），同时支持 **Google Chrome** 与 **Microsoft Edge**（Chromium 内核）。

## 功能

1. **按域名分组**：弹窗里按域名收拢显示；默认开启**自动分组**，新开同域名标签页会自动并入标签组。
2. **自动去重**：默认开启。出现相同网址时会关掉更早打开的标签页，保留刚打开的那一个。
3. **快速搜索**：按标题 / 网址 / 域名搜索；`Alt+T` 打开，`↑↓` 选择，回车跳转。
4. **访问统计与清理**：可按近 1 / 2 / 3 天未访问筛选闲置标签页并一键关闭。排序有「最新访问优先」和「最久未用优先」，按最后访问时间把最近用过的或最久没用的排在前面。
5. **右键快捷入口**：在网页上右键可看到「标签盒」子菜单，直接分组、关重复、关同域名标签页等。

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

- 数据只存在本地，不会上传。
- 刚安装时访问次数都是 0，用一段时间后才有参考价值。
- 若标签组 API 不可用，「按域名分组」按钮会自动禁用，搜索和统计仍可用。
