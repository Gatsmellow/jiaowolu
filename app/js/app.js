/* 交我录 · 工作台
 *
 * 一条主链路：上传报告 → 识别 → 对到指标 → 填表 → 红黄绿 → 人工核对 → 导出。
 *
 * 四条不变量（改代码时别破坏）：
 *   1. 患者隔离：任何一条识别结果都带 patientId，不许跨患者找补。
 *   2. 单一来源：结果只从 Observation 派生，页面上的数字不单独存一份。
 *   3. 模型只提案：绿只代表"识别到了且可信"，不代表医学正确；最终值由人确认。
 *   4. 可追溯：每条结果都能点回它来自哪一页。
 */
(function () {
  'use strict';

  var MAX_IMAGE_EDGE = 1500;   // 送模型前把图缩到这个边长内，省 token
  var MIN_EDGE = 900;          // 长边低于这个数，基本读不出小字（聊天里存的缩略图就是 240×320）
  var JPEG_QUALITY = 0.82;
  var PDF_MAX_PAGES = 12;      // 一次最多拆 12 页
  var CONCURRENCY = 2;         // 同时识别几页
  var LOW_CONFIDENCE = 0.6;
  var smallCount = 0;          // 本次上传里有多少张低分辨率图

  /* 文书类型 → 只有这类文书上才会成组出现的页面。
     先判类型再抽取，是为了不让模型到出院记录的正文里去"捞"血常规——
     那里面确实写着"白细胞计数:5.54*10^9/L"，照抄下来就成了另一份来源，
     跟真正的化验单对不上，白白制造一堆"两处不一致"。 */
  var DOC_PAGES = {
    '血常规': ['cbc'],
    '生化': ['bio', 'liver', 'renal', 'elec'],
    '出凝血': ['coag'],
    '免疫': ['immu'],
    '病毒学': ['infect'],
    'FISH': ['fish'],
    '病理': ['patho'],
    '骨髓流式': ['flow'],
    '影像': ['ct'],
    '病案首页': ['course'],
    '出院小结': ['discharge'],
    '其他': []
  };
  /* 页眉字段：每一份单据的抬头都可能印着，跟文书类型无关 */
  // 页眉/身份类字段：只从"病案首页"取，别的文书一律不抄（省 token，也免掉"男/男性"这种噪音）
  var HEADER_IDS = ['NAME', 'SEX', 'AGE', 'VISITAGE', 'ADMNO', 'VISITDATE', 'HOSP'];

  var S = {
    patients: [],
    currentId: null,
    assets: [],
    observations: [],
    running: false,
    dateFilter: '',            // 时间轴：只看某一次就诊（'' = 全部，取最近一次的值）
    collapse: {},              // 页面分组是展开还是收起，用户点过就记住
    seq: { patient: 0, asset: 0, obs: 0 }
  };

  /* ---------------- 本地缓存：不小心关掉页面也不丢 ----------------
   * 存在 IndexedDB（图片是 dataURL，几 MB，localStorage 装不下）。
   * 只存在这台电脑的浏览器里，不上传；24 小时后自动作废，避免哪天打开
   * 发现是上周的旧任务。清空本次任务时一并删掉。 */
  var CACHE_DB = 'jiaowolu', CACHE_STORE = 'session', CACHE_TTL = 24 * 3600 * 1000;
  var cacheDb = null, cacheTimer = null;

  function cacheOpen() {
    return new Promise(function (resolve) {
      if (cacheDb) return resolve(cacheDb);
      if (!window.indexedDB) return resolve(null);
      var req;
      try { req = indexedDB.open(CACHE_DB, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(CACHE_STORE)) req.result.createObjectStore(CACHE_STORE);
      };
      req.onsuccess = function () { cacheDb = req.result; resolve(cacheDb); };
      req.onerror = function () { resolve(null); };
    });
  }

  function cachePut() {
    return cacheOpen().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(CACHE_STORE, 'readwrite');
          tx.objectStore(CACHE_STORE).put({
            at: Date.now(),
            patients: S.patients,
            currentId: S.currentId,
            assets: S.assets,
            observations: S.observations,
            seq: S.seq
          }, 'session');
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
          tx.onabort = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    }).catch(function () { /* 存不下就算了，不影响用 */ });
  }

  /* 每次改完状态都会走 renderAll，这里节流 700ms 存一次 */
  function cacheSchedule() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(cachePut, 700);
  }

  function cacheGet() {
    return cacheOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(CACHE_STORE, 'readonly');
          var rq = tx.objectStore(CACHE_STORE).get('session');
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }).catch(function () { return null; });
  }

  function cacheClear() {
    return cacheOpen().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).delete('session');
      } catch (e) { /* ignore */ }
    }).catch(function () {});
  }

  /* 把上次的任务装回来。跑一半被关掉的，状态退回"待识别"。 */
  function restoreSession(saved) {
    S.patients = saved.patients || [];
    S.assets = (saved.assets || []).map(function (a) {
      if (a.status === 'running') a.status = 'pending';
      return a;
    });
    S.observations = saved.observations || [];
    S.seq = saved.seq || S.seq;
    S.currentId = S.patients.some(function (p) { return p.id === saved.currentId; })
      ? saved.currentId
      : (S.patients[0] ? S.patients[0].id : null);
  }

  /* ---------------- 小工具 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function uid(prefix) { S.seq[prefix] = (S.seq[prefix] || 0) + 1; return prefix + S.seq[prefix]; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, kind) {
    var box = document.getElementById('toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      box.style.cssText = 'position:fixed;top:70px;right:20px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:380px';
      document.body.appendChild(box);
    }
    // 只保留最新一条：连点几下按钮时不该糊一屏提示
    while (box.firstChild) box.removeChild(box.firstChild);
    var d = document.createElement('div');
    var bg = kind === 'err' ? '#c62f2f' : (kind === 'ok' ? '#17864a' : '#22303c');
    d.style.cssText = 'background:' + bg + ';color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.18)';
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .3s';
      d.style.opacity = '0';
      setTimeout(function () { d.remove(); }, 320);
    }, kind === 'err' ? 6000 : 3200);
  }

  function current() {
    return S.patients.filter(function (p) { return p.id === S.currentId; })[0] || null;
  }

  /* 本次涉及哪些页面、其中哪些是"必须有"的。
   *
   * 这两件事必须分开：勾了"血常规"只表示这次会看血常规，
   * 不代表没录到就要标红——真实病历里永远有没做的检查。
   * 只有明确标了"必填"的指标，缺项才算质控问题。默认一个都不标。
   *
   * 必填精确到指标而不是整页：真正必须有的往往是某几项（血红蛋白、尿酸），
   * 而整页缺失有时并不算问题（这次没做增强CT）。页面上的那个勾只是"整页批量"开关。 */
  var SEL_KEY = 'jiaowolu.selectedPages.v3';
  var selected = null;

  function loadSelected() {
    if (selected) return selected;
    var raw = null;
    try { raw = localStorage.getItem(SEL_KEY); } catch (e) { /* 隐私模式 */ }
    if (raw) {
      try {
        var obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.ids)) {
          selected = { ids: obj.ids, reqIds: Array.isArray(obj.reqIds) ? obj.reqIds : [] };
          return selected;
        }
      } catch (e) { /* 存档坏了就重来 */ }
    }
    // 上一版存的是"必填页面"，升级时把它展开成"必填指标"
    var legacy = null;
    try { legacy = localStorage.getItem('jiaowolu.selectedPages.v2'); } catch (e) { /* ignore */ }
    if (legacy) {
      try {
        var old = JSON.parse(legacy);
        if (old && Array.isArray(old.ids)) {
          selected = { ids: old.ids, reqIds: unionOf(Array.isArray(old.req) ? old.req : []) };
          saveSelected();
          return selected;
        }
      } catch (e) { /* ignore */ }
    }
    // 默认：只勾"默认要看"的页面（on:false 的先不勾，需要时自己勾上），没有一个算必填
    var on = window.Library.pages().filter(function (p) { return p.on !== false; });
    if (!on.length) on = window.Library.pages();
    selected = { ids: on.map(function (p) { return p.id; }), reqIds: [] };
    return selected;
  }

  function saveSelected() {
    try { localStorage.setItem(SEL_KEY, JSON.stringify(selected)); } catch (e) { /* 存不下算了 */ }
  }

  function unionOf(pageIds) {
    var ids = [];
    pageIds.forEach(function (pid) {
      var page = window.Library.pageById(pid);
      if (!page) return;
      page.ids.forEach(function (id) {
        if (ids.indexOf(id) === -1 && window.Library.byId(id)) ids.push(id);
      });
    });
    return ids;
  }

  /* 这次要抽哪些项。指标被删掉以后页面里可能留着不存在的 id，跳过，别让脏引用打空表。 */
  function targetIds() { return unionOf(loadSelected().ids); }

  /* 缺了要标红的那几项。默认空——没有必选项，就没有平白无故的红。 */
  function requiredIds() {
    return loadSelected().reqIds.filter(function (id) { return !!window.Library.byId(id); });
  }

  function isRequired(indId) { return loadSelected().reqIds.indexOf(indId) !== -1; }

  /* 页面上那个"必填"勾只是批量开关：勾上=整页指标都必填，取消=整页都不必填。
     只标了一部分时显示成半选，鼠标停上去能看到是几项里的几项。 */
  function pageRowHtml(p, sel) {
    var on = sel.ids.indexOf(p.id) !== -1;
    var total = p.ids.length;
    var need = p.ids.filter(function (id) { return sel.reqIds.indexOf(id) !== -1; }).length;
    var all = total > 0 && need === total;
    var part = need > 0 && need < total;
    return '<div class="page-check' + (on ? ' on' : '') + '">' +
      '<label class="pc-main">' +
        '<input type="checkbox" class="pc-use" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="pc-name">' + esc(p.name) + '</span>' +
        '<span class="pc-count">' + total + '</span>' +
      '</label>' +
      '<label class="pc-req' + (on ? '' : ' off') + (need ? ' has' : '') + '"' +
        ' title="' + (part ? '这一页有 ' + need + '/' + total + ' 项必填' : '整页必填：缺了会标红') + '">' +
        '<input type="checkbox" class="pc-must" value="' + esc(p.id) + '"' +
          (all ? ' checked' : '') + (on ? '' : ' disabled') +
          (part ? ' data-part="1"' : '') + '>' +
        (part ? need + '/' + total : '必填') +
      '</label>' +
      '</div>';
  }

  function renderPageChecks() {
    var box = $('#page-checks');
    if (!box) return;
    var pages = window.Library.pages();
    var sel = loadSelected();
    if (!pages.length) {
      box.innerHTML = '<p class="tiny muted">还没有页面。点右上角「指标与页面」新建一个。</p>';
      return;
    }
    // 常规 / 特殊 分开列：常规是每个病人都做的，特殊是这个病种才做的专项检查。
    // 以后做"页面组"时，组就是这两堆页面的组合。
    var common = pages.filter(function (p) { return p.kind !== 'special'; });
    var special = pages.filter(function (p) { return p.kind === 'special'; });
    var html = '';
    if (common.length) {
      html += '<div class="pc-group">常规页面<span class="pc-group-note">每个病人都会做</span></div>';
      html += common.map(function (p) { return pageRowHtml(p, sel); }).join('');
    }
    if (special.length) {
      html += '<div class="pc-group">特殊页面<span class="pc-group-note">病种专项，按需勾选</span></div>';
      html += special.map(function (p) { return pageRowHtml(p, sel); }).join('');
    }
    box.innerHTML = html;
    // 半选的勾要用 DOM 属性设，不能写在 HTML 里
    box.querySelectorAll('.pc-must[data-part]').forEach(function (el) { el.indeterminate = true; });
  }

  function assetsOf(pid) {
    return S.assets.filter(function (a) { return a.patientId === pid; });
  }

  /* ---------------- 状态判定 ---------------- */

  // 一个指标在某位患者身上的全部识别结果。多条且数值不一致 = 冲突。
  function obsOf(pid, indId) {
    return S.observations.filter(function (o) {
      return o.patientId === pid && o.indicatorId === indId;
    });
  }

  // 两个值算不算同一个数/同一段话
  /* 文本类字段放宽一点：医院不同、录入习惯不同，同一个人会被写成
   * "男" / "男性"、"汉族" / "汉"、"40" / "40岁"。
   * 这些差异对人来说没有意义，报出来只会淹掉真正该看的红点。
   * 身份证和电话仍然逐字比对——它们是用来区分人的。 */
  function looseText(v) {
    var s = String(v == null ? '' : v).trim();
    s = s.replace(/\s+/g, '');
    s = s.replace(/(周岁|岁)$/, '');
    s = s.replace(/^(男性|男孩|男)$/, '男').replace(/^(女性|女孩|女)$/, '女');
    s = s.replace(/^汉$/, '汉族');
    return s;
  }

  function sameValue(a, b, isNum) {
    var sa = String(a == null ? '' : a).trim();
    var sb = String(b == null ? '' : b).trim();
    if (sa === sb) return true;
    if (isNum) {
      // 数值项只看数："52 岁" 与 "52" 是同一个数
      var na = parseFloat(sa.replace(/[^0-9.\-]/g, ''));
      var nb = parseFloat(sb.replace(/[^0-9.\-]/g, ''));
      if (!isNaN(na) && !isNaN(nb)) return Math.abs(na - nb) < 1e-9;
    }
    return looseText(sa) === looseText(sb);
  }

  /* ---------------- 关于"跨页" ----------------
   * 曾经有个"跨页找回"的紫色状态：值是从别的报告里找回来的就标紫。
   * 后来去掉了，因为它在真实流程里几乎必然发生——一份综合生化单本来就同时
   * 供着肝功能、肾功能、电解质三个页面，用户上传本来也不按页面分。
   * 紫色一多，红黄绿就没有信息量了："报错太多等于没报错"。
   * 现在的处理：谁能对上指标就用谁的值，来源列写清楚是哪份报告、哪一天；
   * 只有"该有却没有"（必填缺失）才是红的。 */

  function cellState(pid, indId) {
    var list = obsOf(pid, indId);
    var ind = window.Library.byId(indId);
    var isNum = !ind || (ind.type || 'num') === 'num';

    // 同一份报告里重复出现同一项（页眉一遍、表格一遍），只算一条：
    // 取置信度最高的那条。不然自己跟自己都会"两处不一致"。
    var byAsset = {};
    list.forEach(function (o) {
      var cur = byAsset[o.assetId];
      var better = !cur || (o.confidence == null ? 0 : o.confidence) > (cur.confidence == null ? 0 : cur.confidence);
      if (better) byAsset[o.assetId] = o;
    });
    var all = Object.keys(byAsset).map(function (k) { return byAsset[k]; })
      .filter(function (o) { return String(o.value || '').trim() !== ''; });

    // 时间轴：同一个人住过几次院，每次的值本来就该不一样，那不是"对不上"。
    var dates = [];
    all.forEach(function (o) {
      var d = obsDate(o);
      if (d && dates.indexOf(d) === -1) dates.push(d);
    });
    dates.sort();

    var picked = S.dateFilter
      ? all.filter(function (o) { return obsDate(o) === S.dateFilter; })
      : all;

    // 没识别到：只有标了必填的才算质控问题，其余只是"这次没提供"
    if (!picked.length) {
      return {
        state: isRequired(indId) ? 'missing' : 'absent',
        obs: list[0] || null, list: list, dates: dates
      };
    }

    // 冲突只在同一次就诊内判：同一天两份报告给了两个值，那才是真对不上。
    // 不同日期之间的差异走时间轴，不标红。
    //
    // 另一条优先级：同一次就诊里，表格里的值优先于叙述里摘出来的值。
    // 出院记录正文常把当天的化验结果写一遍，那是"没有化验单时的备用来源"，
    // 不能跟真正的化验单并列去比——比出来必然是假冲突。
    var byDate = {};
    picked.forEach(function (o) {
      var d = obsDate(o);
      (byDate[d] = byDate[d] || []).push(o);
    });
    var conflictList = null;
    var effective = [];
    Object.keys(byDate).forEach(function (d) {
      var g = byDate[d];
      var tab = g.filter(function (o) { return o.src !== 'narrative'; });
      var use = tab.length ? tab : g;          // 有表格就用表格，没有才用叙述
      effective = effective.concat(use);
      if (!conflictList && tab.length > 1) {
        var first = tab[0];
        if (tab.some(function (o) { return !sameValue(o.value, first.value, isNum); })) conflictList = tab;
      }
    });
    if (conflictList) {
      return { state: 'conflict', obs: conflictList[0], list: conflictList, dates: dates };
    }

    // 没有冲突时，取最近一次就诊的那条；同一日期内取置信度最高的。
    var sorted = effective.slice().sort(function (a, b) {
      var da = obsDate(a), db = obsDate(b);
      if (da !== db) return da < db ? 1 : -1;
      return (b.confidence == null ? 0 : b.confidence) - (a.confidence == null ? 0 : a.confidence);
    });
    var o = sorted[0];
    var extra = { obs: o, list: sorted, dates: dates };

    if (o.warn === 'unit') {
      // 项目认出来了，但单位跟标准库不是一类（比如报告用 mg/dL、库里是 mmol/L）。
      // 不丢值，标成存疑，让人确认要不要换算。
      extra.state = 'low';
      return extra;
    }
    if (o.method !== 'manual' && o.confidence != null && o.confidence < LOW_CONFIDENCE) {
      extra.state = 'low';
      return extra;
    }

    extra.state = 'ok';
    return extra;
  }

  function obsDate(o) {
    return String((o && o.date) || '').trim();
  }

  /* 报告上印的是 52.800、7.240 这种，模型照抄没错，但显示和导出都难看。
     只收拾"整数部分 + 全部是数字"的纯数字，别的（<500、70%+、阴性）一概不动。 */
  function tidyNumber(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^-?\d+\.\d+$/.test(s)) return s;
    if (s.charAt(s.length - 1) !== '0') return s;
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }

  /* 模型有时候把单位一起塞进结果："168 U/L"、"5.54*10^9/L"。
   * 数值项的结果列只该有数，单位要回到单位列去，否则导出会变成
   * "结果=5.54*10^9/L、单位=10^9/L" 这种重复。
   * 返回 { value, unit }；unit 为空表示原文里没单位。 */
  function splitValueUnit(v) {
    var s = String(v == null ? '' : v).trim();
    // 科学计数法（1.2E+03、5.4e-2）整体是数值，不能把 E+03 当成单位拆走
    if (/^-?\d+(?:\.\d+)?[Ee][+-]?\d+$/.test(s)) return { value: s, unit: '' };
    var m = s.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
    if (!m) return { value: s, unit: '' };
    return { value: m[1], unit: (m[2] || '').trim() };
  }

  /* 定性结果统一写法：模型有时把 ( + ) 连括号一起抄，
   * 而库里存的是 "+"。只处理"整个值就是一个括号包着的符号"这种情况。 */
  function normalizeQual(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/^[（(]\s*([+\-±＋－])\s*[）)]$/);
    if (m) {
      var ch = m[1];
      if (ch === '＋') ch = '+';
      if (ch === '－') ch = '-';
      return ch;
    }
    return s;
  }

  /* ---------------- 渲染：患者 ---------------- */

  function renderPatients() {
    var box = $('#patient-list');
    box.innerHTML = S.patients.map(function (p) {
      var n = assetsOf(p.id).length;
      var active = p.id === S.currentId ? ' active' : '';
      return '<div class="patient' + active + '" data-pid="' + p.id + '">' +
        '<div><div class="patient-code">' + esc(p.code) + '</div>' +
        '<div class="patient-meta">' + n + ' 份报告</div></div>' +
        '<button class="del" data-del="' + p.id + '" title="移除">×</button>' +
        '</div>';
    }).join('');

    if (!S.patients.length) {
      box.innerHTML = '<div class="patient-meta">还没有患者</div>';
      return;
    }

    /* 患者多的时候列表会滚动。新建或切换后，把当前这位滚进视野，
       否则刚点"添加患者"生成的新患者正好落在可视区外，看着像没加上。 */
    var act = box.querySelector('.patient.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- 渲染：报告缩略图 ---------------- */

  function renderAssets() {
    var p = current();
    var box = $('#asset-strip');
    var list = p ? assetsOf(p.id) : [];
    box.innerHTML = list.map(function (a) {
      var label = a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex;
      if (a.docType && a.status === 'done') label += ' · ' + a.docType;
      var st;
      if (a.status === 'done') st = '<span class="asset-state ok">已识别</span>';
      else if (a.status === 'running') st = '<span class="asset-state run">识别中</span>';
      else if (a.status === 'skipped') st = '<span class="asset-state" title="长边不到 900 像素，没送去识别">已跳过</span>';
      else if (a.status === 'error') {
        st = '<span class="asset-state err" title="' + esc(a.error || '') + '">失败</span>';
      } else st = '<span class="asset-state">待识别</span>';
      if (a.lowRes) st = '<span class="asset-state err" title="长边 ' + Math.max(a.width, a.height) + ' 像素，太小，读不出小字">图太小</span>';
      return '<div class="asset' + (a.lowRes ? ' lowres' : '') + '" data-aid="' + a.id + '" title="' + esc(a.name) + '">' +
        '<img src="' + a.dataUrl + '" alt="">' +
        '<div class="asset-foot"><span>' + esc(label) + '</span>' + st + '</div>' +
        '</div>';
    }).join('');

    // 有报告以后把上传区收成一条，别再占着半屏
    var dz = $('#dropzone');
    var has = list.length > 0;
    dz.classList.toggle('compact', has);
    $('#dz-title').textContent = has
      ? '已上传 ' + list.length + ' 页，可继续追加'
      : '把报告图片或 PDF 拖到这里';
    $('#dz-pick').textContent = has ? '继续上传' : '选择文件';
  }

  /* ---------------- 渲染：概览 ---------------- */

  function renderStats() {
    var p = current();
    var ids = targetIds();
    var n = { missing: 0, low: 0, ok: 0, conflict: 0, absent: 0 };
    if (p) {
      ids.forEach(function (id) {
        var s = cellState(p.id, id).state;
        if (s === 'conflict') n.conflict++; else n[s]++;
      });
    }
    var red = n.missing + n.conflict;
    $('#stats').innerHTML =
      '<div class="stat red"><b>' + red + '</b><span>必填缺失</span></div>' +
      '<div class="stat amber"><b>' + n.low + '</b><span>存疑</span></div>' +
      '<div class="stat green"><b>' + n.ok + '</b><span>已识别</span></div>';
  }

  /* ---------------- 渲染：表格 ---------------- */

  // 红在前、绿在中、灰在后。翻表格的人最先要看的永远是"哪里出问题了"。
  var STATE_RANK = { conflict: 0, missing: 1, low: 2, ok: 3, absent: 4 };

  function assetLabel(a, date) {
    var label = a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex;
    var ds = String(date || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(ds)) ds = ds.slice(5, 10);   // 只留月日，省地方
    return label + (ds ? ' · ' + ds : '');
  }

  function srcLabel(assetId, date) {
    var a = S.assets.filter(function (x) { return x.id === assetId; })[0];
    return a ? assetLabel(a, date) : '未知来源';
  }

  function badgeOf(state) {
    var text = {
      ok: '已识别', low: '置信度低', missing: '必填缺失',
      conflict: '两处不一致', absent: '未提供'
    }[state];
    return text ? '<span class="badge ' + state + '">' + text + '</span>' : '';
  }

  function renderTable() {
    var body = $('#grid-body');
    var p = current();

    if (!p) {
      body.innerHTML = '<tr><td colspan="5" class="empty-hint">先添加一位患者</td></tr>';
      return;
    }
    if (!assetsOf(p.id).length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-hint">这位患者还没有报告，先在上面上传</td></tr>';
      return;
    }

    var sel = loadSelected();
    var tgt = targetIds();

    renderDateBar();

    // 指标按"第一个包含它的已选页面"归组；同一个指标出现在多个页面里（综合生化）
    // 只在第一处出现一次，免得同一项在表里重复两遍。
    var own = {};
    var groups = [];
    window.Library.pages().forEach(function (pg) {
      if (sel.ids.indexOf(pg.id) === -1) return;
      var keep = [];
      pg.ids.forEach(function (id) {
        if (own[id] || tgt.indexOf(id) === -1) return;
        own[id] = pg.id;
        keep.push(id);
      });
      if (keep.length) groups.push({ page: pg, ids: keep });
    });

    var html = groups.map(function (g) {
      var rows = g.ids.map(function (id) {
        var c = cellState(p.id, id);
        return { id: id, c: c, rank: STATE_RANK[c.state] != null ? STATE_RANK[c.state] : 9 };
      });
      rows.sort(function (a, b) { return a.rank - b.rank; });

      var n = { conflict: 0, missing: 0, low: 0, ok: 0, absent: 0 };
      rows.forEach(function (r) { n[r.c.state] = (n[r.c.state] || 0) + 1; });

      // 用户点过就听用户的；没点过时，一个字都没读到的页面默认收起，省得 140 行里翻半天。
      // 注意：默认值不写回 S.collapse——否则第一次渲染时的"全灰"状态会被永久记住。
      var stored = S.collapse[g.page.id];
      var collapsed = stored === undefined
        ? ((n.conflict + n.missing + n.low + n.ok) === 0)
        : stored;

      var countBits = [];
      if (n.conflict) countBits.push('<b class="c-red">' + n.conflict + ' 处不一致</b>');
      if (n.missing) countBits.push('<b class="c-red">' + n.missing + ' 缺</b>');
      if (n.low) countBits.push('<b class="c-amber">' + n.low + ' 存疑</b>');
      if (n.ok) countBits.push('<b class="c-green">' + n.ok + ' 已识别</b>');
      if (n.absent) countBits.push('<b class="c-gray">' + n.absent + ' 未提供</b>');

      var head = '<tr class="group-row" data-page="' + esc(g.page.id) + '">' +
        '<td colspan="5"><span class="caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="gname">' + esc(g.page.name) + '</span>' +
        '<span class="gcount">' + countBits.join(' · ') + '</span></td></tr>';

      var bodyRows = rows.map(function (r) {
        var ind = window.Library.byId(r.id);
        var c = r.c;
        var value = c.obs && c.obs.value != null ? String(c.obs.value) : '';
        var isNum = (ind.type || 'num') === 'num';

        var srcCell = '';
        if (c.state === 'conflict' && c.list && c.list.length > 1) {
          // 冲突就把几个来源全列出来，点一下能看到每一份的原文
          var labels = c.list.slice(0, 3).map(function (o) { return srcLabel(o.assetId, o.date); });
          if (c.list.length > 3) labels.push('等 ' + c.list.length + ' 份');
          srcCell = '<button class="src-link conflict-src" data-cmp="' + esc(r.id) + '" ' +
            'title="点开看每一份报告读到的值和日期">' + esc(labels.join(' / ')) + '</button>';
        } else if (c.obs && c.obs.assetId) {
          var a = S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0];
          if (a) {
            srcCell = '<button class="src-link" data-src="' + a.id + '">' +
              esc(assetLabel(a, c.obs.date)) + '</button>';
            // 从叙述段落里摘出来的值：来源照样可点，但加个标记，说明它不是从化验单的表格里来的
            if (c.obs.src === 'narrative') {
              srcCell += ' <span class="src-tag" title="这个值是从正文叙述里摘出来的，不是化验单表格">文中</span>';
            }
          }
        }

        // 这个指标在别的就诊日期上还有值：提醒一下"还有几次"，免得以为只有这一次
        if (!S.dateFilter && c.dates && c.dates.length > 1) {
          srcCell += ' <button class="date-hint" data-cmp="' + esc(r.id) + '" ' +
            'title="点开看每次就诊的值">另有 ' + (c.dates.length - 1) + ' 次</button>';
        }

        // 参考范围优先用报告上印的那一栏：各实验室按性别、年龄分组，比库里的默认值准
        var refText = (c.obs && String(c.obs.ref || '').trim()) || (isNum ? ind.ref : '');
        return '<tr class="' + c.state + '"' + (collapsed ? ' hidden' : '') + ' data-ind="' + r.id + '">' +
          '<td><div class="ind-name"><span class="ind-dot ' + c.state + '"></span>' +
            '<div><div>' + esc(ind.name) + '</div><div class="ind-code">' + esc(ind.id) + '</div></div></div></td>' +
          '<td><input class="val-input" data-ind="' + r.id + '" value="' + esc(value) + '" placeholder="未识别"></td>' +
          '<td>' + esc(isNum ? ind.unit : (ind.type === 'date' ? '日期' : '')) + '</td>' +
          '<td>' + esc(refText) + '</td>' +
          '<td>' + srcCell + ' ' + badgeOf(c.state) + '</td>' +
          '</tr>';
      }).join('');

      return head + bodyRows;
    }).join('');

    body.innerHTML = html || '<tr><td colspan="5" class="empty-hint">本次没有勾选任何页面</td></tr>';
  }

  function renderAll() {
    var p = current();
    $('#patient-title').textContent = p ? p.code : '尚无患者';
    $('#patient-sub').textContent = p
      ? (assetsOf(p.id).length + ' 份报告 · 要看 ' + targetIds().length + ' 项，其中必填 ' + requiredIds().length + ' 项')
      : '先添加一位患者，再上传其名下的报告';
    renderPageChecks();
    renderPatients();
    renderAssets();
    renderStats();
    renderTable();
    cacheSchedule();
  }

  /* ---------------- 时间轴 ---------------- */

  // 把一个患者身上出现过的就诊日期列出来，让人可以只看某一次。
  // 没有日期（手工填的、单据上没读到）的不进时间轴。
  function timelineDates(pid) {
    var seen = {}, out = [];
    S.observations.forEach(function (o) {
      if (o.patientId !== pid) return;
      var d = obsDate(o);
      if (!d || seen[d]) return;
      seen[d] = 1;
      out.push(d);
    });
    return out.sort();
  }

  function renderDateBar() {
    var bar = $('#date-bar');
    var p = current();
    var dates = p ? timelineDates(p.id) : [];
    if (dates.length < 2) {
      bar.hidden = true;
      bar.innerHTML = '';
      if (dates.length < 2 && S.dateFilter) S.dateFilter = '';
      return;
    }
    if (S.dateFilter && dates.indexOf(S.dateFilter) === -1) S.dateFilter = '';
    bar.hidden = false;
    bar.innerHTML =
      '<span class="date-label">时间轴</span>' +
      '<button class="date-chip' + (S.dateFilter ? '' : ' on') + '" data-date="">全部<span class="dc-note">取最近一次</span></button>' +
      dates.map(function (d) {
        var n = S.observations.filter(function (o) { return o.patientId === p.id && obsDate(o) === d; }).length;
        return '<button class="date-chip' + (S.dateFilter === d ? ' on' : '') + '" data-date="' + esc(d) + '">' +
          esc(d) + '<span class="dc-note">' + n + ' 项</span></button>';
      }).join('');
  }

  /* ---------------- 患者 ---------------- */

  function addPatient(silent) {
    var p = { id: uid('patient'), code: '患者 ' + String(S.patients.length + 1).padStart(2, '0') };
    S.patients.push(p);
    S.currentId = p.id;
    if (!silent) renderAll();
    return p;
  }

  function removePatient(pid) {
    S.patients = S.patients.filter(function (p) { return p.id !== pid; });
    S.assets = S.assets.filter(function (a) { return a.patientId !== pid; });
    S.observations = S.observations.filter(function (o) { return o.patientId !== pid; });
    if (S.currentId === pid) S.currentId = S.patients[0] ? S.patients[0].id : null;
    renderAll();
  }

  /* ---------------- 导入报告 ---------------- */

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('文件读取失败：' + file.name)); };
      r.readAsDataURL(file);
    });
  }

  // 大图先缩小：既省 token，也避免模型因分辨率过高而漏读
  function downscale(dataUrl, maxEdge) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: c.toDataURL('image/jpeg', JPEG_QUALITY), width: w, height: h });
      };
      img.onerror = function () { reject(new Error('这张图片打不开，可能已损坏')); };
      img.src = dataUrl;
    });
  }

  async function ingestImage(file, fileIndex) {
    var raw = await readAsDataUrl(file);
    var small = await downscale(raw, MAX_IMAGE_EDGE);
    var edge = Math.max(small.width, small.height);
    S.assets.push({
      id: uid('asset'),
      patientId: S.currentId,
      kind: 'image',
      name: file.name,
      fileIndex: fileIndex,
      pageNo: 1,
      dataUrl: small.dataUrl,
      width: small.width,
      height: small.height,
      lowRes: edge < MIN_EDGE,
      status: 'pending',
      error: ''
    });
    if (edge < MIN_EDGE) smallCount++;
  }

  async function ingestPdf(file, fileIndex) {
    if (!window.PdfTools) throw new Error('PDF 组件没有加载，请刷新页面');
    var pdf = await window.PdfTools.openPdf(file);
    var total = Math.min(pdf.numPages, PDF_MAX_PAGES);

    // 有文字层的 PDF：把文字也留下来。模型看图 + 看字，比只看图稳，
    // 尤其是 0 和 O、1 和 l、μ 和 u 这种印刷上就难分的字符。
    var texts = {};
    try {
      var txt = await window.PdfTools.extractText(pdf, { maxTextPages: total, maxTextChars: 60000 });
      (txt.pages || []).forEach(function (pg) {
        var s = String(pg.text || '').trim();
        if (s.length >= 80) texts[pg.page] = s;
      });
    } catch (e) { texts = {}; }

    for (var i = 1; i <= total; i++) {
      var img = await window.PdfTools.renderPage(pdf, i, {
        dpi: 150,
        maxEdge: MAX_IMAGE_EDGE,
        imageType: 'image/jpeg',
        quality: JPEG_QUALITY
      });
      S.assets.push({
        id: uid('asset'),
        patientId: S.currentId,
        kind: 'pdf',
        name: file.name,
        fileIndex: fileIndex,
        pageNo: i,
        dataUrl: img.dataUrl,
        width: img.width,
        height: img.height,
        pageText: texts[i] || '',
        status: 'pending',
        error: ''
      });
    }
    if (pdf.numPages > PDF_MAX_PAGES) {
      toast('这份 PDF 有 ' + pdf.numPages + ' 页，只取了前 ' + PDF_MAX_PAGES + ' 页', 'err');
    }
    await pdf.destroy();
  }

  async function handleFiles(files) {
    if (!S.currentId) addPatient(true);
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;

    var fileIndex = assetsOf(S.currentId).reduce(function (m, a) {
      return Math.max(m, a.fileIndex || 0);
    }, 0);

    smallCount = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      fileIndex++;
      try {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          await ingestPdf(f, fileIndex);
        } else if (/^image\//.test(f.type)) {
          await ingestImage(f, fileIndex);
        } else {
          toast('跳过不支持的文件：' + f.name, 'err');
          fileIndex--;
        }
      } catch (e) {
        fileIndex--;
        toast(e.message || String(e), 'err');
      }
      renderAll();
    }
    renderAll();
    if (smallCount) {
      toast('有 ' + smallCount + ' 张图的长边不到 ' + MIN_EDGE + ' 像素（像是聊天里存下来的缩略图）。' +
        '这个尺寸连印刷体都读不清，模型只会给出低置信度的结果。请换成原图或重新拍照。', 'err');
    }
  }

  /* ---------------- 识别 ---------------- */

  /* 只让模型看一眼标题和表格结构，判断这是什么文书。这一步很便宜（几百 token），
     换来的是后面那一大段候选指标能砍掉八成。 */
  var CLASSIFY_PROMPT = [
    '看这一页病历或检验单据，判断它属于哪一种文书。只看最上面的标题、抬头和版面结构，不要逐行读数据。',
    '',
    '可选类型：血常规、生化、出凝血、免疫、病毒学、FISH、病理、骨髓流式、影像、病案首页、出院小结、其他。',
    '说明：',
    '- 出院小结：出院记录、出院诊断书、阶段小结、出院病情证明书；标题里出现"出院"两个字基本就是它；',
    '- 生化：肝功能、肾功能、电解质、血糖、心肌酶等，合并成一张或分成几张都算生化；',
    '- 免疫：免疫球蛋白、补体、β2微球蛋白、铁蛋白、血沉、免疫固定电泳；',
    '- 影像：CT、MRI、超声、X 线、PET-CT 的文字报告（不是影像胶片本身）；',
    '- 出院小结：出院记录、出院小结、阶段小结；',
    '- 病案首页：住院病案首页及其附页；',
    '- 病理：病理报告、免疫组化；FISH 是荧光原位杂交，单独一类；',
    '- 骨髓流式：流式细胞术的免疫分型报告。',
    '拿不准就填"其他"。',
    '',
    '只输出 JSON：{"doc_type":"...","title":"这页最上面的标题原文","confidence":0.0}'
  ].join('\n');

  async function classifyAsset(asset) {
    var res = await window.Model.vision(asset.dataUrl, CLASSIFY_PROMPT, { maxTokens: 300, json: true });
    var d = {};
    try { d = parseJson(res.text); } catch (e) { d = {}; }
    var t = String(d.doc_type || '').trim();
    if (!Object.prototype.hasOwnProperty.call(DOC_PAGES, t)) t = '其他';
    return { type: t, title: String(d.title || ''), confidence: d.confidence };
  }

  /* 这类文书上应该出现哪些指标 = 它对应的页面 + 页眉字段，再和"本次要看"取交集。
   * 出院小结是例外：它的正文里常把当天的化验结果又写一遍，
   * 那些值是对应化验单没上传时的备用来源，所以候选开放成"本次所有页面"。 */
  function candidatesFor(type) {
    /* 页眉/身份字段（姓名、性别、年龄、住院号、就诊日期、医院）只从"病案首页"取。
     * 为什么：同一个患者每一份化验单的页眉都会重复印一遍，让模型到处抄只会
     * 制造"男 / 男性""40 / 40岁"这种没意义的差异，还白花 token。
     * 病案首页才是这些字段的正式出处。 */
    var want = [];
    if (type === '出院小结') {
      // 出院记录的正文里常把当天的化验结果又写一遍，那些值是对应化验单
      // 没上传时的备用来源，所以候选开放成"本次所有页面"（页眉字段除外）
      targetIds().forEach(function (id) {
        if (HEADER_IDS.indexOf(id) === -1 && want.indexOf(id) === -1) want.push(id);
      });
    } else {
      (DOC_PAGES[type] || []).forEach(function (pid) {
        var pg = window.Library.pageById(pid);
        if (!pg) return;
        pg.ids.forEach(function (id) { if (want.indexOf(id) === -1) want.push(id); });
      });
    }
    var tgt = targetIds();
    return want.filter(function (id) { return tgt.indexOf(id) !== -1 && window.Library.byId(id); });
  }

  function buildPrompt(ids, pageText, docType) {
    var lines = ids.map(function (id) {
      var ind = window.Library.byId(id);
      if (!ind) return '';
      var alias = (ind.aliases || []).filter(function (a) {
        return a !== ind.id && a !== ind.name;
      }).slice(0, 3);
      var tail = '';
      if ((ind.type || 'num') === 'num') {
        if (ind.unit) tail = '，单位 ' + ind.unit;
      } else if (ind.type === 'date') {
        tail = '，日期项，写成 YYYY-MM-DD';
      } else {
        tail = '，文本项，照抄原文';
      }
      return ind.id + ' = ' + ind.name +
        (alias.length ? '（报告上可能写：' + alias.join('、') + '）' : '') + tail;
    }).filter(Boolean).join('\n');

    var body = [
      '你是一名医学检验报告的信息抽取助手。现在给你一页报告的照片。',
      '',
      '任务：读出这一页上真实存在的信息，只输出 JSON。',
      '',
      '输出格式：',
      '{"report_type":"血常规|生化|免疫|出凝血|病毒学|FISH|病理|骨髓流式|影像|病案首页|出院小结|其他","report_date":"YYYY-MM-DD 或 空字符串",',
      ' "items":[{"raw_name":"报告上的原文项目名","indicator":"标准代号或 null",',
      '           "value":"原文","unit":"单位原文","ref":"参考范围原文","src":"table 或 narrative","confidence":0.0}]}',
      '',
      '硬性要求：',
      '1. 只输出 JSON，不要解释，不要 markdown 代码块。',
      '2. 只写图片上真实出现的内容。看不清、被裁掉、字迹模糊的，value 写 null、confidence 写 0.3 以下。',
      '   绝对不要根据常识补全，也不要猜。宁可漏，不可编。',
      '3. 数值保留原文写法，不要换算单位，不要四舍五入。',
      '4. indicator 只能从下面的候选里选。这一页没有的项目，不要出现在 items 里。',
      '5. 如果这一页根本不是报告（比如身份证、发票、空白页），items 返回空数组。',
      '6. 文本项（姓名、性别、诊断、结论、报告正文等）必须逐字照抄：照抄错别字、简写、符号、' +
      '   换行处的断字，一个字都不许改。不要纠正、不要润色、不要补全、不要翻译、不要合并句子。',
      '   病历原文改一个字都算错——这类字段的用途是把原文搬过去，不是把它写得更好。',
      '7. 页眉或表头里印着姓名、性别、年龄、住院号，只要清晰可辨，也照抄下来（记在对应代号下），' +
      '不要因为它们"不像检验项目"就跳过。',
      '8. 定性结果（免疫组化的 +、−、±，FISH 的阳性/阴性，下拉框里的"未做""不详"）照原样输出，' +
      '   只写图上印着的那个，不要自己判断该是哪一种。',
      '9. 叙述段落（入院情况、住院经过、出院医嘱、讨论区）里的数字，只有"项目名 + 数值 + 单位"紧挨着写成一句' +
      '   完整陈述时才抽，并且 src 填 "narrative"。例如"乳酸脱氢酶 168 U/L""EBV-DNA <500 copies/mL"' +
      '"血红蛋白:101g/L" 都要抽；而"住院 7 天""体温 36.5℃"这种跟候选指标无关的、或者没写项目名的数字，一律不要抽。',
      '10. 表格里抽出来的项目，src 一律填 "table"。判断依据是它有没有处在一张有表头、有行的表里；' +
      '    散落在句子中间的算 narrative。这一栏会显示给人看，填错比不填更糟。',
      '11. 免疫组化、FISH 这类结果常常写成一长串"CD20（-），CD79α（-），CD3（+），Ki-67（70%+）"，' +
      '    一个括号就是一个项目。请逐个拆成独立的 items，不要只报其中一两个，也不要漏掉写在行尾的。',
      ''
    ];
    if (docType && DOC_PAGES[docType]) {
      body.push('这一页的文书类型是【' + docType + '】。候选指标只列了这类文书上会出现的项目，' +
        '别的文书的项目不要抽。', '');
      if (docType === '出院小结' || docType === '影像' || docType === '病理') {
        body.push('这一类文书的正文本身就是一段叙述，没有整齐的表格。按第 9 条：正文里写成' +
          '"项目名 + 数值 + 单位"的句子照抽，src 填 "narrative"。' +
          '它们是对应化验单没上传时的备用来源，不要因为"它不是化验单"就整段跳过。', '');
      }
    }
    body.push('候选指标：');
    body.push(lines);

    if (pageText) {
      body = body.concat([
        '',
        '【这一页同时提供可直接复制的文字层】',
        '下面是同一页的 PDF 文字层，用来校对印刷体上容易看错的字符（0/O、1/l、μ/u、小数点）。',
        '它不是唯一事实：文字层可能有错位、丢失或错行。',
        '两者冲突时，以图片上看到的内容为准；图片上看不清就按第 2 条处理，不要因为文字层"看起来对"就抬高置信度。',
        '',
        pageText.slice(0, 4000)
      ]);
    }

    return body.join('\n');
  }

  function parseJson(text) {
    var t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var a = t.indexOf('{');
    if (a === -1) throw new Error('模型没有返回 JSON');
    var body = t.slice(a);

    var exact = body.slice(0, body.lastIndexOf('}') + 1);
    try { return JSON.parse(exact); } catch (e) { /* 继续抢救 */ }

    /* 走到这里，多半是"写了一半被截断"。从后往前找最后一个能闭合的位置，
       把 items 数组和根对象补上，能救回几条就救回几条——总比整页判失败好。 */
    for (var i = body.lastIndexOf('}'); i > 0; i = body.lastIndexOf('}', i - 1)) {
      var fixed = body.slice(0, i + 1) + ']}';
      try {
        var obj = JSON.parse(fixed);
        if (obj && typeof obj === 'object') return obj;
      } catch (e2) { /* 再往前退一个对象 */ }
    }
    var err = new Error('模型返回的 JSON 不完整，通常是这一页内容太多、输出被截断了。');
    err.code = 'badjson';
    throw err;
  }

  async function recognizeAsset(asset) {
    asset.status = 'running';
    renderAssets();

    // 第一步：先认这是什么文书（便宜）。用户手动指定过就跳过，直接信他。
    var cls = asset.typeForced
      ? { type: asset.docType, title: asset.docTitle || '', confidence: null }
      : await classifyAsset(asset);
    asset.docType = cls.type;
    asset.docTitle = cls.title;

    // 第二步：只把这类文书上应该出现的指标发给它。
    var ids = candidatesFor(cls.type);
    var data = { report_date: '' };
    var items = [];
    var res = null;
    if (ids.length) {
      var prompt = buildPrompt(ids, asset.pageText, cls.type);
      // 先给 2400 的额度；如果被截断或写空，换 6000 再来一次。
      // 实测"内容多的页"（病理、出院记录）会卡在这条线上，跟图片清不清楚无关。
      var budgets = [2400, 6000];
      for (var bi = 0; bi < budgets.length; bi++) {
        try {
          res = await window.Model.vision(asset.dataUrl, prompt, { maxTokens: budgets[bi] });
          data = parseJson(res.text);
          asset.retried = bi > 0;
          break;
        } catch (e) {
          var code = e.code || '';
          var retryable = code === 'truncated' || code === 'empty' || code === 'badjson';
          if (!retryable || bi === budgets.length - 1) throw e;
        }
      }
      items = Array.isArray(data.items) ? data.items : [];
    }

    // 先清掉这份报告旧的识别结果，保证"一份报告只抽一次"
    S.observations = S.observations.filter(function (o) { return o.assetId !== asset.id; });

    var added = 0, unmatched = [];
    items.forEach(function (it) {
      if (!it) return;
      var hit = window.IndicatorLib.match(it.raw_name, it.indicator, it.unit);
      if (!hit || ids.indexOf(hit.id) === -1) {
        if (it.raw_name) unmatched.push(it.raw_name);
        return;
      }
      var v = it.value == null ? '' : String(it.value).trim();
      var unit = it.unit || '';
      var ind0 = window.Library.byId(hit.id);
      if (!ind0 || (ind0.type || 'num') === 'num') {
        // "168 U/L" 拆成 值=168、单位=U/L；模型没给单位时用拆出来的
        var su = splitValueUnit(v);
        v = tidyNumber(su.value);
        if (!unit && su.unit) unit = su.unit;
      } else {
        v = normalizeQual(v);
      }
      S.observations.push({
        id: uid('obs'),
        patientId: asset.patientId,
        assetId: asset.id,
        rawName: it.raw_name || '',
        indicatorId: hit.id,
        method: hit.method,
        score: hit.score,
        warn: hit.warn || '',
        value: v,
        unit: unit,
        ref: it.ref || '',
        date: data.report_date || '',
        src: String(it.src || '').toLowerCase() === 'narrative' ? 'narrative' : 'table',
        confidence: typeof it.confidence === 'number' ? it.confidence : null
      });
      added++;
    });

    asset.status = 'done';
    asset.error = '';
    asset.reportType = data.report_type || cls.type;
    asset.reportDate = data.report_date || '';
    asset.unmatched = unmatched;
    return { added: added, unmatched: unmatched, ms: res ? res.ms : 0, usage: res ? res.usage : null, type: cls.type };
  }

  /* 单页重试：失败的那一份点一下就重来，不用整批重跑 */
  async function retryOne(asset) {
    if (!asset || asset.status === 'running') return;
    asset.status = 'running';
    asset.error = '';
    renderAssets();
    try {
      await recognizeAsset(asset);
    } catch (e) {
      asset.status = 'error';
      asset.error = e.message || String(e);
      toast('这一页还是失败：' + asset.error, 'err');
    }
    renderAll();
  }

  async function runRecognize() {
    if (S.running) return;
    var p = current();
    if (!p) { toast('先添加一位患者', 'err'); return; }

    // 本地服务断了的话，请求根本发不出去，先告诉用户真正的原因
    if (heartbeat.offline) {
      var back = await ping();
      if (back !== 'ok') { toast('本地服务断了（start.bat 那个黑窗口还在吗？）。重新双击 start.bat 再试。', 'err'); return; }
    }

    var todo = assetsOf(p.id).filter(function (a) { return a.status !== 'done'; });

    // 长边不到 900 像素的图不送去识别。实测这种图不会"读得差一点"，
    // 而是要么卡很久最后返回空，要么读成相邻的、看着很像的数字——
    // 后者会被显示成绿色，比读不出来危险得多。
    var tooSmall = todo.filter(function (a) { return a.lowRes; });
    if (tooSmall.length) {
      todo = todo.filter(function (a) { return !a.lowRes; });
      toast('有 ' + tooSmall.length + ' 张图太模糊（长边不到 900 像素），已跳过。换成手机原图再试。', 'err');
      tooSmall.forEach(function (a) { a.status = 'skipped'; });
      renderAll();
    }

    if (!todo.length) {
      if (!tooSmall.length) toast('这位患者的报告都识别过了。要重来请先清空本次任务。');
      return;
    }

    S.running = true;
    setRunning(true);
    var done = 0, failed = 0;

    var queue = todo.slice();
    async function worker() {
      while (queue.length) {
        var a = queue.shift();
        try {
          // 模型偶发返回坏 JSON 或限流，重试一次通常就好了。
          // 演示现场不能因为一次抖动就让一页报告变成"失败"。
          try {
            await recognizeAsset(a);
          } catch (e1) {
            if (e1 && e1.name === 'AbortError') throw e1;
            a.status = 'pending';
            await new Promise(function (r) { setTimeout(r, 900); });
            await recognizeAsset(a);
          }
        } catch (e) {
          a.status = 'error';
          a.error = e.message || String(e);
          failed++;
          toast('第 ' + a.fileIndex + ' 份报告识别失败：' + a.error, 'err');
        }
        done++;
        setPill('识别中 ' + done + '/' + todo.length, 'busy');
        renderAll();
      }
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());
    await Promise.all(workers);

    S.running = false;
    setRunning(false);
    updatePill();
    renderAll();

    var u = window.Model.getUsage();
    toast('识别完成：' + Math.max(0, todo.length - failed) + ' 页成功，' + failed + ' 页失败。' +
      '本次累计调用 ' + u.calls + ' 次，平均 ' + u.avgMs + ' ms/次', failed ? 'err' : 'ok');
  }

  function setRunning(on) {
    var btn = $('#btn-run');
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spin"></span>识别中…' : '开始识别';
  }

  /* ---------------- 顶栏状态 ---------------- */

  function setPill(text, kind) {
    var el = $('#model-pill');
    el.textContent = text;
    el.className = 'pill pill-' + (kind || 'idle');
  }

  function updatePill() {
    var c = window.Model.getConfig();
    if (!c.hasKey) { setPill('模型未配置', 'idle'); return; }
    setPill(c.model + ' · 就绪', 'ok');
  }

  /* ---------------- 弹层 ---------------- */

  function openModal(html, cls) {
    var m = $('#modal');
    $('#modal-box').className = 'modal-box' + (cls ? ' ' + cls : '');
    $('#modal-box').innerHTML = '<button class="modal-close" data-close="1">×</button>' + html;
    m.hidden = false;
  }

  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-box').className = 'modal-box';
    $('#modal-box').innerHTML = '';
    libForm = null;
  }

  function openSettings() {
    var c = window.Model.getConfig();
    openModal(
      '<h3>模型设置</h3>' +
      '<div class="field"><label>API Key</label>' +
      '<input id="cfg-key" type="password" placeholder="sk-..." value="' + esc(c.hasKey ? '••••••••' : '') + '">' +
      '<p class="note">只保存在这台电脑的浏览器里（localStorage），不会上传到任何地方，也不会写进导出的文件。' +
      '需要在模型服务商后台自行申请。</p></div>' +
      '<div class="field"><label>接口地址</label>' +
      '<input id="cfg-base" value="' + esc(c.base) + '">' +
      '<p class="note">默认 https://api.deepseek.com。换成别的服务商时，要确认它允许浏览器直接调用。</p></div>' +
      '<div class="field"><label>模型</label>' +
      '<input id="cfg-model" value="' + esc(c.model) + '">' +
      '<p class="note">必须是能看图的模型。纯文本模型不会报错，但会编出结果——这比失败更危险。</p></div>' +
      '<button id="cfg-save" class="btn primary">保存</button>'
    );

    $('#cfg-save').addEventListener('click', function () {
      var keyVal = $('#cfg-key').value.trim();
      var next = {
        base: $('#cfg-base').value,
        model: $('#cfg-model').value
      };
      if (keyVal && keyVal.indexOf('••') === -1) next.apiKey = keyVal;
      window.Model.setConfig(next);
      closeModal();
      updatePill();
      toast('已保存', 'ok');
    });
  }

  function openSource(assetId) {
    var a = S.assets.filter(function (x) { return x.id === assetId; })[0];
    if (!a) return;
    var related = S.observations.filter(function (o) { return o.assetId === assetId; });
    var rows = related.map(function (o) {
      var ind = window.IndicatorLib.byId(o.indicatorId);
      return '<div style="font-size:12px;color:#5b6472;margin-top:4px">' +
        esc(ind ? ind.name : o.indicatorId) + '：原文「' + esc(o.rawName) + '」→ ' + esc(o.value || '空') +
        (o.unit ? ' ' + esc(o.unit) : '') + '</div>';
    }).join('');

    var opts = Object.keys(DOC_PAGES).map(function (t) {
      return '<option value="' + esc(t) + '"' + (a.docType === t ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');

    openModal(
      '<h3>' + esc(a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex) + '</h3>' +
      '<p class="source-meta">' + esc(a.name) + '</p>' +
      '<div class="field" style="margin-bottom:10px">' +
        '<label>文书类型（认错了会少抽指标，可以在这里改）</label>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<select id="src-type" style="flex:1">' + opts + '</select>' +
          '<button id="src-retype" class="btn tiny">按这个类型重抽</button>' +
        '</div>' +
      '</div>' +
      '<img class="source-img" src="' + a.dataUrl + '" alt="">' +
      (rows ? '<div style="margin-top:12px">' + rows + '</div>' : '')
    );

    var btn = $('#src-retype');
    if (btn) {
      btn.addEventListener('click', function () {
        var t = $('#src-type').value;
        a.docType = t;
        a.typeForced = true;
        a.status = 'pending';                 // 下次点"开始识别"会重抽这一页
        S.observations = S.observations.filter(function (o) { return o.assetId !== a.id; });
        closeModal();
        renderAll();
        toast('已改成「' + t + '」，点"开始识别"重新抽取这一页', 'ok');
      });
    }
  }

  /* 两处不一致：把每一份报告读到的值并排列出来，点哪一行看哪一页。
     光说"不一致"没用——人得知道差在哪、差多少、是不是同一次就诊。 */
  function openCompare(indId) {
    var p = current();
    if (!p) return;
    var c = cellState(p.id, indId);
    var ind = window.Library.byId(indId);
    if (!ind) return;

    var rows = (c.list || []).map(function (o) {
      var a = S.assets.filter(function (x) { return x.id === o.assetId; })[0];
      return '<tr>' +
        '<td class="mono">' + esc(srcLabel(o.assetId, o.date)) + '</td>' +
        '<td><b>' + esc(o.value || '空') + '</b> ' + esc(o.unit || '') + '</td>' +
        '<td class="muted">' + esc(o.ref || '') + '</td>' +
        '<td class="tiny muted">' + esc(o.rawName || '') + '</td>' +
        '<td class="row-act">' +
          (a ? '<button class="link" data-src="' + a.id + '">看原页</button>' : '') +
          '<button class="link" data-pick="' + esc(o.id) + '">以此为准</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    var isConflict = c.state === 'conflict';
    var span = c.dates && c.dates.length > 1;

    openModal(
      '<h3>' + esc(ind.name) + (isConflict ? ' · 同一次就诊里对不上' : ' · 各次就诊的值') + '</h3>' +
      '<p class="note">' + (isConflict
        ? '同一次就诊的两份报告给了不同的值，那才是真的对不上。常见原因：其中一份不是检验单（比如出院记录正文里顺带提到过这个数），或者确实读错了。'
        : '这个指标在不同日期的报告里都有值。同一个人住过几次院，每次的数本来就不一样，所以不算"对不上"；' +
          '表格里默认显示最近一次，想只看某一次可以点上面的时间轴。') + '</p>' +
      '<table class="mini-grid cmp-table"><thead><tr>' +
        '<th>来源</th><th>读到的值</th><th>参考范围</th><th>原文项目名</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      (isConflict
        ? '<p class="note">点"以此为准"，其余来源会被丢掉，这一项立即变成已识别；也可以直接回到表格里改这个值。</p>'
        : (span ? '<p class="note">这里只做对照，不用裁决——它们本来就是不同时间的两次检查。</p>' : '')) +
      '',
      'wide'
    );
  }

  /* 人工裁决：认了某一条，同患者同指标的其它来源就作废——否则它永远红着。 */
  function pickObservation(obsId) {
    var keep = S.observations.filter(function (o) { return o.id === obsId; })[0];
    if (!keep) return;
    S.observations = S.observations.filter(function (o) {
      if (o.id === obsId) return true;
      return !(o.patientId === keep.patientId && o.indicatorId === keep.indicatorId);
    });
    keep.method = 'manual';          // 人工确认过的，不再因为置信度低而标黄
    keep.confidence = 1;
    closeModal();
    renderAll();
    toast('已按这一份为准', 'ok');
  }

  /* ---------------- 指标与页面 ---------------- */

  var libTab = 'ind';
  var libForm = null;   // {kind:'ind'|'page', mode:'new'|'edit', id:'...'}

  function libChangeDone(msg) {
    renderAll();
    if (msg) toast(msg, 'ok');
  }

  function indicatorRows(filterText) {
    var q = String(filterText || '').trim().toLowerCase();
    return window.Library.indicators().map(function (i) {
      var hay = (i.id + ' ' + i.name + ' ' + (i.aliases || []).join(' ')).toLowerCase();
      var hidden = q && hay.indexOf(q) === -1;
      return '<tr data-hay="' + esc(hay) + '"' + (hidden ? ' hidden' : '') + '>' +
        '<td class="req-cell"><input type="checkbox" class="ind-req" data-act="ind-req" value="' + esc(i.id) + '"' +
          (isRequired(i.id) ? ' checked' : '') + ' title="标了必填，缺了才标红"></td>' +
        '<td class="mono">' + esc(i.id) + '</td>' +
        '<td>' + esc(i.name) + '</td>' +
        '<td>' + esc((i.type || 'num') === 'num' ? i.unit : (i.type === 'date' ? '日期' : '文本')) + '</td>' +
        '<td>' + esc((i.type || 'num') === 'num' ? i.ref : '') + '</td>' +
        '<td class="tiny muted">' + esc((i.aliases || []).filter(function (a) {
          return a !== i.id && a !== i.name;
        }).slice(0, 4).join('、')) + '</td>' +
        '<td class="row-act">' +
          '<button class="link" data-act="ind-edit" data-id="' + esc(i.id) + '">编辑</button>' +
          '<button class="link danger" data-act="ind-del" data-id="' + esc(i.id) + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  function indicatorForm() {
    var isEdit = libForm && libForm.mode === 'edit';
    var ind = isEdit ? window.Library.byId(libForm.id) : null;
    if (isEdit && !ind) { libForm = null; return ''; }
    function v(k, d) { return esc(ind ? (ind[k] == null ? '' : ind[k]) : (d || '')); }
    var aliasText = ind ? (ind.aliases || []).filter(function (a) {
      return a !== ind.id && a !== ind.name;
    }).join('、') : '';

    return '<div class="lib-form">' +
      '<div class="form-grid">' +
        '<label>代号<input id="f-id" value="' + v('id') + '" placeholder="HGB" ' + (isEdit ? 'readonly' : '') + '></label>' +
        '<label>名称<input id="f-name" value="' + v('name') + '" placeholder="血红蛋白"></label>' +
        '<label>类型<select id="f-type">' +
          '<option value="num"' + ((ind ? ind.type : 'num') === 'num' ? ' selected' : '') + '>数值</option>' +
          '<option value="text"' + ((ind ? ind.type : '') === 'text' ? ' selected' : '') + '>文本（姓名、诊断这类）</option>' +
          '<option value="date"' + ((ind ? ind.type : '') === 'date' ? ' selected' : '') + '>日期</option>' +
        '</select></label>' +
        '<label>单位<input id="f-unit" value="' + v('unit') + '" placeholder="g/L"></label>' +
        '<label>参考范围<input id="f-ref" value="' + v('ref') + '" placeholder="130–175"></label>' +
        '<label>分组<input id="f-group" value="' + v('group', '自定义') + '"></label>' +
        '<label class="span2">同义词<input id="f-alias" value="' + esc(aliasText) + '" placeholder="血色素、Hb、HB（用逗号分隔）"></label>' +
      '</div>' +
      '<p class="note">同义词是省钱的关键：报告上写"血色素"时，先按这张表对上，就不用再问模型。' +
      '文本和日期类型不填单位与参考范围。</p>' +
      '<div class="form-act">' +
        '<button class="btn tiny primary" data-act="ind-save">保存</button>' +
        '<button class="btn tiny ghost" data-act="ind-cancel">取消</button>' +
      '</div>' +
    '</div>';
  }

  function pageRows() {
    return window.Library.pages().map(function (p) {
      return '<tr>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td class="mono">' + p.ids.length + '</td>' +
        '<td class="tiny muted">' + esc(p.ids.slice(0, 6).map(function (id) {
          var i = window.Library.byId(id); return i ? i.id : id;
        }).join('、')) + (p.ids.length > 6 ? ' …' : '') + '</td>' +
        '<td class="row-act">' +
          '<button class="link" data-act="page-edit" data-id="' + esc(p.id) + '">编辑</button>' +
          '<button class="link danger" data-act="page-del" data-id="' + esc(p.id) + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  function pageForm() {
    var isEdit = libForm && libForm.mode === 'edit';
    var page = isEdit ? window.Library.pageById(libForm.id) : null;
    if (isEdit && !page) { libForm = null; return ''; }
    var picked = page ? page.ids : [];

    var list = window.Library.indicators().map(function (i) {
      var on = picked.indexOf(i.id) !== -1;
      return '<label class="pick' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" value="' + esc(i.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="mono">' + esc(i.id) + '</span>' +
        '<span>' + esc(i.name) + '</span>' +
        '<span class="tiny muted">' + esc(i.unit) + '</span>' +
        '</label>';
    }).join('');

    return '<div class="lib-form">' +
      '<div class="form-grid">' +
        '<label class="span2">页面名称<input id="p-name" value="' + esc(page ? page.name : '') + '" placeholder="肝功能"></label>' +
      '</div>' +
      '<p class="note">勾选这一页要录的指标。一位患者的报告可能对应好几页，比如血常规 + 生化。</p>' +
      '<input id="p-search" class="pick-search" placeholder="筛选指标…">' +
      '<div id="p-picks" class="pick-list">' + list + '</div>' +
      '<div class="form-act">' +
        '<button class="btn tiny primary" data-act="page-save">保存</button>' +
        '<button class="btn tiny ghost" data-act="page-cancel">取消</button>' +
      '</div>' +
    '</div>';
  }

  function renderLibrary() {
    var inds = window.Library.indicators();
    var pages = window.Library.pages();
    var html =
      '<h3>指标与页面</h3>' +
      '<div class="tabs">' +
        '<button class="tab' + (libTab === 'ind' ? ' active' : '') + '" data-tab="ind">指标库 <b>' + inds.length + '</b></button>' +
        '<button class="tab' + (libTab === 'page' ? ' active' : '') + '" data-tab="page">页面 <b>' + pages.length + '</b></button>' +
        '<div class="tabs-right">' +
          '<button class="link tiny" data-act="lib-export">导出配置</button>' +
          '<button class="link tiny" data-act="lib-import">导入配置</button>' +
          '<button class="btn tiny primary" data-act="' + (libTab === 'ind' ? 'ind-new' : 'page-new') + '">+ ' +
            (libTab === 'ind' ? '新建指标' : '新建页面') + '</button>' +
        '</div>' +
      '</div>';

    if (libTab === 'ind') {
      html += (libForm && libForm.kind === 'ind' ? indicatorForm() : '') +
        '<input id="ind-search" class="pick-search" placeholder="搜索代号、名称或同义词…">' +
        '<div class="pane-scroll">' +
          '<table class="mini-grid"><thead><tr>' +
            '<th class="req-head" title="打勾的项，这次没录到就会标红">必填</th><th>代号</th><th>名称</th><th>单位</th><th>参考范围</th><th>同义词</th><th></th>' +
          '</tr></thead><tbody id="ind-rows">' + indicatorRows('') + '</tbody></table>' +
        '</div>';
    } else {
      html += (libForm && libForm.kind === 'page' ? pageForm() : '') +
        '<div class="pane-scroll">' +
          '<table class="mini-grid"><thead><tr>' +
            '<th>页面</th><th>指标数</th><th>包含</th><th></th>' +
          '</tr></thead><tbody>' + pageRows() + '</tbody></table>' +
        '</div>';
    }

    $('#modal-box').innerHTML = '<button class="modal-close" data-close="1">×</button>' + html;

    // 筛选只切行，不重画——否则输入框会丢焦点
    var s = $('#ind-search');
    if (s) {
      s.addEventListener('input', function () {
        var q = s.value.trim().toLowerCase();
        $$('#ind-rows tr').forEach(function (tr) {
          tr.hidden = !!(q && tr.getAttribute('data-hay').indexOf(q) === -1);
        });
      });
    }
    var ps = $('#p-search');
    if (ps) {
      ps.addEventListener('input', function () {
        var q = ps.value.trim().toLowerCase();
        $$('#p-picks .pick').forEach(function (el) {
          var t = el.textContent.toLowerCase();
          el.hidden = !!(q && t.indexOf(q) === -1);
        });
      });
    }
    $$('#p-picks .pick input').forEach(function (cb) {
      cb.addEventListener('change', function () {
        cb.closest('.pick').classList.toggle('on', cb.checked);
      });
    });
  }

  function openLibrary(tab) {
    libTab = tab || 'ind';
    libForm = null;
    openModal('<div class="lib-wrap"></div>', 'wide');
    renderLibrary();
  }

  function handleLibraryClick(e) {
    var tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { libTab = tabBtn.getAttribute('data-tab'); libForm = null; renderLibrary(); return; }

    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');

    function readForm() {
      return {
        id: $('#f-id').value, name: $('#f-name').value, unit: $('#f-unit').value,
        ref: $('#f-ref').value, group: $('#f-group').value, aliases: $('#f-alias').value,
        type: $('#f-type') ? $('#f-type').value : 'num'
      };
    }

    try {
      if (act === 'ind-req') {
        var cur = loadSelected();
        var rid = btn.value;
        var on = btn.checked;
        selected = { ids: cur.ids.slice(), reqIds: cur.reqIds.slice() };
        var at = selected.reqIds.indexOf(rid);
        if (on && at === -1) selected.reqIds.push(rid);
        if (!on && at !== -1) selected.reqIds.splice(at, 1);
        saveSelected();
        renderPageChecks();          // 侧栏那个"必填"勾的整页/半选状态跟着变
        renderStats();
        renderTable();
        return;
      }
      if (act === 'lib-export') { exportLibrary(); return; }
      else if (act === 'lib-import') { importLibrary(); return; }
      else if (act === 'ind-new') { libForm = { kind: 'ind', mode: 'new' }; renderLibrary(); }
      else if (act === 'ind-edit') { libForm = { kind: 'ind', mode: 'edit', id: id }; renderLibrary(); }
      else if (act === 'ind-cancel') { libForm = null; renderLibrary(); }
      else if (act === 'ind-save') {
        if (libForm.mode === 'edit') {
          window.Library.updateIndicator(libForm.id, readForm());
          syncRenames();
          libChangeDone('指标已更新');
        } else {
          window.Library.addIndicator(readForm());
          libChangeDone('指标已添加');
        }
        libForm = null;
        renderLibrary();
      }
      else if (act === 'ind-del') {
        var used = window.Library.pages().some(function (p) { return p.ids.indexOf(id) !== -1; });
        if (!confirm('删除指标 ' + id + '？' + (used ? '\n它还在某些页面里，会被一并移除。' : ''))) return;
        window.Library.removeIndicator(id);
        libChangeDone('已删除');
        renderLibrary();
      }
      else if (act === 'page-new') { libForm = { kind: 'page', mode: 'new' }; renderLibrary(); }
      else if (act === 'page-edit') { libForm = { kind: 'page', mode: 'edit', id: id }; renderLibrary(); }
      else if (act === 'page-cancel') { libForm = null; renderLibrary(); }
      else if (act === 'page-save') {
        var ids = $$('#p-picks input:checked').map(function (cb) { return cb.value; });
        var payload = { name: $('#p-name').value, ids: ids };
        if (libForm.mode === 'edit') window.Library.updatePage(libForm.id, payload);
        else {
          var np = window.Library.addPage(payload);
          var sel0 = loadSelected();
          if (sel0.ids.indexOf(np.id) === -1) sel0.ids.push(np.id);
          saveSelected();
        }
        libChangeDone('页面已保存');
        libForm = null;
        renderLibrary();
      }
      else if (act === 'page-del') {
        if (!confirm('删除这个页面？指标本身不会被删除。')) return;
        window.Library.removePage(id);
        var sel1 = loadSelected();
        sel1.ids = sel1.ids.filter(function (x) { return x !== id; });
        saveSelected();
        libChangeDone('已删除');
        renderLibrary();
      }
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  }

  // 指标改了代号，把已经识别出来的结果一起改名，免得变成孤儿数据
  function syncRenames() {
    var list = window.Library.takeRenames();
    if (!list.length) return;
    list.forEach(function (pair) {
      S.observations.forEach(function (o) {
        if (o.indicatorId === pair[0]) o.indicatorId = pair[1];
      });
    });
  }



  /* ---------------- 导出 ---------------- */

  var STATE_NAME = {
    ok: '已识别', low: '置信度低', missing: '必填缺失',
    conflict: '两处不一致', absent: '未提供'
  };

  function saveText(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* 导出成结构化 JSON：给下游用（入库、二次核对、写论文附录）。
   * 和 CSV 的区别是 CSV 只导当前患者，JSON 导全部患者并保留来源与置信度。 */
  /* 身份证、电话、地址这些直接标识符：录进来是为了"照着报告录"，
   * 但导出去是要给别人的，所以默认抹掉。想导原值，把左侧那个勾去掉。 */
  var IDENT_IDS = { IDNO: 1, PHONE: 1, PHONE2: 1, ADDR: 1 };
  var HIDE_KEY = 'jiaowolu.hideIdent';
  function hideIdent() {
    try { return localStorage.getItem(HIDE_KEY) !== '0'; } catch (e) { return true; }
  }

  function collectRows(pid) {
    return targetIds().map(function (id) {
      var ind = window.IndicatorLib.byId(id);
      if (!ind) return null;
      var c = cellState(pid, id);
      var a = c.obs && c.obs.assetId
        ? S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0]
        : null;
      var val = c.obs ? c.obs.value : '';
      var masked = false;
      if (val && IDENT_IDS[ind.id] && hideIdent()) { val = '（已隐藏）'; masked = true; }
      return {
        code: ind.id, name: ind.name, type: ind.type || 'num',
        value: val, unit: ind.unit || '', ref: ind.ref || '',
        state: c.state, stateName: STATE_NAME[c.state] || '',
        masked: masked,
        source: a ? (a.kind === 'pdf' ? '报告' + a.fileIndex + '-第' + a.pageNo + '页' : '报告' + a.fileIndex) : '',
        sourceType: a && a.reportType ? a.reportType : '',
        docType: a && a.docType ? a.docType : '',
        fromNarrative: !!(c.obs && c.obs.src === 'narrative'),
        confidence: c.obs && c.obs.confidence != null ? c.obs.confidence : null
      };
    }).filter(Boolean);
  }

  function exportJson() {
    if (!S.patients.length) { toast('没有可导出的内容', 'err'); return; }
    var pages = window.Library.pages();
    var sel = loadSelected();
    var reqList = requiredIds();
    var out = {
      app: 'jiaowolu',
      version: 1,
      exportedAt: new Date().toISOString(),
      pages: pages.filter(function (p) { return sel.ids.indexOf(p.id) >= 0; })
        .map(function (p) { return { id: p.id, name: p.name }; }),
      // 必填已经精确到指标；这一项保留"整页都必填"的页面，方便外部按页判断
      requiredPages: pages.filter(function (p) {
        return p.ids.length > 0 && p.ids.every(function (id) { return reqList.indexOf(id) >= 0; });
      }).map(function (p) { return { id: p.id, name: p.name }; }),
      requiredIndicators: reqList.map(function (id) {
        var ind = window.Library.byId(id);
        return { code: id, name: ind ? ind.name : id };
      }),
      patients: S.patients.map(function (p) {
        return {
          code: p.code,
          reports: assetsOf(p.id).map(function (a) {
            return { file: a.sourceName || '', page: a.pageNo || null, type: a.reportType || '', date: a.reportDate || '' };
          }),
          rows: collectRows(p.id)
        };
      })
    };
    saveText('交我录-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(out, null, 2));
    toast('已导出 JSON：' + out.patients.length + ' 位患者');
  }

  /* ---------------- 指标与页面的配置导入导出 ----------------
   * 这是"可分享的模板"能成立的前提：一所医院把指标和页面配好，导出成 JSON
   * 发给另一所，对方导入即可用同一套要求。 */
  function exportLibrary() {
    var cfg = {
      app: 'jiaowolu', kind: 'library', version: 1,
      exportedAt: new Date().toISOString(),
      indicators: window.Library.indicators(),
      pages: window.Library.pages()
    };
    saveText('交我录-指标与页面-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(cfg, null, 2));
    toast('已导出 ' + cfg.indicators.length + ' 个指标、' + cfg.pages.length + ' 个页面');
  }

  function applyLibrary(cfg) {
    var L = window.Library;
    // 顺序不能反：页面要用指标代号做校验，所以指标必须先落地
    L.pages().slice().forEach(function (p) { L.removePage(p.id); });
    L.indicators().slice().forEach(function (i) { L.removeIndicator(i.id); });
    (cfg.indicators || []).forEach(function (i) {
      L.addIndicator({
        id: i.id, name: i.name, group: i.group, type: i.type || 'num',
        unit: i.unit, ref: i.ref, aliases: i.aliases
      });
    });
    (cfg.pages || []).forEach(function (p) { L.addPage({ name: p.name, ids: p.ids || [] }); });
  }

  function importLibrary() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var cfg;
        try { cfg = JSON.parse(String(r.result)); } catch (e) { toast('这个文件不是合法的 JSON', 'err'); return; }
        if (!cfg || !Array.isArray(cfg.indicators) || !cfg.indicators.length) {
          toast('文件里没有找到指标列表', 'err'); return;
        }
        var n = cfg.indicators.length, m = (cfg.pages || []).length;
        if (!window.confirm('导入会用它里面的 ' + n + ' 个指标和 ' + m + ' 个页面替换当前设置。\n当前设置可以在导入前先导出备份。继续吗？')) return;
        try {
          applyLibrary(cfg);
        } catch (e) {
          toast('导入失败：' + (e.message || e), 'err');
          return;
        }
        toast('已导入 ' + n + ' 个指标、' + m + ' 个页面');
        renderAll();
        renderLibrary();
      };
      r.readAsText(f, 'utf-8');
    };
    inp.click();
  }

  function exportCsv() {
    var p = current();
    if (!p) { toast('没有可导出的内容', 'err'); return; }
    var ids = targetIds();
    var head = ['患者', '指标代号', '指标名称', '结果', '单位', '参考范围', '状态', '来源', '报告类型', '取值方式'];
    var stateName = STATE_NAME;

    var rows = ids.map(function (id) {
      var ind = window.IndicatorLib.byId(id);
      var c = cellState(p.id, id);
      var src = '';
      var docType = '';
      var how = '';
      if (c.obs && c.obs.assetId) {
        var a = S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0];
        if (a) {
          src = a.kind === 'pdf' ? '报告' + a.fileIndex + '-第' + a.pageNo + '页' : '报告' + a.fileIndex;
          docType = a.docType || '';
        }
        how = c.obs.src === 'narrative' ? '文中摘录' : '表格';
      }
      var val = c.obs ? c.obs.value : '';
      if (val && IDENT_IDS[id] && hideIdent()) val = '（已隐藏）';
      return [p.code, ind.id, ind.name, val, ind.unit, ind.ref, stateName[c.state], src, docType, how];
    });

    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (v) {
        var s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');

    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '交我录-' + p.code + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('#btn-add-patient').addEventListener('click', function () { addPatient(); });

    $('#patient-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        removePatient(del.getAttribute('data-del'));
        return;
      }
      var row = e.target.closest('[data-pid]');
      if (row) { S.currentId = row.getAttribute('data-pid'); renderAll(); }
    });

    $('#page-checks').addEventListener('change', function (e) {
      var cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      var id = cb.value;
      var cur = loadSelected();
      selected = { ids: cur.ids.slice(), reqIds: cur.reqIds.slice() };

      if (cb.classList.contains('pc-must')) {
        // 整页批量：勾上就整页必填，取消就整页都不必填（含之前单独标的那几项）
        var page = window.Library.pageById(id);
        var ids = page ? page.ids : [];
        if (cb.checked) {
          ids.forEach(function (x) {
            if (selected.reqIds.indexOf(x) === -1 && window.Library.byId(x)) selected.reqIds.push(x);
          });
        } else {
          selected.reqIds = selected.reqIds.filter(function (x) { return ids.indexOf(x) === -1; });
        }
      } else {
        var i = selected.ids.indexOf(id);
        if (cb.checked && i === -1) selected.ids.push(id);
        if (!cb.checked && i !== -1) selected.ids.splice(i, 1);
        // 不参与本次的页面，就不该再占着"必填"——否则取消勾选后红点还在，像哑弹
        if (!cb.checked) {
          var pid = window.Library.pageById(id);
          var pids = pid ? pid.ids : [];
          selected.reqIds = selected.reqIds.filter(function (x) { return pids.indexOf(x) === -1; });
        }
      }
      saveSelected();
      renderAll();
    });

    var input = $('#file-input');
    input.addEventListener('change', function () {
      handleFiles(input.files);
      input.value = '';
    });

    var dropInput = $('#drop-input');
    dropInput.addEventListener('change', function () {
      handleFiles(dropInput.files);
      dropInput.value = '';
    });
    $('#dz-pick').addEventListener('click', function () { dropInput.click(); });
    $('#dropzone').addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      dropInput.click();
    });

    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    // 表格：改值 / 看来源
    $('#grid-body').addEventListener('input', function (e) {
      var inp = e.target.closest('.val-input');
      if (!inp) return;
      var p = current();
      var id = inp.getAttribute('data-ind');
      var c = cellState(p.id, id);
      var o = c.obs;
      if (!o) {
        var ind = window.IndicatorLib.byId(id);
        o = {
          id: uid('obs'), patientId: p.id, assetId: null, rawName: '',
          indicatorId: id, method: 'manual', value: '', unit: ind.unit, ref: ind.ref,
          date: '', confidence: 1
        };
        S.observations.push(o);
      }
      o.value = inp.value;
      o.method = 'manual';
      var row = inp.closest('tr');
      var st = cellState(p.id, id).state;
      row.className = st;
      row.querySelector('.ind-dot').className = 'ind-dot ' + st;
      renderStats();
    });

    $('#grid-body').addEventListener('click', function (e) {
      var g = e.target.closest('.group-row');
      if (g) {
        var pid = g.getAttribute('data-page');
        S.collapse[pid] = !S.collapse[pid];
        renderTable();
        return;
      }
      var cmp = e.target.closest('[data-cmp]');
      if (cmp) { openCompare(cmp.getAttribute('data-cmp')); return; }
      var b = e.target.closest('[data-src]');
      if (b) openSource(b.getAttribute('data-src'));
    });

    $('#date-bar').addEventListener('click', function (e) {
      var chip = e.target.closest('.date-chip');
      if (!chip) return;
      S.dateFilter = chip.getAttribute('data-date') || '';
      renderDateBar();
      renderTable();
    });

    $('#asset-strip').addEventListener('click', function (e) {
      var a = e.target.closest('[data-aid]');
      if (!a) return;
      var aid = a.getAttribute('data-aid');
      var asset = S.assets.filter(function (x) { return x.id === aid; })[0];
      // 失败的那一份，点一下就单独重试它，不用整批重跑
      if (asset && asset.status !== 'done' && asset.status !== 'running') {
        retryOne(asset);
        return;
      }
      openSource(aid);
    });

    $('#btn-run').addEventListener('click', runRecognize);
    $('#btn-export').addEventListener('click', exportCsv);
    $('#btn-export-json').addEventListener('click', exportJson);
    var chkHide = $('#chk-hide-ident');
    if (chkHide) {
      chkHide.checked = hideIdent();
      chkHide.addEventListener('change', function () {
        try { localStorage.setItem(HIDE_KEY, chkHide.checked ? '1' : '0'); } catch (e) { /* ignore */ }
      });
    }
    $('#btn-settings').addEventListener('click', openSettings);

    var btnReconnect = $('#btn-reconnect');
    if (btnReconnect) {
      btnReconnect.addEventListener('click', function () {
        btnReconnect.disabled = true;
        ping().then(function (st) {
          btnReconnect.disabled = false;
          // 服务回来了就重载一次，顺便把文件更新也带上
          if (st === 'ok') location.reload();
          else toast('还是连不上。重新双击 start.bat，等黑窗口里出现"已就绪"再点重试。', 'err');
        });
      });
    }
    $('#btn-library').addEventListener('click', function () { openLibrary('ind'); });

    $('#modal-box').addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      if (pick) { pickObservation(pick.getAttribute('data-pick')); return; }
      if (e.target.closest('[data-act]') || e.target.closest('[data-tab]')) handleLibraryClick(e);
    });

    $('#btn-reset').addEventListener('click', function () {
      if (!confirm('清空本次任务的所有报告和识别结果？')) return;
      S.assets = [];
      S.observations = [];
      S.patients = [];
      S.currentId = null;
      window.Model.resetUsage();
      cacheClear();
      addPatient(true);
      renderAll();
      toast('已清空', 'ok');
    });

    $('#modal').addEventListener('click', function (e) {
      if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
    });
  }

  /* ---------------- 本地服务心跳 ---------------- */
  /* 页面和本地服务之间没有长连接，浏览器不会主动告诉我们"服务没了"。
   * 所以每 10 秒问一次 /__ping，问不到就在底部挂条提示——
   * 否则用户点"开始识别"只会看到一堆莫名失败，分不清是服务断了还是程序坏了。 */
  var heartbeat = { offline: false, state: 'ok', started: false };

  function mark(state) {
    heartbeat.state = state;
    heartbeat.offline = state !== 'ok';
    var bar = $('#offline-bar');
    if (!bar) return;
    bar.hidden = !heartbeat.offline;
    var span = $('#offline-text');
    if (span && state === 'other') {
      span.textContent = '8765 端口上跑的不是交我录（八成是别的程序）';
    }
  }

  function ping() {
    return fetch('./__ping', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || j.app !== 'jiaowolu') {
          var e = new Error('不是交我录');
          e.code = 'other';
          throw e;
        }
        mark('ok');
        return 'ok';
      })
      .catch(function (e) {
        var st = (e && e.code === 'other') ? 'other' : 'down';
        mark(st);
        return st;
      });
  }

  /* 部署到 GitHub Pages 这类静态托管上时，压根没有"本地服务"这回事。
   * 那时再去问 /__ping 只会拿到 404，页面就永远挂着一条"服务断开"的红条——
   * 本来是给人帮忙的提示，反倒成了最显眼的错误。所以按来源区分。 */
  var HOSTED = (function () {
    if (window.location.protocol === 'file:') return true;
    var h = window.location.hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '');
  })();

  function startHeartbeat() {
    if (window.location.protocol === 'file:') return; // 直接双击 html 时本来就没有服务
    if (HOSTED) return;                              // 托管版没有本地服务可问
    if (heartbeat.started) return;
    heartbeat.started = true;
    setTimeout(ping, 600);
    setInterval(ping, 6000);
  }

  /* 演示时别让电脑睡过去。浏览器允许的话申请屏幕常亮；不允许就算了，不影响功能。 */
  var wakeLock = null;

  function keepAwake() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* 用户或系统不允许，忽略 */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
  });

  /* ---------------- 启动 ---------------- */

  async function init() {
    // 先把上次没做完的任务装回来（24 小时内有效）
    var saved = null;
    try { saved = await cacheGet(); } catch (e) { saved = null; }
    if (saved && saved.at && (Date.now() - saved.at) < CACHE_TTL
      && Array.isArray(saved.patients) && saved.patients.length) {
      restoreSession(saved);
    }

    if (!S.patients.length) addPatient(true);
    bind();
    updatePill();
    renderAll();
    startHeartbeat();
    keepAwake();

    if (saved && S.assets.length) {
      var n = S.assets.length;
      toast('已恢复上次的任务：' + S.patients.length + ' 位患者、' + n + ' 份报告（存在本机，24 小时后自动清理）', 'ok');
    }

    // 暴露给控制台，方便调试
    window.__S = S;
    window.__parseJson = parseJson;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
