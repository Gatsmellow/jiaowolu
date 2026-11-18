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

  var S = {
    patients: [],
    currentId: null,
    assets: [],
    observations: [],
    running: false,
    seq: { patient: 0, asset: 0, obs: 0 }
  };

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
   * 只有明确标了"必填"的页面，缺项才算质控问题。默认一个都不标。 */
  var SEL_KEY = 'jiaowolu.selectedPages.v2';
  var selected = null;

  function loadSelected() {
    if (selected) return selected;
    var raw = null;
    try { raw = localStorage.getItem(SEL_KEY); } catch (e) { /* 隐私模式 */ }
    if (raw) {
      try {
        var obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.ids)) {
          selected = { ids: obj.ids, req: Array.isArray(obj.req) ? obj.req : [] };
          return selected;
        }
      } catch (e) { /* 存档坏了就重来 */ }
    }
    // 默认：所有页面都参与抽取，但没有一个算必填
    selected = { ids: window.Library.pages().map(function (p) { return p.id; }), req: [] };
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
  function requiredIds() { return unionOf(loadSelected().req); }

  function isRequired(indId) { return requiredIds().indexOf(indId) !== -1; }

  function renderPageChecks() {
    var box = $('#page-checks');
    if (!box) return;
    var pages = window.Library.pages();
    var sel = loadSelected();
    if (!pages.length) {
      box.innerHTML = '<p class="tiny muted">还没有页面。点右上角「指标与页面」新建一个。</p>';
      return;
    }
    box.innerHTML = pages.map(function (p) {
      var on = sel.ids.indexOf(p.id) !== -1;
      var req = sel.req.indexOf(p.id) !== -1;
      return '<div class="page-check' + (on ? ' on' : '') + '">' +
        '<label class="pc-main">' +
          '<input type="checkbox" class="pc-use" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + '>' +
          '<span class="pc-name">' + esc(p.name) + '</span>' +
          '<span class="pc-count">' + p.ids.length + '</span>' +
        '</label>' +
        '<label class="pc-req' + (on ? '' : ' off') + '" title="勾上以后，这一页没录到才会标红">' +
          '<input type="checkbox" class="pc-must" value="' + esc(p.id) + '"' +
            (req && on ? ' checked' : '') + (on ? '' : ' disabled') + '>必填' +
        '</label>' +
        '</div>';
    }).join('');
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
    return false;
  }

  /* ---------------- 跨页找回（M7） ----------------
   * 必填项在"该管它的那一页"没读到，但在同一位患者的别的报告里读到了。
   * 这种情况不能当"已识别"糊过去：数值可能是上一次住院的，时间点对不上。
   * 所以单独标成"跨页找回"，把来源写清楚，等人确认。只在同一位患者内找。 */
  var TYPE_PAGES = {
    '血常规': ['cbc'],
    '生化': ['bio', 'liver', 'renal', 'elec'], // 一份生化单上肝功能/肾功能/电解质都在
    '出凝血': ['coag'],
    '病程首页': ['course']
  };

  function pagesOfAsset(a) {
    if (!a) return [];
    return TYPE_PAGES[String(a.reportType || '').trim()] || [];
  }

  function homePagesOf(indId) {
    return window.Library.pages()
      .filter(function (p) { return (p.ids || []).indexOf(indId) >= 0; })
      .map(function (p) { return p.id; });
  }

  function inPlace(o, homePages) {
    if (!homePages.length) return true;   // 不属于任何页面，谈不上跑错页
    var a = S.assets.filter(function (x) { return x.id === o.assetId; })[0];
    var ps = pagesOfAsset(a);
    if (!ps.length) return true;          // 认不出这份报告是哪类，不做判断
    return ps.some(function (pid) { return homePages.indexOf(pid) >= 0; });
  }

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
    var picked = Object.keys(byAsset).map(function (k) { return byAsset[k]; })
      .filter(function (o) { return String(o.value || '').trim() !== ''; });

    // 没识别到：只有标了必填的才算质控问题，其余只是"这次没提供"
    if (!picked.length) {
      return { state: isRequired(indId) ? 'missing' : 'absent', obs: list[0] || null, list: list };
    }

    // 不同报告之间对不上，才算真冲突
    if (picked.length > 1) {
      var first = picked[0];
      var diff = picked.some(function (o) { return !sameValue(o.value, first.value, isNum); });
      if (diff) return { state: 'conflict', obs: first, list: picked };
    }

    var o = picked[0];
    if (o.method !== 'manual' && o.confidence != null && o.confidence < LOW_CONFIDENCE) {
      return { state: 'low', obs: o, list: picked };
    }

    // 值是从别的报告里找回来的（本页没读到）
    if (isRequired(indId)) {
      var home = homePagesOf(indId);
      var anyInPlace = picked.some(function (x) { return inPlace(x, home); });
      if (!anyInPlace) return { state: 'borrowed', obs: o, list: picked };
    }

    return { state: 'ok', obs: o, list: picked };
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
    }
  }

  /* ---------------- 渲染：报告缩略图 ---------------- */

  function renderAssets() {
    var p = current();
    var box = $('#asset-strip');
    var list = p ? assetsOf(p.id) : [];
    box.innerHTML = list.map(function (a) {
      var label = a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex;
      var st = a.status === 'done' ? '<span class="asset-state ok">已识别</span>'
        : a.status === 'running' ? '<span class="asset-state run">识别中</span>'
          : a.status === 'error' ? '<span class="asset-state err">失败</span>'
            : '<span class="asset-state">待识别</span>';
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
    var n = { missing: 0, low: 0, ok: 0, conflict: 0, absent: 0, borrowed: 0 };
    if (p) {
      ids.forEach(function (id) {
        var s = cellState(p.id, id).state;
        if (s === 'conflict') n.conflict++; else n[s]++;
      });
    }
    var red = n.missing + n.conflict;
    var note = n.borrowed
      ? '<div class="stat-note">另有 ' + n.borrowed + ' 项这份报告里没有，是从同一患者的其他报告里找回的，请核对时间点</div>'
      : '';
    $('#stats').innerHTML =
      '<div class="stat red"><b>' + red + '</b><span>必填缺失</span></div>' +
      '<div class="stat amber"><b>' + n.low + '</b><span>存疑</span></div>' +
      '<div class="stat green"><b>' + n.ok + '</b><span>已识别</span></div>' + note;
  }

  /* ---------------- 渲染：表格 ---------------- */

  function renderTable() {
    var body = $('#grid-body');
    var p = current();
    var ids = targetIds();

    if (!p) {
      body.innerHTML = '<tr><td colspan="5" class="empty-hint">先添加一位患者</td></tr>';
      return;
    }
    if (!assetsOf(p.id).length) {
      body.innerHTML = '<tr><td colspan="5" class="empty-hint">这位患者还没有报告，先在上面上传</td></tr>';
      return;
    }

    body.innerHTML = ids.map(function (id) {
      var ind = window.IndicatorLib.byId(id);
      var c = cellState(p.id, id);
      var value = c.obs && c.obs.value != null ? String(c.obs.value) : '';
      var isNum = (ind.type || 'num') === 'num';

      var srcCell = '';
      if (c.obs && c.obs.assetId) {
        var a = S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0];
        if (a) {
          var label = a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex;
          if (c.state === 'borrowed') label += ' · 跨页';
          srcCell = '<button class="src-link" data-src="' + a.id + '">' + esc(label) + '</button>';
        }
      }
      var badge = {
        ok: '<span class="badge ok">已识别</span>',
        low: '<span class="badge low">置信度低</span>',
        missing: '<span class="badge missing">必填缺失</span>',
        conflict: '<span class="badge conflict">两处不一致</span>',
        absent: '<span class="badge absent">未提供</span>',
        borrowed: '<span class="badge borrowed">跨页找回</span>'
      }[c.state] || '';

      return '<tr class="' + c.state + '" data-ind="' + id + '">' +
        '<td><div class="ind-name"><span class="ind-dot ' + c.state + '"></span>' +
          '<div><div>' + esc(ind.name) + '</div><div class="ind-code">' + esc(ind.id) + '</div></div></div></td>' +
        '<td><input class="val-input" data-ind="' + id + '" value="' + esc(value) + '" placeholder="未识别"></td>' +
        '<td>' + esc(isNum ? ind.unit : (ind.type === 'date' ? '日期' : '')) + '</td>' +
        '<td>' + esc(isNum ? ind.ref : '') + '</td>' +
        '<td>' + srcCell + ' ' + badge + '</td>' +
        '</tr>';
    }).join('');
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

  function buildPrompt(ids, pageText) {
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
      '{"report_type":"血常规|生化|免疫|出凝血|病程首页|其他","report_date":"YYYY-MM-DD 或 空字符串",',
      ' "items":[{"raw_name":"报告上的原文项目名","indicator":"标准代号或 null",',
      '           "value":"原文","unit":"单位原文","ref":"参考范围原文","confidence":0.0}]}',
      '',
      '硬性要求：',
      '1. 只输出 JSON，不要解释，不要 markdown 代码块。',
      '2. 只写图片上真实出现的内容。看不清、被裁掉、字迹模糊的，value 写 null、confidence 写 0.3 以下。',
      '   绝对不要根据常识补全，也不要猜。宁可漏，不可编。',
      '3. 数值保留原文写法，不要换算单位，不要四舍五入。',
      '4. indicator 只能从下面的候选里选。这一页没有的项目，不要出现在 items 里。',
      '5. 如果这一页根本不是报告（比如身份证、发票、空白页），items 返回空数组。',
      '6. 文本项（姓名、性别、诊断等）逐字照抄，不要改写、不要补全、不要翻译。',
      '7. 页眉或表头里印着姓名、性别、年龄、住院号，只要清晰可辨，也照抄下来（记在对应代号下），' +
      '不要因为它们"不像检验项目"就跳过。',
      '',
      '候选指标：',
      lines
    ];

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
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b === -1 || b <= a) throw new Error('模型没有返回 JSON');
    var obj = JSON.parse(t.slice(a, b + 1));
    if (!obj || typeof obj !== 'object') throw new Error('返回的 JSON 结构不对');
    return obj;
  }

  async function recognizeAsset(asset, ids) {
    asset.status = 'running';
    renderAssets();

    var res = await window.Model.vision(asset.dataUrl, buildPrompt(ids, asset.pageText));
    var data = parseJson(res.text);
    var items = Array.isArray(data.items) ? data.items : [];

    // 先清掉这份报告旧的识别结果，保证"一份报告只抽一次"
    S.observations = S.observations.filter(function (o) { return o.assetId !== asset.id; });

    var added = 0, unmatched = [];
    items.forEach(function (it) {
      if (!it) return;
      var hit = window.IndicatorLib.match(it.raw_name, it.indicator);
      if (!hit || ids.indexOf(hit.id) === -1) {
        if (it.raw_name) unmatched.push(it.raw_name);
        return;
      }
      var v = it.value == null ? '' : String(it.value).trim();
      S.observations.push({
        id: uid('obs'),
        patientId: asset.patientId,
        assetId: asset.id,
        rawName: it.raw_name || '',
        indicatorId: hit.id,
        method: hit.method,
        score: hit.score,
        value: v,
        unit: it.unit || '',
        ref: it.ref || '',
        date: data.report_date || '',
        confidence: typeof it.confidence === 'number' ? it.confidence : null
      });
      added++;
    });

    asset.status = 'done';
    asset.error = '';
    asset.reportType = data.report_type || '';
    asset.reportDate = data.report_date || '';
    asset.unmatched = unmatched;
    return { added: added, unmatched: unmatched, ms: res.ms, usage: res.usage };
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
    if (!todo.length) { toast('这位患者的报告都识别过了。要重来请先清空本次任务。'); return; }

    S.running = true;
    setRunning(true);
    var ids = targetIds();
    var done = 0, failed = 0;

    var queue = todo.slice();
    async function worker() {
      while (queue.length) {
        var a = queue.shift();
        try {
          // 模型偶发返回坏 JSON 或限流，重试一次通常就好了。
          // 演示现场不能因为一次抖动就让一页报告变成"失败"。
          try {
            await recognizeAsset(a, ids);
          } catch (e1) {
            if (e1 && e1.name === 'AbortError') throw e1;
            a.status = 'pending';
            await new Promise(function (r) { setTimeout(r, 900); });
            await recognizeAsset(a, ids);
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

    openModal(
      '<h3>' + esc(a.kind === 'pdf' ? '报告 ' + a.fileIndex + ' · 第 ' + a.pageNo + ' 页' : '报告 ' + a.fileIndex) + '</h3>' +
      '<p class="source-meta">' + esc(a.name) + '</p>' +
      '<img class="source-img" src="' + a.dataUrl + '" alt="">' +
      (rows ? '<div style="margin-top:12px">' + rows + '</div>' : '')
    );
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
          '<button class="btn tiny primary" data-act="' + (libTab === 'ind' ? 'ind-new' : 'page-new') + '">+ ' +
            (libTab === 'ind' ? '新建指标' : '新建页面') + '</button>' +
        '</div>' +
      '</div>';

    if (libTab === 'ind') {
      html += (libForm && libForm.kind === 'ind' ? indicatorForm() : '') +
        '<input id="ind-search" class="pick-search" placeholder="搜索代号、名称或同义词…">' +
        '<div class="pane-scroll">' +
          '<table class="mini-grid"><thead><tr>' +
            '<th>代号</th><th>名称</th><th>单位</th><th>参考范围</th><th>同义词</th><th></th>' +
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
      if (act === 'ind-new') { libForm = { kind: 'ind', mode: 'new' }; renderLibrary(); }
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
          selected = (selected || []).concat([np.id]);
          saveSelected();
        }
        libChangeDone('页面已保存');
        libForm = null;
        renderLibrary();
      }
      else if (act === 'page-del') {
        if (!confirm('删除这个页面？指标本身不会被删除。')) return;
        window.Library.removePage(id);
        selected = (selected || []).filter(function (x) { return x !== id; });
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

  function exportCsv() {
    var p = current();
    if (!p) { toast('没有可导出的内容', 'err'); return; }
    var ids = targetIds();
    var head = ['患者', '指标代号', '指标名称', '结果', '单位', '参考范围', '状态', '来源'];
    var stateName = { ok: '已识别', low: '置信度低', missing: '必填缺失', conflict: '两处不一致', absent: '未提供' };

    var rows = ids.map(function (id) {
      var ind = window.IndicatorLib.byId(id);
      var c = cellState(p.id, id);
      var src = '';
      if (c.obs && c.obs.assetId) {
        var a = S.assets.filter(function (x) { return x.id === c.obs.assetId; })[0];
        if (a) src = a.kind === 'pdf' ? '报告' + a.fileIndex + '-第' + a.pageNo + '页' : '报告' + a.fileIndex;
      }
      return [p.code, ind.id, ind.name, c.obs ? c.obs.value : '', ind.unit, ind.ref, stateName[c.state], src];
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
      selected = { ids: cur.ids.slice(), req: cur.req.slice() };

      if (cb.classList.contains('pc-must')) {
        var j = selected.req.indexOf(id);
        if (cb.checked && j === -1) selected.req.push(id);
        if (!cb.checked && j !== -1) selected.req.splice(j, 1);
      } else {
        var i = selected.ids.indexOf(id);
        if (cb.checked && i === -1) selected.ids.push(id);
        if (!cb.checked && i !== -1) selected.ids.splice(i, 1);
        // 不参与本次的页面，顺手把"必填"也撤掉，免得留下一颗哑弹
        if (!cb.checked) {
          var k = selected.req.indexOf(id);
          if (k !== -1) selected.req.splice(k, 1);
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
      var b = e.target.closest('[data-src]');
      if (b) openSource(b.getAttribute('data-src'));
    });

    $('#asset-strip').addEventListener('click', function (e) {
      var a = e.target.closest('[data-aid]');
      if (a) openSource(a.getAttribute('data-aid'));
    });

    $('#btn-run').addEventListener('click', runRecognize);
    $('#btn-export').addEventListener('click', exportCsv);
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
      if (e.target.closest('[data-act]') || e.target.closest('[data-tab]')) handleLibraryClick(e);
    });

    $('#btn-reset').addEventListener('click', function () {
      if (!confirm('清空本次任务的所有报告和识别结果？')) return;
      S.assets = [];
      S.observations = [];
      S.patients = [];
      S.currentId = null;
      window.Model.resetUsage();
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

  function init() {
    addPatient(true);
    bind();
    updatePill();
    renderAll();
    startHeartbeat();
    keepAwake();
    // 暴露给控制台，方便调试
    window.__S = S;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
