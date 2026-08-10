// ============================================================
//  创作者运营 AI 提效原型 —— 核心逻辑
//  纯函数部分可在 Node 下单测；DOM 渲染部分仅在浏览器执行。
// ============================================================

// ---------- 工具 ----------
function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, "");
}

// 关键词命中打分
function scoreLabels(text) {
  const t = norm(text);
  const scores = {};
  DATA.labels.forEach((l) => {
    let s = 0;
    l.keywords.forEach((kw) => {
      if (t.includes(norm(kw))) s += 1;
    });
    scores[l.id] = s;
  });
  return scores;
}

// 检索命中 FAQ（按问题/答案词重叠）
function retrieveFaq(text, topN = 3) {
  const t = norm(text);
  const scored = DATA.faq.map((f, i) => {
    let hit = 0;
    [f.q, f.a].forEach((seg) => {
      // 以 2~4 字中文片段做粗粒度重叠
      const segN = norm(seg);
      for (let len = 4; len >= 2; len--) {
        for (let j = 0; j + len <= segN.length; j++) {
          const frag = segN.substr(j, len);
          if (t.includes(frag) && /[一-龥]/.test(frag)) hit += 1;
        }
      }
    });
    return { i, hit, tags: f.tags };
  });
  scored.sort((a, b) => b.hit - a.hit);
  return scored.filter((x) => x.hit > 0).slice(0, topN);
}

// 分类主函数
function classify(text) {
  const scores = scoreLabels(text);
  const retrieved = retrieveFaq(text);
  // FAQ 检索命中给对应标签加权（模拟 RAG 召回提升打标准确率）
  retrieved.forEach((r) => {
    r.tags.forEach((tag) => {
      if (scores[tag] != null) scores[tag] += 0.6;
    });
  });

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topId = sorted[0][1] > 0 ? sorted[0][0] : "other";
  const topScore = sorted[0][1];
  const secondScore = sorted[1] ? sorted[1][1] : 0;
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = total > 0 ? +(topScore / (topScore + secondScore + 0.001)).toFixed(2) : 0.5;

  // 进线总结
  const labelObj = DATA.labels.find((l) => l.id === topId);
  const isUp = /up主|签约|创作|投稿|直播|商单/.test(norm(text));
  let emotion = "低";
  if (topId === "complaint") emotion = "高";
  else if (/差|骗|垃圾|敷衍|恶心|太差|不满/.test(norm(text))) emotion = "中";
  let priority = "中";
  if (topId === "complaint" || topId === "content_violation" || (topId === "account" && /盗|封|急/.test(norm(text)))) priority = "高";
  else if (topId === "other") priority = "低";
  const summary = {
    用户类型: isUp ? "UP 主 / 创作者" : "普通用户 / 粉丝",
    核心诉求: labelObj ? labelObj.name : "其他",
    情绪等级: emotion,
    优先级: priority,
    建议动作: labelObj ? labelObj.defaultAction : "转人工通用队列",
    检索命中FAQ: retrieved.length
      ? retrieved.map((r) => DATA.faq[r.i].q)
      : ["（无直接命中，建议补充知识切片）"],
  };

  return { predicted: topId, scores, retrieved, confidence, summary, labelName: labelObj ? labelObj.name : "其他/兜底" };
}

// Golden Set 评测
function runGoldenSet() {
  let top1 = 0;
  let top2 = 0;
  const rows = DATA.goldenSet.map((item) => {
    const r = classify(item.text);
    const sorted = Object.entries(r.scores).sort((a, b) => b[1] - a[1]);
    const top2Ids = sorted.slice(0, 2).map((x) => x[0]);
    const okTop1 = r.predicted === item.expected;
    const okTop2 = top2Ids.includes(item.expected);
    if (okTop1) top1 += 1;
    if (okTop2) top2 += 1;
    return {
      text: item.text,
      expected: item.expected,
      expectedName: DATA.labels.find((l) => l.id === item.expected).name,
      predicted: r.predicted,
      predictedName: r.labelName,
      priorityOk: r.summary.优先级 === item.priority,
      pass: okTop1,
      top2: okTop2,
    };
  });
  const n = DATA.goldenSet.length;
  return {
    n,
    accuracy: +(top1 / n).toFixed(3),
    recallTop2: +(top2 / n).toFixed(3),
    rows,
  };
}

// 生成 Badcase 知识库迭代建议
function suggestFix(expected, predicted) {
  const e = DATA.labels.find((l) => l.id === expected);
  const p = DATA.labels.find((l) => l.id === predicted);
  return `建议：在「${e.name}」标签补充易混淆样本的关键词/口径，并将该 Badcase 加入 Golden Set 回归；同时检查「${p ? p.name : "其他"}」是否过召回。`;
}

