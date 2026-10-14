# 课代表

把一节课收成一份能复习的笔记。支持粘贴 B 站链接、文字稿或字幕文件，并用你自己的大模型接口来整理。

## 能做什么

- 读取 B 站视频字幕；读不到时可以改贴文字稿，或导入 SRT、VTT、ASS、TXT。
- 三种笔记：课堂笔记、精简速览、考前复习。
- 笔记里可以继续向课代表提问，也可以换成另一种整理方式。
- 复制或下载 Markdown。
- 模型名称、接口和历史笔记保存在这台电脑上，换浏览器也能用。

## 本地运行

需要 Node.js 18 或更高版本。

```bash
node server.mjs
```

然后打开 http://127.0.0.1:8787 。

右上角进入「模型」，填写：

- 接口地址，填到 `/v1`，例如 `https://api.deepseek.com/v1`。只填 `https://api.deepseek.com` 也可以。
- API Key。本机模型（如 Ollama）可以留空。
- 模型名，例如 `deepseek-flash`、`deepseek-chat`。

接口需要兼容 OpenAI Chat Completions。密钥和笔记写在项目下的 `data/store.json`，这个文件不会进入版本库。

`deepseek-flash` 默认会先思考。课代表会请它直接作答；如果正文写在思考内容里，也会读出来。

## 安装包

安装包自带 Node.js，装好后不用再装运行环境。

| 系统 | 文件 |
| --- | --- |
| Macintosh（Apple 芯片和 Intel） | `dist/课代表-mac.dmg` |
| Windows 64 位，以及 ARM 版 Windows | `dist/课代表-windows-setup.exe` |

Mac：打开镜像，把「课代表」拖进「应用程序」再双击。如果系统提示无法验证开发者，按住 Control 点按应用，选择「打开」。

Windows：双击安装程序。如果出现 SmartScreen，选择「仍要运行」。安装不需要管理员权限，完成后桌面有「课代表」快捷方式。安装包不支持只有 32 位的老 Windows。

安装后的笔记和模型设置不在项目目录里：

- Mac：`~/Library/Application Support/课代表`
- Windows：`%APPDATA%\课代表`

在本机重新打安装包：

```bash
node scripts/build-packages.mjs
```

打 Windows 安装包还需要本机有 [NSIS](https://nsis.sourceforge.io/)（`makensis`）。Mac 打包使用系统自带的 `hdiutil` 和 `iconutil`。

## 项目结构

- `server.mjs`：本地服务，转发模型请求，并读取 B 站字幕。
- `lib.mjs`：笔记结构和模型回复的整理。
- `public/`：页面。
- `scripts/build-packages.mjs`：打包 Mac 和 Windows 安装包。
