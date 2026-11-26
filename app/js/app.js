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
/* 报告上用这些符号表示"这一项没做/无结果"，不是数值 */
var PLACEHOLDER_VALUES = /^(—+|－+|-{1,3}|\/|／|未做|未检测|未测|未查|无|未见)$/;

  /* 文书类型 → 只有这类文书上才会成组出现的页面。
     先判类型再抽取，是为了不让模型到出院记录的正文里去"捞"血常规——
     那里面确实写着"白细胞计数:5.54*10^9/L"，照抄下来就成了另一份来源，
     跟真正的化验单对不上，白白制造一堆"两处不一致"。 */
  /* 文书类型 → 页面。这张映射不再写死：每个页面自己记着 docType
   * （在「指标与页面」里选，可随配置导出导入），所以新建页面只要选对类型，
   * 就自动参与那一类文书的定向抽取。
   * 分类本身是固定枚举（模型只需要答出属于哪一种），见 Library.DOC_TYPES。 */
  function docTypeList() {
    return (window.Library && window.Library.DOC_TYPES) || ['其他'];
  }
  function docPages() {
    var map = {};
    docTypeList().forEach(function (t) { map[t] = []; });
    window.Library.pages().forEach(function (p) {
      var t = p.docType;
      if (t && map[t]) map[t].push(p.id);
    });
    return map;
  }
  /* 页眉字段：每一份单据的抬头都可能印着，跟文书类型无关 */
  // 页眉/身份类字段：只从"病案首页"取，别的文书一律不抄（省 token，也免掉"男/男性"这种噪音）
  var HEADER_IDS = ['NAME', 'SEX', 'AGE', 'VISITAGE', 'ADMNO', 'VISITDATE', 'HOSP'];

  var S = {
    patients: [],
    currentId: null,
    assets: [],
    observations: [],
    running: false,
    runningPatientId: null,
    progress: null,
    dateFilter: '',            // 时间轴：只看某一次就诊（'' = 全部，取最近一次的值）
    collapse: {},              // 页面分组是展开还是收起，用户点过就记住
    reviews: [],               // 人工复核/裁决的历史（只在本地，可随导出带出）
    seq: { patient: 0, asset: 0, obs: 0, review: 0 }
  };
  var patientViews = new Map();
  var importing = new Set();

  // 上次停在哪个视图就还停在哪个（"全部结果"看惯了的人不用每次再点一下）；
  // 地址栏也可以强制指定：?view=all 直接进"全部结果"，方便把一批的完整表格发成链接。
  var START_VIEW = (function () {
    try {
      if (localStorage.getItem('jiaowolu.startView') === 'all') return 'all';
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
    try {
      return new URLSearchParams(location.search).get('view') === 'all' ? 'all' : 'review';
    } catch (e) {
      return 'review';
    }
  })();

  function viewOf(pid) {
    if (!patientViews.has(pid)) {
      patientViews.set(pid, {
        mode: START_VIEW,
        // 用户自己点过视图切换就不再替他做主；没点过才在识别完成后自动挑一个
        modeChosen: START_VIEW === 'all',
        date: '',
        collapse: {},
        detail: null,
        scroll: 0,
      });
    }
    return patientViews.get(pid);
  }

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
            reviews: S.reviews,
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
    S.reviews = Array.isArray(saved.reviews) ? saved.reviews : [];
    S.seq = saved.seq || S.seq;
    S.currentId = saved.currentId === null || S.patients.some(function (p) { return p.id === saved.currentId; })
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
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    // 只保留最新一条：连点几下按钮时不该糊一屏提示
    while (box.firstChild) box.removeChild(box.firstChild);
    var d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
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
  var SEL_KEY = 'jiaowolu.selectedPages.v4';
  var selected = null;

  /* 必填是"派生"出来的，不是存下来的：
       本次生效必填 =（勾上的各组预设的并集 ∪ 本次手动加的）− 本次手动减的
     这样组一勾上预设就自动生效、组一取消就自动失效，不用在开关里做加减账。 */
  var reqCache = null;
  function invalidateReq() { reqCache = null; }

  function loadSelected() {
    if (selected) return selected;
    var raw = null;
    try { raw = localStorage.getItem(SEL_KEY); } catch (e) { /* 隐私模式 */ }
    if (raw) {
      try {
        var obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.ids)) {
          selected = {
            ids: obj.ids,
            add: Array.isArray(obj.add) ? obj.add : [],
            drop: Array.isArray(obj.drop) ? obj.drop : []
          };
          return selected;
        }
      } catch (e) { /* 存档坏了就重来 */ }
    }
    // 上一版把必填直接存在 reqIds 里，升级时整批搬进"手动加的"
    var prev = null;
    try { prev = localStorage.getItem('jiaowolu.selectedPages.v3'); } catch (e) { /* ignore */ }
    if (prev) {
      try {
        var p3 = JSON.parse(prev);
        if (p3 && Array.isArray(p3.ids)) {
          selected = { ids: p3.ids, add: Array.isArray(p3.reqIds) ? p3.reqIds.slice() : [], drop: [] };
          invalidateReq();
          saveSelected();
          return selected;
        }
      } catch (e) { /* ignore */ }
    }
    // 再往前是"必填页面"，展开成页面里所有指标
    var legacy = null;
    try { legacy = localStorage.getItem('jiaowolu.selectedPages.v2'); } catch (e) { /* ignore */ }
    if (legacy) {
      try {
        var old = JSON.parse(legacy);
        if (old && Array.isArray(old.ids)) {
          selected = { ids: old.ids, add: unionOf(Array.isArray(old.req) ? old.req : []), drop: [] };
          saveSelected();
          return selected;
        }
      } catch (e) { /* ignore */ }
    }
    // 默认：只勾"默认要看"的页面（on:false 的先不勾，需要时自己勾上），没有一个算必填
    var on = window.Library.pages().filter(function (p) { return p.on !== false; });
    if (!on.length) on = window.Library.pages();
    selected = { ids: on.map(function (p) { return p.id; }), add: [], drop: [] };
    return selected;
  }

  function saveSelected() {
    invalidateReq();
    try { localStorage.setItem(SEL_KEY, JSON.stringify(selected)); } catch (e) { /* 存不下算了 */ }
  }

  /* 改"这一项这次要不要必填"：只动本次的加减，不写回组预设 */
  function setReq(indId, want) {
    var sel = loadSelected();
    var ai = sel.add.indexOf(indId);
    var di = sel.drop.indexOf(indId);
    if (want) {
      if (ai === -1) sel.add.push(indId);
      if (di !== -1) sel.drop.splice(di, 1);
    } else {
      if (ai !== -1) sel.add.splice(ai, 1);
      if (di === -1) sel.drop.push(indId);
    }
  }

  function setReqOfPage(pageId, want) {
    var page = window.Library.pageById(pageId);
    if (!page) return;
    page.ids.forEach(function (x) { if (window.Library.byId(x)) setReq(x, want); });
  }

  /* 页面退出本次任务时，把它名下指标的加减记录一起清掉，免得留下看不见的账 */
  function forgetReqOfPage(pageId) {
    var page = window.Library.pageById(pageId);
    if (!page) return;
    var sel = loadSelected();
    sel.add = sel.add.filter(function (x) { return page.ids.indexOf(x) === -1; });
    sel.drop = sel.drop.filter(function (x) { return page.ids.indexOf(x) === -1; });
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

  /* 缺了要标红的那几项 = 勾上的各组预设 ∪ 本次手动加 − 本次手动减。默认空。 */
  function requiredIds() {
    if (reqCache) return reqCache;
    var sel = loadSelected();
    var out = [];
    function push(x) {
      if (out.indexOf(x) === -1 && window.Library.byId(x)) out.push(x);
    }
    activeGroups().forEach(function (g) { (g.reqIds || []).forEach(push); });
    (sel.add || []).forEach(push);
    reqCache = out.filter(function (x) { return (sel.drop || []).indexOf(x) === -1; });
    return reqCache;
  }

  function isRequired(indId) { return requiredIds().indexOf(indId) !== -1; }

  /* 页面上那个"必填"勾只是批量开关：勾上=整页指标都必填，取消=整页都不必填。
     只标了一部分时显示成半选，鼠标停上去能看到是几项里的几项。 */
  function pageRowHtml(p, sel) {
    var on = sel.ids.indexOf(p.id) !== -1;
    var total = p.ids.length;
    var need = p.ids.filter(function (id) { return isRequired(id); }).length;
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

  /* 组"算勾上了"的条件：组里每一页都在本次勾选里。
     组状态不单独存一份，页面勾选是唯一事实，组只是它上面的一个快捷开关。 */
  function activeGroups() {
    var sel = loadSelected();
    return window.Library.groups().filter(function (g) {
      return g.pageIds.length && g.pageIds.every(function (pid) {
        return sel.ids.indexOf(pid) !== -1;
      });
    });
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
    var groups = window.Library.groups();
    var html = '';

    // 页面组的快捷开关：勾上 = 组里这些页面一起勾上，顺带把组的必填预设并进来
    if (groups.length) {
      html += '<div class="pc-groups">' + groups.map(function (g) {
        var onCount = g.pageIds.filter(function (pid) { return sel.ids.indexOf(pid) !== -1; }).length;
        var all = g.pageIds.length > 0 && onCount === g.pageIds.length;
        var part = onCount > 0 && !all;
        return '<label class="pc-grp' + (all ? ' on' : '') + (part ? ' part' : '') + '"' +
          ' title="勾上 = 把这一组里的 ' + g.pageIds.length + ' 个页面一起勾上' +
            (g.reqIds.length ? '，并带上 ' + g.reqIds.length + ' 项必填预设' : '') + '">' +
          '<input type="checkbox" class="grp-use" value="' + esc(g.id) + '"' +
            (all ? ' checked' : '') + (part ? ' data-part="1"' : '') + '>' +
          '<span class="grp-name">' + esc(g.name) + '</span>' +
          '<b>' + onCount + '/' + g.pageIds.length + '</b>' +
          '</label>';
      }).join('') + '</div>';
    }

    // 常规 / 特殊 分开列：常规是每个病人都做的，特殊是这个病种才做的专项检查。
    var common = pages.filter(function (p) { return p.kind !== 'special'; });
    var special = pages.filter(function (p) { return p.kind === 'special'; });
    if (common.length) {
      html += '<div class="pc-group">常规页面<span class="pc-group-note">每个病人都会做</span></div>';
      html += common.map(function (p) { return pageRowHtml(p, sel); }).join('');
    }
    if (special.length) {
      html += '<div class="pc-group">特殊页面<span class="pc-group-note">病种专项，按需勾选</span></div>';
      html += special.map(function (p) { return pageRowHtml(p, sel); }).join('');
    }
    // 不属于任何组的页面单独列出来，免得"建了却看不见"
    var inGroup = {};
    groups.forEach(function (g) { g.pageIds.forEach(function (pid) { inGroup[pid] = 1; }); });
    var loose = pages.filter(function (p) { return p.kind !== 'special' && !inGroup[p.id]; });
    if (loose.length) {
      html += '<div class="pc-group">未分组</div>';
      html += loose.map(function (p) { return pageRowHtml(p, sel); }).join('');
    }

    box.innerHTML = html;
    // 半选的勾要用 DOM 属性设，不能写在 HTML 里
    box.querySelectorAll('.pc-must[data-part]').forEach(function (el) { el.indeterminate = true; });
    box.querySelectorAll('.grp-use[data-part]').forEach(function (el) { el.indeterminate = true; });
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

  function cellState(pid, indId, dateFilter = pid === S.currentId ? S.dateFilter : '') {
    var list = obsOf(pid, indId);
    var ind = window.Library.byId(indId);
    var isNum = !ind || (ind.type || 'num') === 'num';

    // 同一份报告里重复出现同一项（页眉一遍、表格一遍），只算一条：
    // 取置信度最高的那条。不然自己跟自己都会"两处不一致"。
    var byAsset = {};
    list.forEach(function (o) {
      var key = o.assetId || 'manual-' + obsDate(o);
      var cur = byAsset[key];
      var better = !cur || (o.confidence == null ? 0 : o.confidence) > (cur.confidence == null ? 0 : cur.confidence);
      if (better) byAsset[key] = o;
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

    var picked = dateFilter
      ? all.filter(function (o) { return obsDate(o) === dateFilter; })
      : all;

    // 没识别到：只有标了必填的才算质控问题，其余只是"这次没提供"
    if (!picked.length) {
      var matching = dateFilter ? list.filter(function (o) { return obsDate(o) === dateFilter; }) : list;
      return {
        state: isRequired(indId) ? 'missing' : 'absent',
        obs: matching[0] || null, list: matching, dates: dates
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

    if (o.warn === 'unit' && o.method !== 'manual') {
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
    var focused = document.activeElement.closest('#patient-list button');
    box.innerHTML = S.patients.map(function (p) {
      var active = p.id === S.currentId;
      return '<div class="patient' + (active ? ' active' : '') + '" data-pid="' + esc(p.id) + '">' +
        '<button type="button" class="patient-select" aria-current="' + active + '">' +
        '<span class="patient-code">' + esc(p.code) + '</span>' +
        '<span class="patient-meta">' + assetsOf(p.id).length + ' 页报告 · ' + patientStatus(p.id) + '</span></button>' +
        '<button type="button" class="del" data-del="' + esc(p.id) + '" aria-label="移除' + esc(p.code) + '">×</button></div>';
    }).join('');
    $('#queue-count').textContent = S.patients.length + ' 位';
    $('#btn-all-patients').setAttribute('aria-pressed', !S.currentId);
    if (focused) {
      var row = Array.from(box.children).find(function (el) { return el.dataset.pid === focused.closest('.patient').dataset.pid; });
      if (row) row.querySelector(focused.classList.contains('del') ? '.del' : '.patient-select').focus({ preventScroll: true });
    }
  }

  function patientStatus(pid) {
    if (importing.has(pid)) return '导入中';
    if (S.runningPatientId === pid) return '识别中';
    var reports = assetsOf(pid);
    if (!reports.length) return '待上传';
    var pending = reports.filter(function (a) { return a.status === 'pending'; }).length;
    if (pending) return pending + ' 页待识别';
    var failed = reports.filter(function (a) { return a.status === 'error' || a.status === 'skipped'; }).length;
    if (failed) return failed + ' 页未识别';
    var n = reviewCounts(pid, '');
    return n.total ? n.total + ' 项待核对' : '核对完成';
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
      return '<div class="report-item"><button type="button" class="asset' + (a.lowRes ? ' lowres' : '') +
        '" data-aid="' + esc(a.id) + '" title="' + esc(a.name) + '">' +
        '<img src="' + esc(a.dataUrl) + '" alt="" loading="lazy">' +
        '<span class="asset-foot"><span>' + esc(label) + '</span>' + st + '</span></button>' +
        (a.status === 'error' ? '<button type="button" class="link retry-report" data-retry="' + esc(a.id) +
          '"' + (S.running ? ' disabled' : '') + '>重试识别</button>' : '') + '</div>';
    }).join('');

    var dz = $('#dropzone');
    var has = list.length > 0;
    dz.hidden = has;
    var disclosure = $('#report-list');
    disclosure.hidden = !has;
    var needsAttention = list.some(function (asset) { return asset.status !== 'done'; });
    var reportView = p && viewOf(p.id);
    if (reportView) disclosure.open = reportView.reportsOpen === undefined ? true : reportView.reportsOpen;
    $('#report-summary').textContent = '报告 · ' + list.length + ' 页';
  }

  /* ---------------- 渲染：概览 ---------------- */

  function needsReview(state) {
    return state === 'conflict' || state === 'missing' || state === 'low';
  }

  function reviewCounts(pid, date) {
    var counts = { conflict: 0, missing: 0, low: 0, total: 0 };
    targetIds().forEach(function (id) {
      var state = cellState(pid, id, date).state;
      if (needsReview(state)) {
        counts[state]++;
        counts.total++;
      }
    });
    return counts;
  }

  function renderStats() {
    var p = current();
    if (!p) return;
    var available = hasResults(p.id);
    var n = reviewCounts(p.id, S.dateFilter);
    $('#btn-review').textContent = '待核对 ' + (available ? n.total : 0);
    $('#btn-results-all').textContent = '全部结果 ' + targetIds().length;
    $('#stats').innerHTML = ['conflict', 'missing', 'low'].filter(function (state) {
      return available && n[state];
    }).map(function (state) {
      return '<span class="stat badge ' + state + '">' + STATE_NAME[state] + ' ' + n[state] + '</span>';
    }).join('');
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

  function stateLabel(c) {
    if (c.state === 'ok' && c.obs && c.obs.method === 'manual') return '人工已核对';
    if (c.state === 'low' && c.obs && c.obs.warn === 'unit') return '单位待确认';
    return STATE_NAME[c.state] || '';
  }

  function badgeOf(c) {
    return '<span class="badge ' + c.state + '">' + stateLabel(c) + '</span>';
  }

  function resultRow(id, c, review) {
    var ind = window.Library.byId(id);
    var value = c.obs && c.obs.value != null ? String(c.obs.value) : '';
    // 单位/参考范围统一走 effectiveUnit/effectiveRef：报告上印的优先，缺省回退指标库默认值
    var unit = effectiveUnit(c, ind) || (ind.type === 'date' ? '日期' : '');
    var ref = effectiveRef(c, ind);
    var detail = viewOf(S.currentId).detail;
    var focused = detail && detail.indId === id;
    var source = c.obs && c.obs.assetId;
    var sourceText = c.state === 'conflict' ? c.list.length + ' 个来源' : (source ? srcLabel(source, c.obs.date) : '');
    var sourceButton = sourceText ? '<button type="button" class="src-link' + (c.state === 'conflict' ? ' conflict-src' : '') +
      '" data-cmp="' + esc(id) + '">' + esc(sourceText) + '</button>' : '';
    if (!S.dateFilter && c.dates && c.dates.length > 1) {
      sourceButton += ' <button type="button" class="date-hint" data-cmp="' + esc(id) +
        '">另有 ' + (c.dates.length - 1) + ' 次</button>';
    }
    var displayValue = c.state === 'conflict'
      ? c.list.map(function (o) { return o.value; }).filter(function (v, i, all) { return all.indexOf(v) === i; }).join(' / ')
      : value;
    // 冲突行要同时看到两个来源的值，保持只读；其余行一律可直接改。待核对页也一样，
    // 看到不对就地改，不必再切到"全部结果"或打开右侧检查器。
    var valueCell = (review && c.state === 'conflict')
      ? '<span class="result-value">' + esc(displayValue || '—') + '</span>'
      : '<input class="val-input" data-ind="' + esc(id) + '" aria-label="' + esc(ind.name) +
        '结果" value="' + esc(value) + '" placeholder="未识别">';

    return '<tr class="' + c.state + (focused ? ' selected-result' : '') + '" data-ind="' + esc(id) + '">' +
      '<td class="col-name"><div class="ind-name"><span class="ind-dot ' + c.state + '"></span>' +
      '<div><button type="button" class="indicator-link" data-cmp="' + esc(id) + '"' +
      ' aria-pressed="' + Boolean(focused) + '">' + esc(ind.name) + '</button>' +
      '<div class="ind-code">' + esc(id) + '</div></div></div></td>' +
      '<td class="col-value">' + valueCell + '</td>' +
      '<td class="col-unit">' + esc(unit) + '</td><td class="col-ref">' + esc(ref) + '</td>' +
      '<td class="col-src"><span class="cell-state">' + badgeOf(c) + '</span>' + sourceButton +
      (source && c.obs.src === 'narrative' ? '<span class="src-tag">文中</span>' : '') + '</td></tr>';
  }

  function reviewRows(pid) {
    return targetIds().map(function (id) {
      return { id: id, c: cellState(pid, id) };
    }).filter(function (row) {
      return needsReview(row.c.state);
    }).sort(function (a, b) {
      return STATE_RANK[a.c.state] - STATE_RANK[b.c.state];
    });
  }

  function hasResults(pid) {
    return assetsOf(pid).some(function (a) { return a.status === 'done'; }) ||
      S.observations.some(function (o) { return o.patientId === pid; });
  }

  /* 待核对行动队列：数据全部来自 reviewRows()/cellState()，不新增第二份状态。
   * 只列"需要人处理"的三类，最多 6 条，其余指向下方完整表格。 */
  function renderActionQueue() {
    var box = $('#action-queue');
    if (!box) return;
    var p = current();
    var review = p && viewOf(p.id).mode === 'review';
    var rows = p && review && hasResults(p.id) ? reviewRows(p.id) : [];
    box.hidden = !rows.length;
    if (!rows.length) { box.innerHTML = ''; return; }
    var labels = { conflict: '需要裁决', missing: '需要补录', low: '需要确认' };
    box.innerHTML = '<div class="action-heading"><strong>还有 ' + rows.length + ' 项需要处理</strong>' +
      '<span>先看问题，再看完整表格</span></div>' + rows.slice(0, 6).map(function (row) {
        var ind = window.Library.byId(row.id);
        var c = row.c;
        var detail = '';
        if (c.state === 'missing') detail = '本次必填，当前报告中未找到。';
        else if (c.state === 'low') detail = '识别为“' + ((c.obs && c.obs.value) || '') + '”，请对照原图确认。';
        else detail = (c.list || []).map(function (o) { return o.value; })
          .filter(function (v, i, all) { return all.indexOf(v) === i; }).join(' / ');
        return '<button type="button" class="action-item ' + c.state + '" data-action-ind="' + esc(row.id) + '">' +
          '<span class="action-kind">' + labels[c.state] + '</span>' +
          '<span class="action-name">' + esc(ind ? ind.name : row.id) + '</span>' +
          '<span class="action-detail">' + esc(detail) + '</span>' +
          '<span class="action-go">核对 →</span></button>';
      }).join('') + (rows.length > 6
        ? '<p class="action-more">其余 ' + (rows.length - 6) + ' 项见下方待核对表。</p>' : '');
  }

  function renderTable() {
    renderActionQueue();
    var body = $('#grid-body');
    var p = current();
    if (!p) return;

    var sel = loadSelected();
    var tgt = targetIds();
    var review = viewOf(p.id).mode === 'review';
    var rows = review && hasResults(p.id) ? reviewRows(p.id) : [];
    var table = $('#results-table');
    var empty = $('#results-empty');
    table.dataset.view = review ? 'review' : 'all';
    table.hidden = review ? !rows.length : !tgt.length;
    empty.hidden = !table.hidden;
    $('#btn-review').setAttribute('aria-pressed', review);
    $('#btn-results-all').setAttribute('aria-pressed', !review);

    if (table.hidden) {
      body.innerHTML = '';
      empty.textContent = !tgt.length ? '本次未选择检查页面。可以在本批质控规则中添加。' :
        hasResults(p.id) ? '当前没有待核对项。' : '识别完成后，待核对项会显示在这里。';
      return;
    }
    if (review) {
      body.innerHTML = rows.map(function (row) { return resultRow(row.id, row.c, true); }).join('');
      return;
    }

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
      // 但在"全部结果"里，默认全展开——既然要"全部"，就别让人再点七次。
      // 注意：默认值不写回 S.collapse——否则第一次渲染时的"全灰"状态会被永久记住。
      var stored = S.collapse[g.page.id];
      var collapsed = stored === undefined
        ? (viewOf(S.currentId).mode === 'all' ? false : ((n.conflict + n.missing + n.low + n.ok) === 0))
        : stored;

      var countBits = [];
      if (n.conflict) countBits.push('<b class="c-red">' + n.conflict + ' 处不一致</b>');
      if (n.missing) countBits.push('<b class="c-red">' + n.missing + ' 缺</b>');
      if (n.low) countBits.push('<b class="c-amber">' + n.low + ' 存疑</b>');
      if (n.ok) countBits.push('<b class="c-green">' + n.ok + ' 已识别</b>');
      if (n.absent) countBits.push('<b class="c-gray">' + n.absent + ' 未提供</b>');

      var head = '<tr class="group-row" data-page="' + esc(g.page.id) + '">' +
        '<td colspan="5"><button type="button" class="group-toggle" aria-expanded="' + !collapsed + '">' +
        '<span class="caret" aria-hidden="true">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="gname">' + esc(g.page.name) + '</span>' +
        '<span class="gcount">' + countBits.join(' · ') + '</span></button></td></tr>';

      var bodyRows = collapsed ? '' : rows.map(function (r) {
        return resultRow(r.id, r.c, false);
      }).join('');

      return head + bodyRows;
    }).join('');

    body.innerHTML = html;
    // 时间轴条跟着表格一起刷新：只重绘表格的地方（点分组头、人工裁决）也要更新，
    // 否则日期 chip 会停在旧状态。
    renderDateBar();
  }

  function renderRuleSummary() {
    var config = loadSelected();
    var preset = activeGroups().find(function (g) { return g.pageIds.length === config.ids.length; });
    var targets = targetIds();
    $('#rule-label').textContent = preset ? preset.name : '自定义规则';
    $('#rule-summary').textContent = config.ids.length + ' 个页面 · ' +
      requiredIds().filter(function (id) { return targets.includes(id); }).length + ' 项必填';
  }

  function renderBatchOverview() {
    var overview = $('#batch-overview');
    overview.innerHTML = S.patients.length ? '<div class="table-wrap"><table class="grid"><thead><tr>' +
      '<th scope="col">患者</th><th scope="col">报告页</th><th scope="col">处理状态</th>' +
      '</tr></thead><tbody>' + S.patients.map(function (p) {
        return '<tr><td><button type="button" class="indicator-link" data-pid="' + esc(p.id) + '">' +
          esc(p.code) + '</button></td><td>' + assetsOf(p.id).length + ' 页</td><td>' +
          patientStatus(p.id) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="stage-empty">添加患者后，即可导入报告。</div>';
  }

  function renderWorkspace() {
    var p = current();
    var reports = p ? assetsOf(p.id) : [];
    $('#patient-title').textContent = p ? p.code : '全部患者';
    $('#patient-sub').textContent = p ? reports.length + ' 页报告 · ' + patientStatus(p.id) :
      '本批 ' + S.patients.length + ' 位患者 · 选择一位患者查看报告';
    $('#export-scope').textContent = '导出范围 · ' + exportScopeLabel(p ? [p] : S.patients, !!p);
    $('#btn-export').disabled = $('#btn-export-json').disabled = !S.patients.length;
    $('#btn-reset').disabled = S.running || importing.size > 0;
    $('#btn-rules').disabled = S.running;
    $('#btn-settings').disabled = S.running;
    $('#work-actions').hidden = $('#patient-work').hidden = !p;
    $('#batch-overview').hidden = !!p;
    if (!p) { renderBatchOverview(); return; }

    var waiting = reports.some(function (a) { return a.status === 'pending' || a.status === 'error'; });
    var running = S.runningPatientId === p.id;
    var loading = importing.has(p.id);
    var upload = $('#btn-upload');
    upload.hidden = !reports.length;
    upload.disabled = $('#dz-pick').disabled = loading;
    var run = $('#btn-run');
    run.hidden = !waiting && !running;
    run.disabled = S.running || loading;
    run.innerHTML = running ? '<span class="spin" aria-hidden="true"></span>识别中…' : '开始识别';
    var note = $('#recognition-note');
    note.hidden = !waiting || running;
    note.textContent = window.Model.getConfig().hasKey ?
      '开始识别会将这位患者的报告页发送到已配置的模型服务。' : '开始识别前，请先配置模型 API Key。';
    var status = $('#recognition-status');
    status.hidden = !running && !loading;
    status.textContent = loading ? '正在导入报告…' : running && S.progress ?
      '正在识别 ' + S.progress.done + ' / ' + S.progress.total + ' 页' : '';
    $('#results').hidden = !reports.length;
    renderDateBar();
    renderAssets();
    renderStats();
    renderTable();
  }

  function renderAll() {
    renderRuleSummary();
    renderPageChecks();
    renderPatients();
    renderWorkspace();
    renderInspector();
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
      if (p) viewOf(p.id).date = S.dateFilter;
      return;
    }
    if (S.dateFilter && dates.indexOf(S.dateFilter) === -1) S.dateFilter = '';
    viewOf(p.id).date = S.dateFilter;
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

  function selectPatient(id) {
    if (S.currentId) viewOf(S.currentId).scroll = $('#work').scrollTop;
    S.currentId = id;
    var view = id ? viewOf(id) : null;
    S.dateFilter = view ? view.date : '';
    S.collapse = view ? view.collapse : {};
    renderAll();
    $('#work').scrollTop = view ? view.scroll : 0;
  }

  function addPatient(silent) {
    var id = uid('patient');
    var p = { id: id, code: '患者 ' + String(S.seq.patient).padStart(2, '0') };
    S.patients.push(p);
    if (silent) {
      S.currentId = id;
      S.dateFilter = '';
      S.collapse = viewOf(id).collapse;
    } else {
      selectPatient(id);
      $('.patient.active').scrollIntoView({ block: 'nearest' });
    }
    return p;
  }

  function removePatient(pid) {
    if (importing.has(pid) || S.runningPatientId === pid) {
      toast('请等这位患者的导入或识别完成后再移除。', 'err');
      return;
    }
    if (assetsOf(pid).length && !confirm('移除这位患者及其所有报告和识别结果？')) return;
    S.patients = S.patients.filter(function (p) { return p.id !== pid; });
    S.assets = S.assets.filter(function (a) { return a.patientId !== pid; });
    S.observations = S.observations.filter(function (o) { return o.patientId !== pid; });
    if (S.currentId === pid) selectPatient(null);
    else renderAll();
    patientViews.delete(pid);
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

  async function ingestImage(file, fileIndex, pid) {
    var raw = await readAsDataUrl(file);
    var small = await downscale(raw, MAX_IMAGE_EDGE);
    var edge = Math.max(small.width, small.height);
    return {
      id: uid('asset'),
      patientId: pid,
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
    };
  }

  async function ingestPdf(file, fileIndex, pid) {
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

    var pages = [];
    try {
      for (var i = 1; i <= total; i++) {
        var img = await window.PdfTools.renderPage(pdf, i, {
          dpi: 150,
          maxEdge: MAX_IMAGE_EDGE,
          imageType: 'image/jpeg',
          quality: JPEG_QUALITY
        });
        pages.push({
          id: uid('asset'),
          patientId: pid,
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
      return pages;
    } finally {
      await pdf.destroy();
    }
  }

  async function handleFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var p = current();
    if (!p || importing.has(p.id)) return;
    importing.add(p.id);
    viewOf(p.id).reportsOpen = undefined;
    var fileIndex = assetsOf(p.id).reduce(function (m, a) {
      return Math.max(m, a.fileIndex || 0);
    }, 0);
    var smallCount = 0;
    renderAll();
    try {
      for (var f of list) {
        try {
          var pages;
          if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
            pages = await ingestPdf(f, fileIndex + 1, p.id);
          } else if (/^image\//.test(f.type)) {
            pages = [await ingestImage(f, fileIndex + 1, p.id)];
          } else {
            toast('跳过不支持的文件：' + f.name, 'err');
            continue;
          }
          fileIndex++;
          S.assets.push.apply(S.assets, pages);
          smallCount += pages.filter(function (page) { return page.lowRes; }).length;
          cacheSchedule();
        } catch (e) {
          toast(e.message || String(e), 'err');
        }
      }
    } finally {
      importing.delete(p.id);
      renderAll();
    }
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
    if (docTypeList().indexOf(t) === -1) t = '其他';
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
      (docPages()[type] || []).forEach(function (pid) {
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
    if (docType && docType !== '其他') {
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
      // 报告上常把"这一项没做/无结果"印成 —、-、/ 之类的占位符。
      // 当成数值录进去会让"必填缺失"漏报，所以这里直接不产生观测值。
      if (PLACEHOLDER_VALUES.test(v)) return;
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
    if (!asset || S.running || asset.lowRes || asset.patientId !== S.currentId ||
      (asset.status !== 'error' && asset.status !== 'pending')) return;
    if (!window.Model.getConfig().hasKey) { openSettings(); return; }
    S.running = true;
    S.runningPatientId = asset.patientId;
    S.progress = { done: 0, total: 1 };
    asset.error = '';
    renderAll();
    try {
      await recognizeAsset(asset);
    } catch (e) {
      asset.status = 'error';
      asset.error = e.message || String(e);
      toast('这一页还是失败：' + asset.error, 'err');
    } finally {
      finishRecognition(asset.patientId);
    }
  }

  function finishRecognition(pid) {
    S.running = false;
    S.runningPatientId = null;
    S.progress = null;
    var view = viewOf(pid);
    // 识别完默认跳到"待核对"（先看问题）；但用户自己切到"全部结果"看惯了就别再把他拽回去，
    // 否则表格会突然变空，看着像"什么都没识别出来"。
    if (!view.modeChosen) view.mode = 'review';
    view.reportsOpen = undefined;
    updatePill();
    renderAll();
  }

  async function runRecognize() {
    if (S.running) return;
    var p = current();
    if (!p || importing.has(p.id)) return;
    if (!window.Model.getConfig().hasKey) { openSettings(); return; }

    // 本地服务断了的话，请求根本发不出去，先告诉用户真正的原因
    if (heartbeat.offline) {
      var back = await ping();
      if (back !== 'ok') { toast('本地服务断了（start.bat 那个黑窗口还在吗？）。重新双击 start.bat 再试。', 'err'); return; }
    }
    if (S.running || !S.patients.includes(p) || importing.has(p.id)) return;

    var todo = assetsOf(p.id).filter(function (a) { return a.status === 'pending' || a.status === 'error'; });

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
    S.runningPatientId = p.id;
    S.progress = { done: 0, total: todo.length };
    setPill('识别中 0/' + todo.length, 'busy');
    renderAll();
    var failed = 0;

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
        S.progress.done++;
        setPill('识别中 ' + S.progress.done + '/' + todo.length, 'busy');
        renderAll();
      }
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());
    try {
      await Promise.all(workers);
    } finally {
      finishRecognition(p.id);
    }

    var u = window.Model.getUsage();
    toast(p.code + '识别完成：' + Math.max(0, todo.length - failed) + ' 页成功，' + failed + ' 页失败。' +
      '本次累计调用 ' + u.calls + ' 次，平均 ' + u.avgMs + ' ms/次', failed ? 'err' : 'ok');
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
    $('#modal-box').innerHTML = '<button type="button" class="modal-close" data-close="1" aria-label="关闭">×</button>' + html;
    m.hidden = false;
    $('#modal-box .modal-close').focus();
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
      '<div class="field"><label for="cfg-key">API Key</label>' +
      '<input id="cfg-key" type="password" placeholder="sk-..." value="' + esc(c.hasKey ? '••••••••' : '') + '">' +
      '<p class="note">只保存在这台电脑的浏览器里（localStorage），不会上传到任何地方，也不会写进导出的文件。' +
      '需要在模型服务商后台自行申请。</p></div>' +
      '<div class="field"><label for="cfg-base">接口地址</label>' +
      '<input id="cfg-base" value="' + esc(c.base) + '">' +
      '<p class="note">默认 https://api.deepseek.com。换成别的服务商时，要确认它允许浏览器直接调用。</p></div>' +
      '<div class="field"><label for="cfg-model">模型</label>' +
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
      renderWorkspace();
      toast('已保存', 'ok');
    });
  }

  function reportAsset(assetId) {
    return S.assets.find(function (a) { return a.id === assetId && a.patientId === S.currentId; });
  }

  function showDetail(detail) {
    var p = current();
    if (!p) return;
    viewOf(p.id).detail = detail;
    renderTable();
    renderInspector();
    var heading = $('#inspector-title');
    if (heading) heading.focus({ preventScroll: true });
  }

  function openSource(assetId) {
    if (reportAsset(assetId)) showDetail({ assetId: assetId });
  }

  function openCompare(indId) {
    if (window.Library.byId(indId)) showDetail({ indId: indId });
  }

  function inspectorHeading(title, detail) {
    return '<div class="inspector-heading"><div><h2 id="inspector-title" tabindex="-1">' + esc(title) + '</h2>' +
      '<p class="muted">' + esc(detail) + '</p></div>' +
      '<button type="button" class="btn inspector-close" data-inspector="close" aria-label="关闭核对详情">×</button></div>';
  }

  function sourceImage(asset, caption) {
    return '<figure class="source-page"><figcaption><span>' + esc(caption) + '</span>' +
      '<button type="button" class="link" data-zoom="' + esc(asset.id) + '">放大原图</button></figcaption>' +
      '<img class="source-img" src="' + esc(asset.dataUrl) + '" alt="' + esc(assetLabel(asset)) + '原图"></figure>';
  }

  function reportDetail(a) {
    var opts = docTypeList().map(function (type) {
      return '<option value="' + esc(type) + '"' + (a.docType === type ? ' selected' : '') + '>' + esc(type) + '</option>';
    }).join('');
    return inspectorHeading(assetLabel(a, a.reportDate), a.name) +
      (a.error ? '<p role="alert" class="inspector-error">' + esc(a.error) + '</p>' : '') +
      sourceImage(a, '报告原页') +
      '<div class="field retype-field"><label for="src-type">文书类型</label>' +
      '<select id="src-type" class="select">' + opts + '</select>' +
      '<button id="src-retype" type="button" class="btn"' + (S.running || a.lowRes ? ' disabled' : '') + '>按此类型重新识别</button></div>';
  }

  function indicatorDetail(ind, detail) {
    var c = cellState(S.currentId, ind.id);
    var chosen = c.list.find(function (o) { return o.id === detail.observationId; }) || c.obs;
    var asset = chosen && reportAsset(chosen.assetId);
    var multiple = c.list.length > 1 && c.state !== 'missing' && c.state !== 'absent';
    var html = inspectorHeading(ind.name, current().code + ' · ' + stateLabel(c));
    if (multiple) {
      html += '<div class="source-choices" role="group" aria-label="报告来源">' + c.list.map(function (o) {
        return '<button type="button" class="source-choice" data-observation="' + esc(o.id) + '"' +
          ' aria-pressed="' + (o === chosen) + '"><span>' + esc(srcLabel(o.assetId, obsDate(o))) + '</span>' +
          '<strong>' + esc(o.value) + ' ' + esc(o.unit) + '</strong></button>';
      }).join('') + '</div>';
    }

    if (chosen && c.state !== 'missing' && c.state !== 'absent') {
      html += '<dl class="source-value"><div><dt>识别值</dt><dd>' + esc(chosen.value) + ' ' + esc(chosen.unit) + '</dd></div>' +
        '<div><dt>报告项目</dt><dd>' + esc(chosen.rawName || ind.name) + '</dd></div>' +
        (chosen.ref ? '<div><dt>参考范围</dt><dd>' + esc(chosen.ref) + '</dd></div>' : '') + '</dl>';
    }
    if (asset) html += sourceImage(asset, assetLabel(asset, obsDate(chosen)));
    if (c.state === 'missing' || c.state === 'absent') {
      html += '<p class="inspector-note">当前报告没有这个指标。</p>' +
        '<button type="button" class="btn" data-inspector="upload"' +
        (importing.has(S.currentId) ? ' disabled' : '') + '>补传报告</button>';
    }
    if (chosen && (c.state === 'conflict' || (c.state === 'low' && chosen === c.obs))) {
      html += '<button type="button" class="btn primary" data-pick="' + esc(chosen.id) + '">' +
        (c.state === 'conflict' ? '以此为准' : '确认识别值') + '</button>';
    }

    var fieldValue = chosen && c.state !== 'missing' && c.state !== 'absent' ? chosen.value : '';
    html += '<details class="manual-edit"><summary>' + (fieldValue ? '手动修正' : '手动补录') + '</summary>' +
      '<form id="manual-result"><label for="manual-value">结果' + (ind.unit ? ' · ' + esc(ind.unit) : '') + '</label>' +
      '<input id="manual-value" name="value" value="' + esc(fieldValue) + '" required>' +
      '<button type="submit" class="btn">保存</button></form></details>';
    return html;
  }

  function renderInspector() {
    var inspector = $('#inspector');
    var p = current();
    var detail = p && viewOf(p.id).detail;
    var a = detail && reportAsset(detail.assetId);
    var ind = detail && window.Library.byId(detail.indId);
    var visible = Boolean(a || ind);
    if (visible) {
      var key = p.id + ':' + (a ? a.id : ind.id);
      if (inspector.dataset.detail === key && inspector.contains(document.activeElement) &&
        document.activeElement.matches('input, select')) return;
      inspector.dataset.detail = key;
      var scroll = inspector.scrollTop;
      inspector.innerHTML = a ? reportDetail(a) : indicatorDetail(ind, detail);
      inspector.scrollTop = scroll;
    }
    inspector.hidden = !visible;
    if (!visible) {
      delete inspector.dataset.detail;
      inspector.innerHTML = '';
    }
    $('#workbench').classList.toggle('inspector-open', visible);
  }

  function activeObservation(indId, chosenId) {
    var c = cellState(S.currentId, indId);
    var o = c.list.find(function (item) { return item.id === chosenId; }) || c.obs;
    return o && (!S.dateFilter || obsDate(o) === S.dateFilter) ? o : null;
  }

  /* ---------------- 复核历史 ----------------
   * 没有账号体系，所以不记"谁"，只记"什么时候、对哪一项、从什么改成什么、依据哪一份"。
   * 记录只存在本机（跟着任务缓存一起存），导出 JSON 时一起带出，同样受脱敏开关控制。
   * 冲突裁决会从 observations 里移除被否决的来源（否则它还会参与冲突计算），
   * 但它的值会写进 dropped，历史里不会凭空消失。 */
  var ACTION_NAME = {
    'manual-edit': '人工改值',
    'manual-add': '人工补录',
    'low-confirm': '低置信确认',
    'conflict-pick': '冲突裁决',
    'confirm': '人工确认'
  };
  function obsSourceText(o) {
    if (!o) return '';
    if (!o.assetId) return '人工录入';
    var a = S.assets.filter(function (x) { return x.id === o.assetId; })[0];
    if (!a) return '未知来源';
    var base = a.kind === 'pdf' ? '报告' + a.fileIndex + '-第' + a.pageNo + '页' : '报告' + a.fileIndex;
    return base + (o.date ? ' · ' + String(o.date).slice(5, 10) : '');
  }
  function logReview(action, indId, before, after, extra) {
    var ind = window.Library.byId(indId);
    var p = current();
    var e = {
      id: uid('review'),
      at: new Date().toISOString(),
      operator: '本机操作',
      patientId: S.currentId,
      patientCode: p ? p.code : '',
      code: indId,
      name: ind ? ind.name : indId,
      action: action,
      before: before == null ? '' : String(before),
      after: after == null ? '' : String(after),
      source: (extra && extra.source) || '',
      picked: (extra && extra.picked) || '',
      dropped: (extra && extra.dropped) || []
    };
    S.reviews.push(e);
    return e;
  }

  function writeManual(indId, value, observation, silent) {
    var o = observation;
    var beforeValue = o ? String(o.value == null ? '' : o.value) : '';
    var beforeSource = obsSourceText(o);
    var created = false;
    if (!o) {
      var ind = window.Library.byId(indId);
      o = {
        id: uid('obs'), patientId: S.currentId, assetId: null, rawName: '',
        indicatorId: indId, unit: ind.unit, ref: ind.ref,
        date: S.dateFilter, confidence: 1
      };
      S.observations.push(o);
      created = true;
    }
    o.value = value;
    o.method = 'manual';
    // silent：输入过程中的逐字写入不记历史，等 change 时统一记一条
    if (!silent && String(beforeValue) !== String(value == null ? '' : value)) {
      logReview(created ? 'manual-add' : 'manual-edit', indId, beforeValue, value, { source: beforeSource });
    }
    return o;
  }

  function finishReview(indId, before) {
    var view = viewOf(S.currentId);
    var next;
    if (view.mode === 'review') {
      var remaining = reviewRows(S.currentId);
      var index = before.findIndex(function (row) { return row.id === indId; });
      next = before.slice(index + 1).find(function (row) {
        return remaining.some(function (item) { return item.id === row.id; });
      }) || remaining[0];
      view.detail = next ? { indId: next.id } : null;
    }
    renderAll();
    if (next) $('#inspector-title').focus({ preventScroll: true });
    else if (view.mode === 'review') $('#btn-review').focus({ preventScroll: true });
  }

  /* 冲突裁决只替换同一天的来源，保留其他就诊时间的结果；
   * 顺带把"这次确认/裁决"写进复核历史（含被否决的来源，便于事后追溯）。 */
  function pickObservation(obsId) {
    var keep = S.observations.find(function (o) { return o.id === obsId && o.patientId === S.currentId; });
    if (!keep) return;
    var c = cellState(S.currentId, keep.indicatorId);
    var before = reviewRows(S.currentId);
    var beforeValue = c.obs ? String(c.obs.value == null ? '' : c.obs.value) : '';
    var action = c.state === 'conflict' ? 'conflict-pick' : (c.state === 'low' ? 'low-confirm' : 'confirm');
    var dropped = [];
    if (c.state === 'conflict') {
      var keepDate = obsDate(keep);
      dropped = S.observations.filter(function (o) {
        return o !== keep && o.patientId === keep.patientId && o.indicatorId === keep.indicatorId && obsDate(o) === keepDate;
      }).map(function (o) {
        return String(o.value) + '（' + obsSourceText(o) + '）';
      });
      S.observations = S.observations.filter(function (o) {
        return o === keep || o.patientId !== keep.patientId || o.indicatorId !== keep.indicatorId || obsDate(o) !== keepDate;
      });
    }
    keep.method = 'manual';
    logReview(action, keep.indicatorId, beforeValue, String(keep.value == null ? '' : keep.value), {
      source: obsSourceText(keep), picked: obsSourceText(keep), dropped: dropped
    });
    finishReview(keep.indicatorId, before);
    toast('已核对' + window.Library.byId(keep.indicatorId).name, 'ok');
  }

  /* ---------------- 指标与页面 ---------------- */

  var libTab = 'ind';
  var libForm = null;   // {kind:'ind'|'page', mode:'new'|'edit', id:'...'}

  function libChangeDone(msg) {
    invalidateReq();          // 组预设、指标、页面都可能刚被改过，必填要重算
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

  /* ---------------- 页面组 ---------------- */

  function groupRows() {
    var groups = window.Library.groups();
    if (!groups.length) {
      return '<tr><td colspan="5" class="tiny muted">还没有组。点右上角「新建组」，把常用的几页打成一包。</td></tr>';
    }
    return groups.map(function (g) {
      var names = g.pageIds.map(function (pid) {
        var p = window.Library.pageById(pid);
        return p ? p.name : '';
      }).filter(Boolean);
      return '<tr>' +
        '<td>' + esc(g.name) + '</td>' +
        '<td class="mono">' + g.pageIds.length + '</td>' +
        '<td class="mono">' + (g.reqIds.length ? g.reqIds.length : '—') + '</td>' +
        '<td class="tiny muted">' + esc(names.slice(0, 6).join('、')) + (names.length > 6 ? ' …' : '') + '</td>' +
        '<td class="row-act">' +
          '<button class="link" data-act="grp-edit" data-id="' + esc(g.id) + '">编辑</button>' +
          '<button class="link danger" data-act="grp-del" data-id="' + esc(g.id) + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  function groupForm() {
    var isEdit = libForm && libForm.mode === 'edit';
    var g = isEdit ? window.Library.groupById(libForm.id) : null;
    if (isEdit && !g) { libForm = null; return ''; }
    var pickedPages = g ? g.pageIds : [];
    var pickedReq = g ? g.reqIds : [];

    var pageList = window.Library.pages().map(function (p) {
      var on = pickedPages.indexOf(p.id) !== -1;
      return '<label class="pick' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" class="g-page" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + esc(p.name) + '</span>' +
        '<span class="tiny muted">' + p.ids.length + ' 项</span>' +
        '</label>';
    }).join('');

    var reqList = window.Library.indicators().map(function (i) {
      var on = pickedReq.indexOf(i.id) !== -1;
      return '<label class="pick' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" class="g-req" value="' + esc(i.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="mono">' + esc(i.id) + '</span>' +
        '<span>' + esc(i.name) + '</span>' +
        '</label>';
    }).join('');

    return '<div class="lib-form">' +
      '<div class="form-grid">' +
        '<label class="span2">组名<input id="g-name" value="' + esc(g ? g.name : '') + '" placeholder="淋巴瘤专项检查"></label>' +
      '</div>' +
      '<p class="note">勾选这个组时，下面这些页面会一起被勾上。同一个页面可以同时属于多个组。</p>' +
      '<input id="g-page-search" class="pick-search" placeholder="筛选页面…">' +
      '<div id="g-pages" class="pick-list short">' + pageList + '</div>' +
      '<p class="note">这一组里哪些指标算"缺了要标红"。可以留空——留空就只勾页面、不设必填。</p>' +
      '<input id="g-req-search" class="pick-search" placeholder="筛选指标…">' +
      '<div id="g-reqs" class="pick-list short">' + reqList + '</div>' +
      '<div class="form-act">' +
        '<button class="btn tiny primary" data-act="grp-save">保存</button>' +
        '<button class="btn tiny ghost" data-act="grp-cancel">取消</button>' +
      '</div>' +
    '</div>';
  }

  function pageRows() {
    return window.Library.pages().map(function (p) {
      var t = p.docType || '';
      var tag = t
        ? '<span class="doc-tag">' + esc(t) + '</span>'
        : '<span class="doc-tag none" title="没选文书类型，模型不会定向抽取这一页的指标">未分类</span>';
      return '<tr>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td>' + tag + '</td>' +
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
    var curType = page ? (page.docType || '') : '';

    var typeOpts = '<option value="">（未选，暂不参与定向抽取）</option>' +
      docTypeList().map(function (t) {
        return '<option value="' + esc(t) + '"' + (curType === t ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('');

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
        '<label class="span2">文书类型<select id="p-doctype">' + typeOpts + '</select></label>' +
      '</div>' +
      '<p class="note">"文书类型"决定模型在哪一类报告里找这些指标。比如新建一页"心肌酶"并选"生化"，' +
      '模型读到生化单时就会连带抽这几个项目；不选类型的话，这一页只能手工填。</p>' +
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
        '<button class="tab' + (libTab === 'grp' ? ' active' : '') + '" data-tab="grp">页面组 <b>' + window.Library.groups().length + '</b></button>' +
        '<div class="tabs-right">' +
          '<button class="link tiny" data-act="lib-export">导出配置</button>' +
          '<button class="link tiny" data-act="lib-import">导入配置</button>' +
          '<button class="btn tiny primary" data-act="' + (libTab === 'ind' ? 'ind-new' : libTab === 'page' ? 'page-new' : 'grp-new') + '">+ ' +
            (libTab === 'ind' ? '新建指标' : libTab === 'page' ? '新建页面' : '新建组') + '</button>' +
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
    } else if (libTab === 'grp') {
      html += (libForm && libForm.kind === 'grp' ? groupForm() : '') +
        '<div class="pane-scroll">' +
          '<table class="mini-grid"><thead><tr>' +
            '<th>组名</th><th>页面数</th><th>必填预设</th><th>包含</th><th></th>' +
          '</tr></thead><tbody>' + groupRows() + '</tbody></table>' +
        '</div>';
    } else {
      html += (libForm && libForm.kind === 'page' ? pageForm() : '') +
        '<div class="pane-scroll">' +
          '<table class="mini-grid"><thead><tr>' +
            '<th>页面</th><th>文书类型</th><th>指标数</th><th>包含</th><th></th>' +
          '</tr></thead><tbody>' + pageRows() + '</tbody></table>' +
        '</div>';
    }

    $('#modal-box').innerHTML = '<button type="button" class="modal-close" data-close="1" aria-label="关闭">×</button>' + html;

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

    // 页面组表单里的两个筛选框与勾选高亮
    [['#g-page-search', '#g-pages'], ['#g-req-search', '#g-reqs']].forEach(function (pair) {
      var box2 = $(pair[0]);
      var list = $(pair[1]);
      if (box2 && list) {
        box2.addEventListener('input', function () {
          var q = box2.value.trim().toLowerCase();
          $$(pair[1] + ' .pick').forEach(function (el) {
            el.hidden = !!(q && el.textContent.toLowerCase().indexOf(q) === -1);
          });
        });
      }
    });
    $$('#g-pages .pick input, #g-reqs .pick input').forEach(function (cb) {
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
        var rid = btn.value;
        setReq(rid, btn.checked);
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
        var dtSel = $('#p-doctype');
        var payload = { name: $('#p-name').value, ids: ids, docType: dtSel ? dtSel.value : '' };
        var saved;
        if (libForm.mode === 'edit') saved = window.Library.updatePage(libForm.id, payload);
        else {
          saved = window.Library.addPage(payload);
          var sel0 = loadSelected();
          if (sel0.ids.indexOf(saved.id) === -1) sel0.ids.push(saved.id);
          saveSelected();
        }
        // 没选文书类型：这一页不会参与定向抽取，必须说清楚，不能让人以为保存就等于能识别
        if (!payload.docType) {
          libChangeDone('页面已保存，但还没选"文书类型"，模型不会自动抽取这一页的指标', 'err');
        } else {
          libChangeDone('页面已保存');
        }
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
      else if (act === 'grp-new') { libForm = { kind: 'grp', mode: 'new' }; renderLibrary(); }
      else if (act === 'grp-edit') { libForm = { kind: 'grp', mode: 'edit', id: id }; renderLibrary(); }
      else if (act === 'grp-cancel') { libForm = null; renderLibrary(); }
      else if (act === 'grp-save') {
        var gp = $$('#g-pages input:checked').map(function (cb) { return cb.value; });
        var gr = $$('#g-reqs input:checked').map(function (cb) { return cb.value; });
        var gpayload = { name: $('#g-name').value, pageIds: gp, reqIds: gr };
        if (libForm.mode === 'edit') {
          gpayload.id = libForm.id;
          var oldGroup = window.Library.groupById(libForm.id);
          gpayload.reqIds = gr;
          window.Library.updateGroup(gpayload);
        } else {
          window.Library.addGroup(gpayload);
        }
        libChangeDone('页面组已保存');
        libForm = null;
        renderLibrary();
      }
      else if (act === 'grp-del') {
        if (!confirm('删除这个组？页面和指标都不会被删除，只是这个快捷开关没了。')) return;
        window.Library.removeGroup(id);
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
    ok: '已识别', low: '低置信度', missing: '必填缺失',
    conflict: '数值冲突', absent: '未提供'
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

  /* 直接标识符：导出时按开关统一处理。
   * 姓名、身份证、电话、其他联系方式、地址，都是"看见就知道是谁"的字段；
   * 住院号也纳入——它在医院范围内能直接对应到个人，而导出表里已经有
   * "患者 01"这样的批次内编号，不影响核对。 */
  var IDENT_IDS = { NAME: 1, ADMNO: 1, IDNO: 1, PHONE: 1, PHONE2: 1, ADDR: 1, HUKOU: 1 };
  var MASK_TEXT = '（已隐藏）';
  var HIDE_KEY = 'jiaowolu.hideIdent';
  function hideIdent() {
    try { return localStorage.getItem(HIDE_KEY) !== '0'; } catch (e) { return true; }
  }

  /* 报告文件名里常常带着患者姓名，导出时按同一套规则替换掉 */
  function identSecrets(pid) {
    return S.observations.filter(function (o) {
      return o.patientId === pid && IDENT_IDS[o.indicatorId] && o.value;
    }).map(function (o) {
      return String(o.value).trim();
    }).filter(function (v) {
      return v.length >= 2;
    });
  }
  function maskText(text, secrets) {
    var s = String(text == null ? '' : text);
    if (!hideIdent()) return s;
    (secrets || []).forEach(function (v) {
      if (!v) return;
      s = s.split(v).join(MASK_TEXT);
    });
    return s;
  }

  /* 单位与参考范围：报告上印的为准，报告没写才回退到指标库默认值。
   * 界面、CSV、JSON 都走这两个函数，避免三处口径不一致。 */
  function effectiveUnit(c, ind) {
    var u = c && c.obs && c.obs.unit ? String(c.obs.unit).trim() : '';
    return u || (ind && ind.unit) || '';
  }
  function effectiveRef(c, ind) {
    var r = c && c.obs && c.obs.ref ? String(c.obs.ref).trim() : '';
    return r || (ind && ind.ref) || '';
  }

  function collectRows(pid, date) {
    var secrets = identSecrets(pid);
    return targetIds().map(function (id) {
      var ind = window.IndicatorLib.byId(id);
      if (!ind) return null;
      var c = cellState(pid, id, date);
      var a = c.obs && c.obs.assetId
        ? S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0]
        : null;
      var val = c.obs ? c.obs.value : '';
      var masked = false;
      if (val && IDENT_IDS[ind.id] && hideIdent()) { val = MASK_TEXT; masked = true; }
      else if (val && hideIdent()) { val = maskText(val, secrets); }
      return {
        code: ind.id, name: ind.name, type: ind.type || 'num',
        value: val,
        // 报告原单位/原参考范围优先，缺省才用指标库默认值
        unit: effectiveUnit(c, ind),
        ref: effectiveRef(c, ind),
        state: c.state, stateName: stateLabel(c),
        masked: masked,
        source: a ? (a.kind === 'pdf' ? '报告' + a.fileIndex + '-第' + a.pageNo + '页' : '报告' + a.fileIndex) : '',
        sourceType: a && a.reportType ? a.reportType : '',
        docType: a && (a.docType || a.reportType) ? (a.docType || a.reportType) : '',
        fromNarrative: !!(c.obs && c.obs.src === 'narrative'),
        confidence: c.obs && c.obs.confidence != null ? c.obs.confidence : null
      };
    }).filter(Boolean);
  }

  /* 复核历史按"本次导出的患者"筛出来；里面的值同样走脱敏开关 */
  function collectReviews(patients) {
    var byCode = {};
    S.patients.forEach(function (p) { byCode[p.code] = p; });
    var out = [];
    patients.forEach(function (pt) {
      var sp = byCode[pt.code];
      if (!sp) return;
      var secrets = identSecrets(sp.id);
      S.reviews.filter(function (r) { return r.patientId === sp.id; }).forEach(function (r) {
        out.push({
          at: r.at, patient: r.patientCode, indicator: r.code, name: r.name,
          action: r.action, actionName: ACTION_NAME[r.action] || r.action,
          before: maskText(r.before, secrets), after: maskText(r.after, secrets),
          source: maskText(r.source, secrets), picked: maskText(r.picked, secrets),
          dropped: (r.dropped || []).map(function (d) { return maskText(d, secrets); }),
          operator: r.operator
        });
      });
    });
    return out;
  }

  function exportJson(patients, filename) {
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
      // 人工复核与冲突裁决的历史：谁改了什么、依据哪一份、否决了哪些来源
      reviewHistory: collectReviews(patients),
      patients: patients
    };
    saveText(filename + '.json', JSON.stringify(out, null, 2));
  }

  /* ---------------- 指标与页面的配置导入导出 ----------------
   * 这是"可分享的模板"能成立的前提：一所医院把指标和页面配好，导出成 JSON
   * 发给另一所，对方导入即可用同一套要求。 */
  function exportLibrary() {
    var cfg = {
      app: 'jiaowolu', kind: 'library', version: 2,
      exportedAt: new Date().toISOString(),
      indicators: window.Library.indicators(),
      pages: window.Library.pages(),
      groups: window.Library.groups()
    };
    saveText('交我录-指标与页面-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(cfg, null, 2));
    toast('已导出 ' + cfg.indicators.length + ' 个指标、' + cfg.pages.length + ' 个页面、' + cfg.groups.length + ' 个页面组');
  }

  function applyLibrary(cfg) {
    var L = window.Library;
    // 顺序不能反：页面要用指标代号做校验，所以指标必须先落地
    L.groups().slice().forEach(function (g) { L.removeGroup(g.id); });
    L.pages().slice().forEach(function (p) { L.removePage(p.id); });
    L.indicators().slice().forEach(function (i) { L.removeIndicator(i.id); });
    (cfg.indicators || []).forEach(function (i) {
      L.addIndicator({
        id: i.id, name: i.name, group: i.group, type: i.type || 'num',
        unit: i.unit, ref: i.ref, aliases: i.aliases
      });
    });
    // 页面导入时 id 会重新生成，组的页面引用要跟着换算，否则组会指向不存在的页面
    var idMap = {};
    (cfg.pages || []).forEach(function (p) {
      var np = L.addPage({ name: p.name, ids: p.ids || [], docType: p.docType || '', kind: p.kind });
      idMap[p.id] = np.id;
    });
    (cfg.groups || []).forEach(function (g) {
      if (!g || !g.name) return;
      var pageIds = (g.pageIds || []).map(function (pid) { return idMap[pid]; }).filter(Boolean);
      if (!pageIds.length) return;
      try {
        L.addGroup({ name: g.name, pageIds: pageIds, reqIds: g.reqIds || [] });
      } catch (e) { /* 单个组不合法就跳过，不要把整次导入搞挂 */ }
    });
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

  function exportCsv(patients, filename) {
    var rows = [['患者', '指标代号', '指标名称', '结果', '单位', '参考范围', '状态', '来源', '报告类型', '取值方式']];
    patients.forEach(function (p) {
      p.rows.forEach(function (row) {
        rows.push([p.code, row.code, row.name, row.value, row.unit, row.ref, row.stateName,
          row.source, row.docType, row.source ? (row.fromNarrative ? '文中摘录' : '表格') : '']);
      });
    });
    var csv = rows.map(function (row) {
      return row.map(function (value) {
        var s = String(value == null ? '' : value);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    saveText(filename + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  }

  function exportScopeLabel(patients, single) {
    return single ? patients[0].code : '本批全部 ' + patients.length + ' 位患者';
  }

  var pendingExport = null;

  function requestExport(format) {
    var patient = current();
    var scope = patient ? [patient] : S.patients;
    if (!scope.length) return;
    var date = patient ? S.dateFilter : '';
    var patients = scope.map(function (p) {
      var secrets = identSecrets(p.id);
      return {
        code: p.code,
        reports: assetsOf(p.id).map(function (a) {
          return {
            file: maskText(a.name || a.sourceName || '', secrets),
            page: a.pageNo || null,
            // docType 是本地判型结果，reportType 是模型在抽取时回报的类型，
            // 两个都有时以本地判型为准（用户可以在设置里手动改 docType）
            type: a.docType || a.reportType || '',
            date: a.reportDate || ''
          };
        }),
        rows: collectRows(p.id, date)
      };
    });
    var count = patients.reduce(function (total, p) {
      return total + p.rows.filter(function (row) { return needsReview(row.state); }).length;
    }, 0);
    var label = exportScopeLabel(scope, !!patient);
    var filename = '交我录-' + (patient ? patient.code : '全部患者') + '-' + new Date().toISOString().slice(0, 10);
    pendingExport = { format: format, patients: patients, filename: filename, label: label };
    if (!count) { completeExport(); return; }

    $('#export-message').textContent = label + ' 还有 ' + count + ' 项待核对。可以返回核对，也可以继续导出 ' + format + '。';
    $('#export-dialog').showModal();
    $('#export-dialog [data-close-dialog]').focus();
  }

  function completeExport() {
    var job = pendingExport;
    pendingExport = null;
    if (!job) return;
    if (job.format === 'CSV') exportCsv(job.patients, job.filename);
    else exportJson(job.patients, job.filename);
    toast('已导出 ' + job.format + ' · ' + job.label, 'ok');
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('#btn-add-patient').addEventListener('click', function () { addPatient(); });
    $('#btn-all-patients').addEventListener('click', function () { selectPatient(null); });
    $('#batch-overview').addEventListener('click', function (e) {
      var target = e.target.closest('[data-pid]');
      if (target) selectPatient(target.dataset.pid);
    });

    $('#patient-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        removePatient(del.getAttribute('data-del'));
        return;
      }
      var row = e.target.closest('[data-pid]');
      if (row) selectPatient(row.dataset.pid);
    });

    var rulesDialog = $('#rules-dialog');
    var preset = $('#rule-preset');
    var applyPreset = $('#btn-apply-rule');
    $('#btn-rules').addEventListener('click', function () {
      preset.replaceChildren(new Option('选择页面组', ''));
      window.Library.groups().filter(function (group) { return group.pageIds.length; }).forEach(function (group) {
        preset.add(new Option(group.name, group.id));
      });
      applyPreset.disabled = true;
      rulesDialog.showModal();
    });
    preset.addEventListener('change', function () { applyPreset.disabled = !preset.value; });
    applyPreset.addEventListener('click', function () {
      var group = window.Library.groupById(preset.value);
      if (!group) return;
      selected = { ids: group.pageIds.slice(), add: [], drop: [] };
      saveSelected();
      renderAll();
      applyPreset.disabled = true;
    });

    /* ---------------- 一句话质控任务：AI 提案，本地校验，人工确认 ---------------- */
    var pendingTaskPlan = null;
    var taskDialog = $('#task-dialog');

    function resetTaskDialog() {
      pendingTaskPlan = null;
      $('#task-preview').innerHTML = '';
      $('#btn-task-apply').disabled = true;
    }

    $('#btn-task-ai').addEventListener('click', function () {
      resetTaskDialog();
      if (rulesDialog.open) rulesDialog.close();
      taskDialog.showModal();
      $('#task-requirement').focus();
    });

    $$('[data-close-task]').forEach(function (button) {
      button.addEventListener('click', function () {
        // 关闭/取消只是放弃这次预览，绝不碰已有的 selected
        resetTaskDialog();
        taskDialog.close();
      });
    });

    $('#btn-task-generate').addEventListener('click', async function () {
      var button = this;
      var requirement = $('#task-requirement').value.trim();
      button.disabled = true;
      button.textContent = '正在生成…';
      $('#btn-task-apply').disabled = true;
      pendingTaskPlan = null;
      $('#task-preview').innerHTML = '<p class="muted">模型正在把这句要求转换成页面与必填配置，请稍候。</p>';
      try {
        pendingTaskPlan = await window.TaskAssistant.propose(
          requirement, window.Library, window.Model);
        renderTaskPlan(pendingTaskPlan);
      } catch (error) {
        pendingTaskPlan = null;
        $('#task-preview').innerHTML = '<p class="task-error">' + esc(error.message || String(error)) +
          '</p><p class="muted">可以关闭这个窗口，用上方的页面组和勾选框手动配置。</p>';
      } finally {
        button.disabled = false;
        button.textContent = '重新生成配置预览';
      }
    });

    $('#btn-task-apply').addEventListener('click', function () {
      if (!pendingTaskPlan) return;
      selected = window.TaskAssistant.toSelection(pendingTaskPlan, window.Library);
      saveSelected();
      resetTaskDialog();
      taskDialog.close();
      renderAll();
      toast('已应用质控任务：' + selected.ids.length + ' 个页面、' + selected.add.length + ' 项必填。请核对后上传报告。', 'ok');
    });

    function renderTaskPlan(plan) {
      var pageNames = plan.pageIds.map(function (id) {
        var page = window.Library.pageById(id);
        return page ? page.name : id;
      });
      var requiredNames = plan.requiredIndicatorIds.map(function (id) {
        var ind = window.Library.byId(id);
        return ind ? ind.name : id;
      });
      var notes = plan.warnings.concat(plan.unmatched.map(function (item) {
        return item.text + (item.reason ? '：' + item.reason : '');
      }));
      $('#task-preview').innerHTML = '<h3>配置预览</h3>' +
        (plan.summary ? '<p>' + esc(plan.summary) + '</p>' : '') +
        '<p><strong>整理页面（' + plan.pageIds.length + '）</strong></p><p>' + esc(pageNames.join('、')) + '</p>' +
        '<p><strong>必填指标（' + plan.requiredIndicatorIds.length + '）</strong></p><p>' +
        esc(requiredNames.length ? requiredNames.join('、') : '无；只整理，不设缺失标红') + '</p>' +
        (notes.length ? '<div class="task-warnings"><strong>未自动落实</strong><ul>' + notes.map(function (note) {
          return '<li>' + esc(note) + '</li>';
        }).join('') + '</ul></div>' : '') +
        '<p class="muted">确认后会替换当前本批规则，不会修改指标库，也不会自动开始识别。</p>';
      $('#btn-task-apply').disabled = false;
    }

    $('#action-queue').addEventListener('click', function (e) {
      var item = e.target.closest('[data-action-ind]');
      if (item) openCompare(item.getAttribute('data-action-ind'));
    });

    $('#page-checks').addEventListener('change', function (e) {
      var cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      var id = cb.value;
      var cur = loadSelected();
      selected = { ids: cur.ids.slice(), add: cur.add.slice(), drop: cur.drop.slice() };

      if (cb.classList.contains('grp-use')) {
        // 组只是"把页面一次勾上"的快捷方式：必填预设由 requiredIds() 自动派生，
        // 组勾上就生效、取消就失效，不用在这里做加减账。
        var g = window.Library.groupById(id);
        if (!g) return;
        if (cb.checked) {
          g.pageIds.forEach(function (pid) {
            if (selected.ids.indexOf(pid) === -1) selected.ids.push(pid);
          });
        } else {
          // 先记下"还被别的已勾组占着"的页面，避免两组有交集时把另一组也带崩
          var keep = {};
          var owner = '';
          activeGroups().forEach(function (o) {
            if (o.id === g.id) return;
            o.pageIds.forEach(function (pid) { keep[pid] = 1; owner = o.name; });
          });
          var removable = g.pageIds.filter(function (pid) { return !keep[pid]; });
          if (!removable.length) {
            // 整组都被别的组盖住了，取消它其实什么也不会发生——说清楚，别让人以为点了没反应
            toast('这组的页面已经包含在「' + owner + '」里了，要取消请从那边取消', 'err');
            renderAll();
            return;
          }
          removable.forEach(function (pid) {
            var i = selected.ids.indexOf(pid);
            if (i !== -1) selected.ids.splice(i, 1);
            forgetReqOfPage(pid);
          });
        }
        saveSelected();
        renderAll();
        return;
      }

      if (cb.classList.contains('pc-must')) {
        // 整页批量：勾上就整页必填，取消就整页都不必填（含之前单独标的那几项）
        setReqOfPage(id, cb.checked);
      } else {
        var i = selected.ids.indexOf(id);
        if (cb.checked && i === -1) selected.ids.push(id);
        if (!cb.checked && i !== -1) selected.ids.splice(i, 1);
        // 不参与本次的页面，就不该再占着"必填"——否则取消勾选后红点还在，像哑弹
        if (!cb.checked) forgetReqOfPage(id);
      }
      saveSelected();
      renderAll();
    });

    var input = $('#file-input');
    $('#btn-upload').addEventListener('click', function () { input.click(); });
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

    var dropTarget = $('#patient-work');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropTarget.addEventListener(ev, function (e) {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dropTarget.classList.add('over');
      });
    });
    dropTarget.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget || !dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('over');
    });
    dropTarget.addEventListener('drop', function (e) {
      e.preventDefault();
      dropTarget.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    $('#report-summary').addEventListener('click', function () {
      viewOf(S.currentId).reportsOpen = !$('#report-list').open;
    });
    ['review', 'all'].forEach(function (mode) {
      $(mode === 'review' ? '#btn-review' : '#btn-results-all').addEventListener('click', function () {
        var view = viewOf(S.currentId);
        view.mode = mode;
        view.modeChosen = true;
        try { localStorage.setItem('jiaowolu.startView', mode); } catch (e) { /* 忽略 */ }
        if (view.detail && view.detail.indId && mode === 'review' &&
          !needsReview(cellState(S.currentId, view.detail.indId).state)) view.detail = null;
        renderTable();
        renderInspector();
      });
    });

    // 表格：改值 / 看来源
    // 输入过程中只写值、不记历史，否则每敲一个字符就多一条记录；
    // 光标进入时把"改之前的值和来源"记在 dataset 上，change 时才落一条。
    $('#grid-body').addEventListener('focusin', function (e) {
      var inp = e.target.closest('.val-input');
      if (!inp || inp.dataset.before !== undefined) return;
      var o = activeObservation(inp.getAttribute('data-ind'));
      inp.dataset.before = o ? String(o.value == null ? '' : o.value) : '';
      inp.dataset.beforeSrc = obsSourceText(o);
    });
    $('#grid-body').addEventListener('input', function (e) {
      var inp = e.target.closest('.val-input');
      if (!inp) return;
      var id = inp.getAttribute('data-ind');
      writeManual(id, inp.value, activeObservation(id), true);
      var row = inp.closest('tr');
      var c = cellState(S.currentId, id);
      row.className = c.state + (row.classList.contains('selected-result') ? ' selected-result' : '');
      row.querySelector('.ind-dot').className = 'ind-dot ' + c.state;
      row.querySelector('.cell-state').innerHTML = badgeOf(c);
      renderStats();
      renderPatients();
      cacheSchedule();
    });
    $('#grid-body').addEventListener('change', function (e) {
      var inp = e.target.closest('.val-input');
      if (!inp) return;
      var before = inp.dataset.before === undefined ? '' : inp.dataset.before;
      if (String(before) !== String(inp.value)) {
        logReview(inp.dataset.beforeSrc ? 'manual-edit' : 'manual-add', inp.getAttribute('data-ind'),
          before, inp.value, { source: inp.dataset.beforeSrc || '' });
        cacheSchedule();
      }
      delete inp.dataset.before;
      delete inp.dataset.beforeSrc;
      renderInspector();
    });

    $('#grid-body').addEventListener('click', function (e) {
      var g = e.target.closest('.group-row');
      if (g) {
        var pid = g.dataset.page;
        S.collapse[pid] = g.querySelector('.group-toggle').getAttribute('aria-expanded') === 'true';
        renderTable();
        $('.group-row[data-page="' + CSS.escape(pid) + '"] button').focus({ preventScroll: true });
        return;
      }
      var cmp = e.target.closest('[data-cmp]');
      if (cmp) { openCompare(cmp.getAttribute('data-cmp')); return; }
    });

    $('#date-bar').addEventListener('click', function (e) {
      var chip = e.target.closest('.date-chip');
      if (!chip) return;
      S.dateFilter = chip.getAttribute('data-date') || '';
      viewOf(S.currentId).date = S.dateFilter;
      renderDateBar();
      renderStats();
      renderTable();
      renderInspector();
      $('.date-chip.on').focus({ preventScroll: true });
    });

    $('#asset-strip').addEventListener('click', function (e) {
      var retry = e.target.closest('[data-retry]');
      if (retry) { retryOne(reportAsset(retry.dataset.retry)); return; }
      var a = e.target.closest('[data-aid]');
      if (a) openSource(a.dataset.aid);
    });

    $('#btn-run').addEventListener('click', runRecognize);
    $('#btn-export').addEventListener('click', function () { requestExport('CSV'); });
    $('#btn-export-json').addEventListener('click', function () { requestExport('JSON'); });
    $('#btn-confirm-export').addEventListener('click', function () {
      $('#export-dialog').close();
      completeExport();
    });
    $('#export-dialog').addEventListener('close', function () {
      if (!this.open) pendingExport = null;
    });
    $$('[data-close-dialog]').forEach(function (button) {
      button.addEventListener('click', function () { button.closest('dialog').close(); });
    });
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
    $('#btn-library').addEventListener('click', function () { rulesDialog.close(); openLibrary('ind'); });

    $('#inspector').addEventListener('click', function (e) {
      var button = e.target.closest('button');
      if (!button) return;
      var view = viewOf(S.currentId);
      var detail = view.detail;
      if (button.dataset.inspector === 'close') {
        view.detail = null;
        renderTable();
        renderInspector();
        var trigger = detail.indId ? $('.indicator-link[data-cmp="' + CSS.escape(detail.indId) + '"]') :
          $('[data-aid="' + CSS.escape(detail.assetId) + '"]');
        if (trigger) trigger.focus({ preventScroll: true });
      } else if (button.dataset.inspector === 'upload') {
        input.click();
      } else if (button.dataset.observation) {
        detail.observationId = button.dataset.observation;
        renderInspector();
        $('[data-observation="' + CSS.escape(detail.observationId) + '"]').focus({ preventScroll: true });
      } else if (button.dataset.pick) {
        pickObservation(button.dataset.pick);
      } else if (button.dataset.zoom) {
        var asset = reportAsset(button.dataset.zoom);
        if (asset) openModal('<h3>' + esc(assetLabel(asset, asset.reportDate)) + '</h3>' +
          '<img class="source-img" src="' + esc(asset.dataUrl) + '" alt="报告原图">', 'wide');
      } else if (button.id === 'src-retype') {
        var report = reportAsset(detail.assetId);
        if (!report || S.running || report.lowRes) return;
        if (!window.Model.getConfig().hasKey) { openSettings(); return; }
        report.docType = $('#src-type').value;
        report.typeForced = true;
        report.status = 'pending';
        retryOne(report);
      }
    });

    $('#inspector').addEventListener('submit', function (e) {
      if (e.target.id !== 'manual-result') return;
      e.preventDefault();
      var field = $('#manual-value');
      if (!field.value.trim()) { field.focus(); return; }
      var detail = viewOf(S.currentId).detail;
      var o = writeManual(detail.indId, field.value.trim(), activeObservation(detail.indId, detail.observationId));
      pickObservation(o.id);
    });

    $('#modal-box').addEventListener('click', function (e) {
      if (e.target.closest('[data-act]') || e.target.closest('[data-tab]')) handleLibraryClick(e);
    });

    $('#btn-reset').addEventListener('click', function () {
      if (!confirm('清空本次任务的所有报告和识别结果？')) return;
      S.assets = [];
      S.observations = [];
      S.patients = [];
      S.currentId = null;
      S.seq = { patient: 0, asset: 0, obs: 0 };
      patientViews.clear();
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
      else if (e.key === 'Escape' && !$('#inspector').hidden &&
        !$('#rules-dialog').open && !$('#export-dialog').open) $('#inspector [data-inspector="close"]').click();
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
    else if (S.currentId) S.collapse = viewOf(S.currentId).collapse;
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
  // 给自动化测试用的只读钩子：验证"新建页面+文书类型"是否真的进入了候选
  window.__docPages = docPages;
  window.__candidatesFor = candidatesFor;
  window.__targetIds = targetIds;
    window.__parseJson = parseJson;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