// 中文 n-gram 重叠打分（2~4 字），仅计中文字片段
function ngOverlap(text, seg) {
  const t = norm(text), s = norm(seg);
  let hit = 0;
  for (let len = 4; len >= 2; len--) {
    for (let j = 0; j + len <= s.length; j++) {
      const frag = s.substr(j, len);
      if (t.includes(frag) && /[一-龥]/.test(frag)) hit += 1;
    }
  }
  return hit;
}

// 知识库检索召回（稀疏检索，覆盖 标签体系 / FAQ / 维护口径）
// 供 RAG 模式组装 prompt；也可在评测中展示「检索召回命中率」。
function retrieveContext(text, topN = 6) {
  const items = [];
  DATA.labels.forEach((l) => {
    const seg = l.name + " " + l.desc + " " + l.keywords.join(" ");
    items.push({ source: "标签·" + l.name, text: l.name + "：" + l.desc, score: ngOverlap(text, seg), labelId: l.id });
  });
  DATA.faq.forEach((f) => {
    const seg = f.q + " " + f.a;
    items.push({ source: "FAQ·" + f.q, text: f.q + " " + f.a, score: ngOverlap(text, seg), labelId: f.tags && f.tags[0] });
  });
  DATA.caliber.forEach((c) => {
    items.push({ source: "维护口径", text: c, score: ngOverlap(text, c), labelId: null });
  });
  items.sort((a, b) => b.score - a.score);
  const top = items.filter((x) => x.score > 0).slice(0, topN);
  return {
    context: top.map((x) => "[" + x.source + "] " + x.text).join("\n"),
    sources: top.map((x) => x.source),
    items: top,
  };
}

// 标签 id → 名称
function nameOf(id) {
  const l = DATA.labels.find((x) => x.id === id);
  return l ? l.name : "其他/兜底";
}

// 跨业务场景路由一致性专项评测
// engine: (text) => { predicted } ；默认规则基线 classify，也可传入 RAG 引擎
// 一致性定义：同一业务诉求的不同场景/视角/表述，必须路由到同一 expected 标签
function runRoutingConsistency(engine) {
  const fn = engine || classify;
  let consistent = 0;
  const groups = DATA.routingGroups.map((g) => {
    const preds = g.utterances.map((u) => fn(u).predicted);
    const ok = preds.length > 0 && preds.every((p) => p === g.expected);
    if (ok) consistent += 1;
    return {
      scenario: g.scenario,
      expected: g.expected,
      expectedName: nameOf(g.expected),
      preds,
      predNames: preds.map(nameOf),
      ok,
    };
  });
  const n = DATA.routingGroups.length;
  return { n, consistency: +(consistent / n).toFixed(3), consistent, groups };
}

