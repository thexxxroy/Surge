# Netflix 豆瓣 / IMDb 评分

在 Netflix **网页版**详情页显示豆瓣与 IMDb 评分。

**开箱即用** —— 装上模块就能看到豆瓣评分,不需要注册任何账号或申请 key。
想额外显示 IMDb 评分,再自己申请一个免费的 OMDb key 填进去即可。

## 两种模式

|            | 默认(不配置)                  | 填了 OMDb key          |
| ---------- | ------------------------------- | ---------------------- |
| 豆瓣评分   | ✅ 按英文原名 + 年份 + 类型匹配 | ✅ 按 IMDb ID 精确匹配 |
| IMDb 评分  | —                               | ✅                     |
| 需要做的事 | 装上即可,OMDbApiKey 保持默认的 none                        | 免费申请一次           |

不配置 key 时豆瓣走的是**启发式匹配**,绝大多数情况正确,但冷门片或同名片可能选错条目。
填了 key 之后改用 IMDb ID 查询,不存在匹配歧义。**所以 key 不只是多一个分数,也让豆瓣更准。**

## 支持范围

| 平台                     | 支持                                                   |
| ------------------------ | ------------------------------------------------------ |
| 网页版 `www.netflix.com` | ✅                                                     |
| iOS / iPadOS 客户端      | ❌ Netflix 客户端 API 走 MSL 加密,中间人无法读取或伪造 |
| Apple TV                 | ❌ 同上,且 Surge 不在 tvOS 上运行                      |

只显示整片评分,不显示单集评分(豆瓣本身没有单集评分)。

## 安装

1. 在 Surge 中安装本模块。
2. 确保 Surge 已启用 MITM 且已安装并信任 CA 证书。
3. 打开任意 Netflix 详情页,应能看到豆瓣评分。

**可选** —— 启用 IMDb 评分:

1. 在 [omdbapi.com](https://www.omdbapi.com/apikey.aspx) 申请免费 API Key(1000 次/天)。
   **注册后必须点击邮件里的激活链接**,否则请求会返回 `Invalid API key!`。
2. 在模块设置里把 `OMDbApiKey` 从默认的 `none` 改成你的 key。

验证 key 是否可用:

```bash
curl -s "https://www.omdbapi.com/?apikey=你的key&t=Heartstopper&y=2022&type=series"
```

返回中出现 `"imdbRating":"8.5"` 即为正常。

> 本项目**不内置任何 API key**。社区中有些脚本会内置一批他人注册的 key 以求免配置,
> 那会占用他人配额,且 key 失效时整个功能会随机罢工。这里改用「豆瓣免 key 保底、
> IMDb 可选增强」的方式达到同样的免配置体验。

## 建议的路由配置

脚本查询豆瓣时走 Surge 的策略路由。若默认策略是境外代理,豆瓣可能限流或失败。
建议在配置中加一条规则让豆瓣直连:

```
DOMAIN-SUFFIX,douban.com,DIRECT
```

本模块不会自动修改你的路由规则。

## 工作原理

页面注入的脚本向同源假路径 `/__nfr` 发请求,由 Surge 拦截并返回评分 JSON,
请求不会真正发往 Netflix。使用同源路径是为了绕开 Netflix 的 CSP 限制,
无需修改 `content-security-policy` 响应头。

Surge 侧的取数链路:

1. 以 `Accept-Language: en-US` 请求 `netflix.com/title/<id>`,从页面内嵌的 JSON-LD 取
   **英文**片名、年份与类型。强制英文是必需的——Netflix 的中文译名与豆瓣的往往不一致
   (同一部剧 Netflix 叫《心跳为你停》,豆瓣叫《心跳漏一拍》)。
2. **若配置了 key**:用英文名查 OMDb,得到 IMDb ID 与评分,再用该 ID 在豆瓣精确搜索。
3. **若未配置 key**:直接用英文名在豆瓣搜索,取回全部候选后按年份与类型打分选出最佳。
   仅取首条结果是不够的——例如搜 `Heartstopper`,首条是 2026 年的同系列电影,
   而不是 2022 年的剧集。

结果缓存 7 天(失败结果 10 分钟),存于 Surge 的持久化存储。

## 故障排查

**完全不显示** — 检查 MITM 是否启用、CA 证书是否已信任。

**只显示豆瓣,没有 IMDb** — `OMDbApiKey` 仍是默认的 `none`,或 key 未激活,或该片在 IMDb 上没有评分。

**只显示 IMDb,没有豆瓣** — 豆瓣被限流,参见上面的路由配置建议。

**豆瓣评分对不上号** — 未配置 key 时的启发式匹配选错了条目。填入 OMDb key 可解决。

**某部片什么都不显示** — 豆瓣和 OMDb 都没匹配上,通常是冷门片或译名差异过大。

**曾经正常,某天全部失效** — 大概率是 Netflix 改了页面结构,注入锚点失效。
需要更新 `Netflix-Ratings.js` 中 `pageAgent` 的 `ANCHORS` 数组。

## 致谢

实现思路参考了两个前作:

- [yichahucha/surge](https://github.com/yichahucha/surge) 的 `nf_rating.js` —— 最早的 Netflix 评分脚本(现已因 Netflix 客户端 API 迁入 MSL 加密而失效)
- [NobyDa/Script](https://github.com/NobyDa/Script) 的 Disney+ 评分脚本 —— 「用 IMDb ID 搜索豆瓣」这一关键技巧来自它

## 声明

仅供个人学习与自用。修改客户端收到的响应内容不符合 Netflix 的服务条款,请自行判断使用风险。
