/* 고객 한마디 분류기 — 화면.
 *
 * 흐름: 문장 → 가림(mask.js, 브라우저 안) → AI(api/classify) → 실패하면 규칙(rules.js)
 * 채점: 정답 100건을 규칙으로, 또는 AI로(BATCH건씩) 돌려 맞힌 비율을 잰다.
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const S = { criteria: null, test: [], practice: [], aiResults: null, serverDefault: "" };

  // 한 번에 AI에 보내는 문장 수. 서버의 MAX_TEXTS(20)보다 작게 — 느린 모델이 대기 한도를 넘기지 않게.
  const BATCH = 10;

  // 모델 목록 — 2026-11-06 공식 가격표(aistudio.google.com/docs/pricing)에서 Free tier 로 표시된
  // 텍스트 생성 모델 중 지원 중단 표시가 없는 5개. 모델 이름은 자주 바뀌니 배포 전에 다시 확인한다.
  // ※ 순서는 «추정»이다. 무료 하루 요청 수는 AI Studio 로그인 화면에서만 보이고 공식 문서에 표가 없어
  //   한도가 높은 순이라고 확인하지 못했다. 최신 세대 → 가벼운 모델 순으로 늘어놓았을 뿐이다.
  const MODELS = [
    { id: "gemini-3.8-flash" },
    { id: "gemini-3.6-flash" },
    { id: "gemini-3.5-flash-lite" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-3-flash-preview", note: "프리뷰" },
  ];
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;
  const LS_KEY = "classifier.model";   // 저장값: "" (서버 기본값) 또는 모델 이름
  const CUSTOM = "__custom__";

  // localStorage 를 못 써도(시크릿 창 등) 앱은 그대로 돈다
  function lsGet() { try { return localStorage.getItem(LS_KEY); } catch (e) { return null; } }
  function lsSet(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) { /* 기억만 못 할 뿐 */ } }

  let chosenModel = "";   // 요청에 실어 보낼 모델. 빈 문자열 = 서버 기본값

  function initModelPicker() {
    const sel = $("#model-select"), inp = $("#model-custom");
    sel.innerHTML = `<option value="">서버 기본값</option>` +
      MODELS.map(m => `<option value="${m.id}">${m.id}${m.note ? " (" + m.note + ")" : ""}</option>`).join("") +
      `<option value="${CUSTOM}">직접 입력…</option>`;

    const saved = lsGet() || "";
    if (!saved) sel.value = "";
    else if (MODELS.some(m => m.id === saved)) sel.value = saved;
    else { sel.value = CUSTOM; inp.value = saved; }
    applyModel(false);

    sel.addEventListener("change", () => { if (sel.value === CUSTOM) inp.focus(); applyModel(true); });
    inp.addEventListener("input", () => applyModel(true));
  }

  function applyModel(save) {
    const sel = $("#model-select"), inp = $("#model-custom");
    inp.hidden = sel.value !== CUSTOM;
    const custom = inp.value.trim();
    chosenModel = sel.value === CUSTOM ? custom : sel.value;
    // 형식이 틀린 직접 입력은 저장하지 않는다 (서버도 같은 규칙으로 거절한다)
    const bad = sel.value === CUSTOM && custom !== "" && !MODEL_RE.test(custom);
    if (save && !bad) lsSet(chosenModel);

    const now = $("#model-now");
    if (bad) now.textContent = "모델 이름이 올바르지 않습니다 — 영문·숫자·점·밑줄·하이픈만, 64자까지";
    else if (sel.value === CUSTOM && !custom) now.textContent = "모델 이름을 입력하세요 — 비워 두면 서버 기본값으로 호출합니다";
    else if (!chosenModel) now.textContent = "호출 모델: 서버 기본값" + (S.serverDefault ? ` (${S.serverDefault})` : " (서버에 닿으면 표시됩니다)");
    else now.textContent = "호출 모델: " + chosenModel;
  }

  async function loadServerDefault() {
    try {
      const r = await fetch("api/classify");
      if (!r.ok) return;
      const d = await r.json();
      if (d && typeof d.default === "string") { S.serverDefault = d.default; applyModel(false); }
    } catch (e) { /* 로컬에는 서버 함수가 없다 — 정상 */ }
  }

  async function load() {
    const [c, t, p] = await Promise.all([
      fetch("criteria.json").then(r => r.json()),
      fetch("data/answer100.json").then(r => r.json()),
      fetch("data/practice200.json").then(r => r.json()),
    ]);
    S.criteria = c; S.test = t; S.practice = p;
    renderCriteria();
  }

  // ── 탭 ──────────────────────────────────────────────
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    ["try", "score", "rules"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
  }));

  // ── AI 호출 ─────────────────────────────────────────
  async function askAI(maskedTexts) {
    try {
      const r = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: maskedTexts, criteria: S.criteria, model: chosenModel }),
      });
      if (!r.ok) return { results: null, reason: `서버 함수가 없습니다 (${r.status}) — 배포하면 생깁니다` };
      return await r.json();
    } catch (e) {
      return { results: null, reason: "서버 함수에 닿지 못했습니다" };
    }
  }

  function chips(el, res) {
    el.innerHTML = ["category", "sentiment", "urgency"]
      .map(k => `<span class="chip ${res[k]}">${res[k]}</span>`).join("");
  }

  // ── 분류해 보기 ─────────────────────────────────────
  $("#btn-sample").addEventListener("click", () => {
    const r = S.practice[Math.floor(Math.random() * S.practice.length)];
    $("#input").value = r.text;
  });

  $("#btn-classify").addEventListener("click", async () => {
    const text = $("#input").value.trim();
    if (!text) return;
    const btn = $("#btn-classify");
    btn.disabled = true; btn.textContent = "분류 중…";

    const m = Mask.mask(text);
    $("#sent").hidden = false;
    $("#sent-text").textContent = m.masked;
    $("#sent-found").innerHTML = m.found.length
      ? m.found.map(f => `<span class="tag">${f.type} 가림</span>`).join("")
      : `<span class="muted">가린 것 없음</span>`;

    const rule = Rules.classify(m.masked, S.criteria);
    const ai = await askAI([m.masked]);
    const got = ai.results && ai.results[0];

    $("#result").hidden = false;
    if (got) {
      $("#main-by").textContent = "AI · " + (ai.model || "");
      chips($("#main-chips"), got);
      $("#main-reason").textContent = got.reason || "";
      $("#note").hidden = true;
    } else {
      $("#main-by").textContent = "규칙";
      chips($("#main-chips"), rule);
      $("#main-reason").textContent = `분류: ${rule.why.category} · 감정: ${rule.why.sentiment} · 긴급도: ${rule.why.urgency}`;
      $("#note").hidden = false;
      $("#note").textContent = `AI 없이 규칙으로만 분류했습니다 — ${ai.reason || "AI 응답 없음"}`;
    }
    chips($("#rule-chips"), rule);
    $("#rule-reason").textContent = `분류: ${rule.why.category}`;
    $("#card-rule").hidden = !got;

    btn.disabled = false; btn.textContent = "분류하기";
  });

  // ── 채점 ───────────────────────────────────────────
  function pct(x) { return x.toFixed(x % 1 ? 1 : 0) + "%"; }

  function showScore(who, s) {
    $("#score-table").hidden = false;
    for (const k of ["category", "sentiment", "urgency"]) {
      document.querySelector(`[data-k="${who}-${k}"]`).textContent = pct(s.accuracy[k]);
    }
    document.querySelector(`[data-k="${who}-all"]`).textContent = `${s.n - s.wrong.length} / ${s.n}`;
    $("#wrong").hidden = false;
    $("#wrong-who").textContent = (who === "ai" ? "— AI" : "— 규칙") + " · 정답 → 판정";
    $("#wrong-list").innerHTML = s.wrong.slice(0, 15).map(w => {
      const diff = ["category", "sentiment", "urgency"].filter(k => w.got[k] !== w.want[k])
        .map(k => `${w.want[k]}→${w.got[k]}`).join(" · ");
      return `<li><span class="t">${w.text}</span><br><span class="d">${diff}${w.note ? " · " + w.note : ""}</span></li>`;
    }).join("") + (s.wrong.length > 15 ? `<li class="d">… 외 ${s.wrong.length - 15}건</li>` : "");
  }

  $("#btn-score-rule").addEventListener("click", () => {
    const s = Rules.score(S.test, r => Rules.classify(Mask.mask(r.text).masked, S.criteria));
    showScore("rule", s);
    $("#score-msg").hidden = true;
  });

  $("#btn-score-ai").addEventListener("click", async () => {
    const btn = $("#btn-score-ai");
    btn.disabled = true;
    const masked = S.test.map(r => Mask.mask(r.text).masked);
    const results = [];
    let usedModel = "";
    for (let i = 0; i < masked.length; i += BATCH) {
      btn.textContent = `AI 채점 중… ${i}/${masked.length}`;
      const chunk = masked.slice(i, i + BATCH);
      let r = await askAI(chunk);
      if (!r.results && r.timeout) {   // 느려서 끊겼으면 그 묶음만 한 번 더
        btn.textContent = `다시 시도 중… ${i}/${masked.length}`;
        r = await askAI(chunk);
      }
      if (!r.results) {
        $("#score-msg").hidden = false;
        $("#score-msg").textContent = `AI로 채점하지 못했습니다 — ${r.reason}` + (r.timeout ? " (두 번 시도했습니다)" : "");
        btn.disabled = false; btn.textContent = "AI로 채점";
        return;
      }
      if (r.model) usedModel = r.model;
      results.push(...r.results);
    }
    // 답을 못 받은 문장은 «오답»으로 센다 — 빠진 것을 빼고 세면 점수가 부풀려진다
    const miss = { category: "-", sentiment: "-", urgency: "-" };
    S.aiResults = results;
    const s = Rules.score(S.test, (r, i) => results[i] || miss);
    showScore("ai", s);
    if (usedModel) $("#ai-th").textContent = "AI · " + usedModel;
    const blank = results.filter(x => !x).length;
    $("#score-msg").hidden = !blank;
    if (blank) $("#score-msg").textContent = `AI가 답하지 않은 문장 ${blank}건은 오답으로 셌습니다.`;
    $("#btn-download").hidden = false;
    btn.disabled = false; btn.textContent = "AI로 채점";
  });

  $("#btn-download").addEventListener("click", () => {
    const rows = S.test.map((r, i) => ({ id: r.id, text: r.text, 정답: r, AI: S.aiResults[i] }));
    const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ai_채점결과.json"; a.click();
  });

  // ── 기준 ───────────────────────────────────────────
  function renderCriteria() {
    const c = S.criteria;
    $("#owner").textContent = c.owner;
    $("#crit-cats").innerHTML = c.categories
      .map(x => `<tr><td>${x.name}</td><td>${x.definition}</td></tr>`).join("");
    $("#crit-priority").textContent = c.priority.join(" → ") + " 순서로 먼저 봅니다.";
    $("#crit-priority-reason").textContent = c.priority_reason;
    $("#crit-sent").textContent = c.sentiment.guide;
    $("#crit-urg").textContent = c.urgency.guide;
  }

  initModelPicker();
  loadServerDefault();
  load();
})();