// ---------- 浏览器渲染（仅在 DOM 环境执行） ----------
if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "bili_agent_badcases";
  let MODE = "rule"; // "rule" 规则基线 | "rag" RAG Agent（智能模式）

  function loadBadcases() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveBadcases(arr) {
    localStorage.setItem(STORE_KEY, JSON.stringify(arr));
  }

  const SAMPLES = [
    "我的视频被限流了，是不是被搬运举报，怎么申诉恢复？",
    "充了电的钱什么时候到账，怎么提现？",
    "你们客服太差了，骗人，激励没发，必须给说法！",
    "账号异地登录是不是被盗了，急！",
  ];

  function renderTagResult(r) {
    let html = `<div class="tag-pill" style="border-color:${"#FB7299"}">预测标签：${r.labelName}</div>`;
    html += `<div class="kv"><span>置信度</span><b>${r.confidence}</b></div>`;
    if (r.retrieved) html += `<div class="kv"><span>检索召回</span><b>${r.retrieved.length} 条知识切片</b></div>`;
    if (r.scores) {
      html += `<div class="kv"><span>检索命中 FAQ</span><b>${r.summary.检索命中FAQ.length} 条</b></div>`;
      const scoreRows = Object.entries(r.scores)
        .sort((a, b) => b[1] - a[1])
        .map(([id, s]) => {
          const nm = DATA.labels.find((l) => l.id === id).name;
          const pct = r.scores[r.predicted] > 0 ? Math.round((s / (r.scores[r.predicted] + 0.001)) * 100) : 0;
          return `<div class="bar-row"><span class="bar-name">${nm}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-val">${s}</span></div>`;
        })
        .join("");
      html += `<div class="bars">${scoreRows}</div>`;
    }
    return html;
  }

  function renderSummary(r) {
    const s = r.summary;
    const order = ["用户类型", "核心诉求", "情绪等级", "优先级", "建议动作", "检索命中FAQ"];
    let html = "";
    order.forEach((k) => {
      const v = Array.isArray(s[k]) ? s[k].map((x) => `· ${x}`).join("<br>") : s[k];
      html += `<div class="sum-row"><span class="sum-k">${k}</span><span class="sum-v">${v}</span></div>`;
    });
    return html;
  }

  function renderRagContext(r) {
    if (!r.retrieved || !r.retrieved.length) { $("ragContext").innerHTML = ""; return; }
    $("ragContext").innerHTML = `<div class="kv"><span>检索到的知识库切片</span><b>${r.retrieved.length} 条</b></div>
      <div class="tag-cloud">${r.retrieved.map((s) => `<span class="chip">${s}</span>`).join("")}</div>`;
  }

  function renderRagReason(r) {
    const badge = r.mode === "rag"
      ? `<span class="chip" style="background:#e8f7ee;color:#1a9e57;">真实大模型 · ${r.provider || ""}</span>`
      : `<span class="chip" style="background:#fff3e0;color:#d97706;">演示模式 · 模拟大模型</span>`;
    $("ragReason").innerHTML = `<div class="kv"><span>生成模式</span><b>${badge}</b></div>
      <div class="sum-row"><span class="sum-k">分类依据</span><span class="sum-v">${r.reason || "（无）"}</span></div>`;
  }

  async function doClassify() {
    const text = $("inputText").value.trim();
    if (!text) { alert("请先输入或选择一条进线内容"); return; }
    if (MODE === "rag") return doRag(text);
    const r = classify(text);
    $("tagResult").innerHTML = renderTagResult(r);
    $("summaryResult").innerHTML = renderSummary(r);
    $("ragContext").innerHTML = "";
    $("ragReason").innerHTML = "";
    $("classifyPanel").style.display = "block";
    window.__last = r;
  }

  async function doRag(text) {
    $("classifyPanel").style.display = "block";
    $("tagResult").innerHTML = `<p class="note">正在调用本地 RAG 服务……</p>`;
    try {
      const resp = await fetch("/api/rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mock: false }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const r = await resp.json();
      $("tagResult").innerHTML = renderTagResult(r);
      $("summaryResult").innerHTML = renderSummary(r);
      renderRagContext(r);
      renderRagReason(r);
      window.__last = { predicted: r.predicted, labelName: r.labelName };
    } catch (e) {
      // 服务未启动（如静态托管 / GitHub Pages）→ 离线模拟 RAG，明确标注为演示模式，保证可交互演示
      const r = classify(text);
      const rc = retrieveContext(text, 6);
      const mock = Object.assign({}, r, {
        retrieved: rc.sources,
        reason: `（离线模拟）检索召回 ${rc.sources.length} 条知识切片，其中匹配「${r.labelName}」标签关键词权重最高，故判定为该标签；核心诉求：${r.summary.核心诉求 || "—"}。`,
        mode: "mock",
      });
      $("tagResult").innerHTML = renderTagResult(mock);
      $("summaryResult").innerHTML = renderSummary(mock);
      renderRagContext(mock);
      renderRagReason(mock);
      window.__last = { predicted: mock.predicted, labelName: mock.labelName };
    }
  }

  function runEval() {
    const res = runGoldenSet();
    let html = `<div class="metric"><div class="m-num">${(res.accuracy * 100).toFixed(1)}%</div><div class="m-label">Top-1 打标准确率</div></div>`;
    html += `<div class="metric"><div class="m-num">${(res.recallTop2 * 100).toFixed(1)}%</div><div class="m-label">Top-2 召回率</div></div>`;
    html += `<div class="metric"><div class="m-num">${res.n}</div><div class="m-label">Golden Set 规模</div></div>`;
    $("metrics").innerHTML = html;

    const rows = res.rows.map((row, i) => {
      const cls = row.pass ? "pass" : "fail";
      return `<tr class="${cls}">
        <td>${i + 1}</td>
        <td class="t-text">${row.text}</td>
        <td>${row.expectedName}</td>
        <td>${row.predictedName}</td>
        <td>${row.priorityOk ? "✓" : "✗"}</td>
        <td>${row.pass ? "✓ 通过" : "✗ 误判"}</td>
      </tr>`;
    }).join("");
    $("evalTable").innerHTML = `<table class="eval">
      <thead><tr><th>#</th><th>进线内容</th><th>期望标签</th><th>预测标签</th><th>优先级</th><th>结果</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    $("evalPanel").style.display = "block";
  }

  function runRouting() {
    const res = runRoutingConsistency();
    let html = `<div class="metric"><div class="m-num">${(res.consistency * 100).toFixed(1)}%</div><div class="m-label">跨场景路由一致率</div></div>`;
    html += `<div class="metric"><div class="m-num">${res.consistent}/${res.n}</div><div class="m-label">一致组 / 总组</div></div>`;
    $("routingMetrics").innerHTML = html;

    const groups = res.groups.map((g, i) => {
      const cls = g.ok ? "pass" : "fail";
      const utt = g.utterances ? g.utterances : [];
      const rows = utt.map((u, k) => `<tr><td class="t-text">${u}</td><td>${g.predNames[k]}</td></tr>`).join("");
      return `<div class="rt-group ${cls}">
        <div class="rt-head">${g.ok ? "✓ 一致" : "✗ 不一致"} · ${g.scenario}（期望：${g.expectedName}）</div>
        <table class="eval"><thead><tr><th>场景化表述</th><th>路由结果</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join("");
    $("routingGroups").innerHTML = groups;
    $("routingPanel").style.display = "block";
    $("routingNote").innerHTML = `<p class="note">路由一致性监控「同一业务诉求在不同场景/视角/表述下是否稳定路由到同一标签」，覆盖 JD 中「跨业务场景路由一致性」要求。基线下若发现歧义（如「分成」同时命中签约与收益标签），即定位为知识库口径待治理项。</p>`;
  }

  function markBadcase() {
    const r = window.__last;
    if (!r) { alert("请先做一次打标再标记 Badcase"); return; }
    const text = $("inputText").value.trim();
    const expected = $("expectedSel").value;
    if (r.predicted === expected) { alert("预测与人工标注一致，不属于 Badcase"); return; }
    const arr = loadBadcases();
    arr.push({
      text, predicted: r.predicted, expected,
      fix: suggestFix(expected, r.predicted),
      ts: new Date().toISOString(),
    });
    saveBadcases(arr);
    renderBadcases();
    alert("已记入 Badcase 闭环，知识库迭代建议已生成。");
  }

  function renderBadcases() {
    const arr = loadBadcases();
    if (!arr.length) { $("badcaseList").innerHTML = `<p class="empty">暂无 Badcase，评测全通过后此处为空 ✅</p>`; return; }
    const items = arr.map((b, i) => {
      const eN = DATA.labels.find((l) => l.id === b.expected).name;
      const pN = DATA.labels.find((l) => l.id === b.predicted).name;
      return `<div class="bc-item">
        <div class="bc-head">Badcase #${i + 1} · ${new Date(b.ts).toLocaleString()}</div>
        <div class="bc-text">「${b.text}」</div>
        <div class="bc-map">预测：<b>${pN}</b> → 人工：<b>${eN}</b></div>
        <div class="bc-fix">${b.fix}</div>
      </div>`;
    }).join("");
    $("badcaseList").innerHTML = items;
  }

  function init() {
    const sel = $("expectedSel");
    DATA.labels.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    const samp = $("samples");
    SAMPLES.forEach((s) => {
      const b = document.createElement("button");
      b.className = "sample-btn"; b.textContent = s.length > 16 ? s.slice(0, 16) + "…" : s;
      b.onclick = () => { $("inputText").value = s; };
      samp.appendChild(b);
    });
    const modeSel = $("modeSel");
    if (modeSel) {
      modeSel.onchange = () => {
        MODE = modeSel.value;
        const note = $("modeNote");
        if (MODE === "rag") {
          note.innerHTML = `已切换至 <b>RAG Agent（智能模式）</b>：先检索知识库切片，再调用大模型生成打标 + 总结。需运行 <code>node server.js</code> 并访问 http://localhost:3000 ；未配置 Key 时自动走「演示模式（模拟大模型）」。`;
        } else {
          note.innerHTML = `当前为 <b>规则基线</b>：关键词打分 + FAQ 检索加权，零依赖、可直接双击 index.html 运行。`;
        }
      };
    }
    $("btnClassify").onclick = doClassify;
    $("btnEval").onclick = runEval;
    $("btnBadcase").onclick = markBadcase;
    $("btnRouting").onclick = runRouting;
    renderBadcases();
  }

  window.addEventListener("DOMContentLoaded", init);

  // 暴露给调试
  window.__agent = { classify, runGoldenSet, runRoutingConsistency, retrieveContext, suggestFix };
}

// Node 环境下导出纯函数，便于单测
if (typeof module !== "undefined" && module.exports) {
  module.exports = { classify, runGoldenSet, suggestFix, scoreLabels, retrieveFaq, retrieveContext, runRoutingConsistency, nameOf };
}
