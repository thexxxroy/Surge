# Surge

自用的 Surge 模块。以下链接可直接在 Surge 中安装。

## 模块

| 模块 | 说明 | 安装 |
| --- | --- | --- |
| [Netflix 豆瓣 / IMDb 评分](modules/netflix-ratings/) | 在 Netflix 网页版详情页显示豆瓣与 IMDb 评分。开箱即用,填入免费的 OMDb API Key 后可额外显示 IMDb 评分。**仅支持网页端** | [安装](surge:///install-module?url=https://raw.githubusercontent.com/thexxxroy/Surge/refs/heads/main/modules/netflix-ratings/netflix-ratings.sgmodule) · [源文件](https://raw.githubusercontent.com/thexxxroy/Surge/refs/heads/main/modules/netflix-ratings/netflix-ratings.sgmodule) |
| [菜鸟开屏广告补丁](modules/cainiao-splash-fix.sgmodule) | 拦截菜鸟裹裹开屏广告依赖的穿山甲、优量汇等广告 SDK 域名。纯规则,无需 MITM | [安装](surge:///install-module?url=https://raw.githubusercontent.com/thexxxroy/Surge/refs/heads/main/modules/cainiao-splash-fix.sgmodule) · [源文件](https://raw.githubusercontent.com/thexxxroy/Surge/refs/heads/main/modules/cainiao-splash-fix.sgmodule) |

点模块名查看详细说明。

## 目录约定

单文件模块直接平放;需要脚本或额外文件时才开一个同名文件夹:

```
modules/
  <模块名>.sgmodule       纯规则模块,一个文件就够

  <模块名>/               带脚本的模块
    <模块名>.sgmodule
    <模块名>.js
    README.md
```

命名统一用小写 kebab-case,文件/文件夹名 = 订阅 URL 的最后一段。

**不按分类建目录**——分类写在模块内的 `#!category` 里由 Surge 负责分组。
目录路径会进订阅 URL,而分类是会变的,把分类放进路径意味着重新归类就会让旧订阅失效。

## 开发

```bash
node --test          # 跑测试(test/ 与 docs/ 不纳入版本控制)
```

## License

[MIT](LICENSE)
