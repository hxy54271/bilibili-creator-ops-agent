# B 站创作者运营 · 进线打标 & 总结 Agent 原型

一个面向 B 站创作者运营场景的轻量级 Agent 原型，演示如何用 AI 提效工具把「进线分类 + 进线总结」这一高频运营动作自动化，并配套结构化知识库与 Agent 评测体系。

## 项目背景

创作者运营在 CRM 中大量重复处理 UP 主进线（投诉、签约咨询、收益查询、账号安全、内容违规等），人工分类效率低、口径不统一、知识沉淀困难。本项目针对这一痛点，用 vibe coding 快速搭出可运行原型，验证「AI 提效方案」在创作者运营场景的可行性，并覆盖知识库治理与 Agent 评测两大核心命题。

## 技术栈

- 前端：**HTML + 原生 JavaScript**，零依赖、零构建
- 知识库与评测集：`data.js`
- 前端核心逻辑与渲染：`app.js`
- 大模型代理（RAG 升级）：`server.js`（Node 内置 `http` + `fetch`，零三方依赖）

## 运行方式

### 模式 A：规则基线（零依赖，双击即用）
直接**双击 `index.html`** 用浏览器打开即可，无需服务器、无需联网、无需 API Key。
分类采用「关键词打分 + FAQ 检索召回加权」的确定性基线。

### 模式 B：RAG Agent（智能模式，需启动本地服务）
```bash
# 1) 配置大模型（任选其一）
#   方式一：环境变量
export LLM_PROVIDER=deepseek        # openai / deepseek / qwen / zhipu / custom
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=deepseek-chat      # 留空则用 provider 预设默认值
#   方式二：复制模板后填 key（已被 .gitignore 忽略，不会提交）
cp config.example.json config.json

# 2) 启动服务
node server.js
# 3) 浏览器打开 http://localhost:3000
```
启动后，前端「运行模式」切到 **RAG Agent（智能模式）**：先对知识库做稀疏检索召回（标签体系 / FAQ / 维护口径），再把检索到的知识切片作为上下文送入大模型，生成 **打标 + 结构化总结 + 分类依据**。
未配置 Key 时，`/api/rag` 自动走**演示模式（模拟大模型）**，可离线演示完整 RAG 流程；配置 Key 后无缝切换为真实大模型调用。

> 安全说明：API Key 仅存在于服务端（`config.json` / 环境变量），绝不进入前端代码或仓库。

### 评测逻辑可在 Node 下复跑
```bash
node -e "global.DATA=require('./data.js');const a=require('./app.js');
console.log('GoldenSet', a.runGoldenSet());
console.log('Routing ', a.runRoutingConsistency());"
```

## 功能一览

1. **知识库面板**：进线标签体系 + 维护口径可视化。
2. **进线打标 + 总结（双模式）**：
   - 规则基线：预测标签、置信度、FAQ 检索命中、结构化总结（用户类型 / 核心诉求 / 情绪 / 优先级 / 建议动作）。
   - RAG Agent：在基线之上，展示**检索召回的知识切片**与**大模型的分类依据**，体现 RAG 链路。
3. **Badcase 闭环**：对误判样本标记人工正确标签 → 自动生成「知识库迭代建议」，并持久化（localStorage）形成闭环。
4. **Golden Set 评测**：一键批量评测，输出 Top-1 准确率、Top-2 召回率与逐条明细。
5. **跨业务场景路由一致性专项评测**：一键评测同一业务诉求在不同场景 / 视角 / 表述下的路由稳定性，输出一致率与逐组明细。

## 当前评测基线

- **Golden Set**：17 条样本，Top-1 准确率 **88.2%**，Top-2 召回 **100%**（含 2 条对抗性样本，用于演示 Badcase 闭环）。
- **跨业务场景路由一致性**：7 组 × 多场景表述，基线路由一致率 **100%**（7/7）。
  - 注：知识库中「分成」同时命中「签约」与「收益」标签，是已知的口径歧义点；生产中需用语义消歧 / 字段标准化治理——本项目已将其列为知识库治理待办。

## 目录结构

```
bilibili-creator-ops-agent/
├── index.html          # 界面（模式切换 / 打标 / Badcase / 两类评测）
├── app.js              # 前端核心逻辑 + 浏览器渲染（含 RAG 调用、路由一致性评测）
├── data.js             # 运营域结构化知识库 + Golden Set + 路由一致性测试集
├── server.js           # 大模型代理（RAG）：静态托管 + /api/rag（稀疏检索 → 大模型）
├── config.example.json # 大模型配置模板（复制为 config.json 并填 key，已被 gitignore）
├── .gitignore
└── README.md
```

## 后续可扩展

- 接入稠密向量检索（embedding API）替换稀疏检索，提升长尾召回。
- 增加「检索命中率随知识库迭代」的可视化看板，监控 Agent 指标曲线。
- 把 Badcase 闭环接到人工标注后台，形成「标注 → 训练 → 回归」的可持续闭环。
