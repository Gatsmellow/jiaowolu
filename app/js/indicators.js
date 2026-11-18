/* 指标库与页面（可编辑、会保存）。
 *
 * 为什么是"页面"而不是"模板"：临床上看一份报告，看的是"这一页要录哪几项"，
 * 而不是"套用哪个模板"。一个页面 = 一组指标。
 *
 * 默认的页面结构按科室真实在用的登记表来（病程首页 / 血常规 / 出凝血 / 肝功能 /
 * 肾功能 / 电解质 / 综合生化），不是按检验科的开单习惯来。
 *
 * 三项刻意没有放进默认库：身份证号、联系电话、住址。它们是直接标识符，
 * 录进浏览器只会增加泄露面，对质控本身没有用处。需要的话自己加。
 *
 * 数据存在浏览器 localStorage 里，换电脑就没了——这是刻意的：
 * 这是科室自己维护的一份表，不该由我们托管。
 *
 * 同义词表是这个项目最值钱的东西之一：同一项检查在不同医院有不同叫法
 * （血红蛋白 / 血色素 / HGB / Hb），先把能对上的对上，对不上的才交给模型。
 */
(function (global) {
  'use strict';

  // v2：结构变了（指标多了 type，页面按真实登记表重排），旧档不再兼容
  var STORE_KEY = 'jiaowolu.library.v2';
  var OLD_KEY = 'jiaowolu.library.v1';

  function num(id, name, group, unit, ref, low, high, aliases) {
    return { id: id, name: name, group: group, type: 'num', unit: unit, ref: ref, low: low, high: high, aliases: aliases };
  }
  function txt(id, name, group, aliases) {
    return { id: id, name: name, group: group, type: 'text', unit: '', ref: '', low: null, high: null, aliases: aliases };
  }
  function dat(id, name, group, aliases) {
    return { id: id, name: name, group: group, type: 'date', unit: '', ref: '', low: null, high: null, aliases: aliases };
  }

  var DEFAULT_INDICATORS = [
    // ---- 病程首页：这一页没有数值，全是文本与日期 ----
    txt('NAME',      '姓名',       '病程首页', ['姓名', '患者姓名', '名字', '姓 名']),
    txt('SEX',       '性别',       '病程首页', ['性别', '性 别']),
    txt('ADMNO',     '住院号',     '病程首页', ['住院号', '住院号/门诊号', '病案号']),
    num('AGE',       '年龄',       '病程首页', '岁', '', null, null, ['年龄', '就诊年龄']),
    dat('VISITDATE', '就诊日期',   '病程首页', ['就诊日期', '入院日期']),
    txt('DIAG',      '诊断结果',   '病程首页', ['诊断', '诊断结果', '出院诊断', '入院诊断']),
    txt('ETHNIC',    '民族',       '病程首页', ['民族']),
    txt('HOSP',      '就诊医院',   '病程首页', ['就诊医院', '医院名称', '医疗机构']),

    // ---- 血常规 ----
    num('WBC',     '白细胞计数',   '血常规', '10^9/L',  '3.5–9.5',   3.5,  9.5,  ['白细胞', '白细胞计数', '白细胞总数', 'WBC', '白血球']),
    num('RBC',     '红细胞计数',   '血常规', '10^12/L', '4.3–5.8',   4.3,  5.8,  ['红细胞', '红细胞计数', 'RBC']),
    num('HGB',     '血红蛋白',     '血常规', 'g/L',     '130–175',   130,  175,  ['血红蛋白', '血色素', 'HGB', 'Hb', 'HB']),
    num('PLT',     '血小板计数',   '血常规', '10^9/L',  '125–350',   125,  350,  ['血小板', '血小板计数', 'PLT', 'BPC']),
    num('LYMPH_C', '淋巴细胞计数', '血常规', '10^9/L',  '1.1–3.2',   1.1,  3.2,  ['淋巴细胞计数', '淋巴细胞绝对值', 'LYMPH#', 'LYM#', '淋巴细胞数']),

    // ---- 出凝血 ----
    num('APTT',   '活化部分凝血活酶时间', '出凝血', 's',         '25–37',   25,  37,  ['APTT', '活化部分凝血活酶时间', '部分凝血活酶时间']),
    num('PT',     '凝血酶原时间',         '出凝血', 's',         '11–14',   11,  14,  ['PT', '凝血酶原时间', '凝血酶原时间PT']),
    num('TT',     '凝血酶时间',           '出凝血', 's',         '14–21',   14,  21,  ['TT', '凝血酶时间']),
    num('FIB',    '纤维蛋白原',           '出凝血', 'g/L',       '2.0–4.0', 2.0, 4.0, ['FIB', '纤维蛋白原', 'Fib']),
    num('FDP',    '纤维蛋白降解产物',     '出凝血', 'μg/mL',     '0–5',     0,   5,   ['FDP', '纤维蛋白降解产物', '纤维蛋白(原)降解产物']),
    num('DDIMER', 'D-二聚体',             '出凝血', 'mg/L FEU',  '0–0.5',   0,   0.5, ['D-二聚体', 'D_Dimmer', 'DDimer', 'D-Dimer', 'D二聚体']),

    // ---- 肝功能 ----
    num('ALT',   '丙氨酸氨基转移酶', '肝功能', 'U/L',     '9–50',     9,   50,   ['丙氨酸氨基转移酶', '谷丙转氨酶', 'ALT', 'GPT']),
    num('AST',   '天冬氨酸氨基转移酶', '肝功能', 'U/L',   '15–40',    15,  40,   ['天冬氨酸氨基转移酶', '谷草转氨酶', 'AST', 'GOT']),
    num('ALP',   '碱性磷酸酶',       '肝功能', 'U/L',     '35–100',   35,  100,  ['碱性磷酸酶', 'ALP', 'AKP', 'ALKP']),
    num('GGT',   'γ-谷氨酰转肽酶',   '肝功能', 'U/L',     '7–45',     7,   45,   ['γ-谷氨酰转肽酶', '谷氨酰转肽酶', 'GGT', 'γ-GT', 'r-GT']),
    num('LDH',   '乳酸脱氢酶',       '肝功能', 'U/L',     '120–250',  120, 250,  ['乳酸脱氢酶', 'LDH', 'LD']),
    num('TBIL',  '总胆红素',         '肝功能', 'μmol/L',  '3.4–20.5', 3.4, 20.5, ['总胆红素', 'TBIL', 'T-BIL', 'TBil']),
    num('DBIL',  '直接胆红素',       '肝功能', 'μmol/L',  '0–6.8',    0,   6.8,  ['直接胆红素', 'DBIL', 'D-BIL', '结合胆红素']),
    num('ALB',   '白蛋白',           '肝功能', 'g/L',     '40–55',    40,  55,   ['白蛋白', '血清白蛋白', 'ALB']),

    // ---- 肾功能 ----
    num('BUN',  '尿素氮', '肾功能', 'mmol/L', '3.1–8.0', 3.1, 8.0, ['尿素氮', 'BUN', '尿素']),
    num('CREA', '肌酐',   '肾功能', 'μmol/L', '57–97',   57,  97,  ['肌酐', '血肌酐', 'CREA', 'Cr', 'SCr', 'Scr']),
    num('UA',   '尿酸',   '肾功能', 'μmol/L', '208–428', 208, 428, ['尿酸', '血尿酸', 'UA', 'URIC']),

    // ---- 电解质 ----
    num('NA', '钠',   '电解质', 'mmol/L', '137–147',   137,  147,  ['钠', '血钠', 'Na', 'Na+']),
    num('K',  '钾',   '电解质', 'mmol/L', '3.5–5.3',   3.5,  5.3,  ['钾', '血钾', 'K', 'K+']),
    num('CL', '氯',   '电解质', 'mmol/L', '99–110',    99,   110,  ['氯', '血氯', 'Cl', 'Cl-']),
    num('CA', '钙',   '电解质', 'mmol/L', '2.11–2.52', 2.11, 2.52, ['钙', '血钙', 'Ca', 'Ca2+']),

    // ---- 血糖（综合生化里常见，单独成项） ----
    num('GLU', '葡萄糖', '生化', 'mmol/L', '3.9–6.1', 3.9, 6.1, ['葡萄糖', '血糖', '空腹血糖', 'GLU', 'Glu', 'FPG'])
  ];

  var LIVER = ['ALT', 'AST', 'ALP', 'GGT', 'LDH', 'TBIL', 'DBIL', 'ALB'];
  var RENAL = ['BUN', 'CREA', 'UA'];
  var ELEC = ['NA', 'K', 'CL', 'CA'];

  var DEFAULT_PAGES = [
    { id: 'course', name: '病程首页', ids: ['NAME', 'SEX', 'ADMNO', 'AGE', 'VISITDATE', 'DIAG', 'ETHNIC', 'HOSP'] },
    { id: 'cbc',    name: '血常规',   ids: ['WBC', 'RBC', 'HGB', 'PLT', 'LYMPH_C'] },
    { id: 'coag',   name: '出凝血',   ids: ['APTT', 'PT', 'TT', 'FIB', 'FDP', 'DDIMER'] },
    { id: 'liver',  name: '肝功能',   ids: LIVER },
    { id: 'renal',  name: '肾功能',   ids: RENAL },
    { id: 'elec',   name: '电解质',   ids: ELEC },
    // 综合生化 = 肝功 + 肾功 + 电解质（+ 血糖）合并成一页的报告，
    // 和上面三页是"填一个或填三个"的关系。指标是同一批，不会重复计费也不会重复计数。
    { id: 'bio',    name: '综合生化', ids: LIVER.concat(RENAL, ELEC, ['GLU']) }
  ];

  var state = { indicators: [], pages: [] };
  var BY_ID = {};
  var ALIAS_INDEX = null;
  var RENAMED = [];   // 指标改代号后要一起改的地方，交给调用方处理

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s\u3000]/g, '')
      .replace(/[（）()【】\[\]{}:：,，;；/、.+*'"`~!?！？\-–—]/g, '');
  }

  function rebuild() {
    BY_ID = {};
    ALIAS_INDEX = {};
    state.indicators.forEach(function (ind) {
      BY_ID[ind.id] = ind;
      var names = [ind.id, ind.name].concat(ind.aliases || []);
      names.forEach(function (n) {
        var k = normalize(n);
        if (k && !ALIAS_INDEX[k]) ALIAS_INDEX[k] = ind.id;
      });
    });
  }

  function load() {
    var seed = { indicators: clone(DEFAULT_INDICATORS), pages: clone(DEFAULT_PAGES) };
    var raw = null;
    try { raw = global.localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式 */ }
    if (!raw) {
      state = seed; rebuild();
      try { global.localStorage.removeItem(OLD_KEY); } catch (e) { /* ignore */ }
      return;
    }
    try {
      var got = JSON.parse(raw);
      if (!got || !Array.isArray(got.indicators) || !Array.isArray(got.pages)) throw new Error('结构不对');
      // 旧存档里的指标没有 type，补上，否则表格会把文本项当数值渲染
      got.indicators.forEach(function (i) { if (!i.type) i.type = 'num'; });
      state = { indicators: got.indicators, pages: got.pages };
    } catch (e) {
      // 存档坏了就退回种子，不要让一份坏数据把整个工作台打死
      state = seed;
    }
    rebuild();
  }

  function save() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 存不下就算了 */ }
  }

  function indicators() { return state.indicators.slice(); }
  function pages() { return state.pages.slice(); }
  function byId(id) { return BY_ID[id] || null; }
  function pageById(id) {
    return state.pages.filter(function (p) { return p.id === id; })[0] || null;
  }

  /* 把报告上的原文项目名对到标准指标。对不上返回 null，绝不猜。 */
  function match(rawName, hint) {
    if (hint && BY_ID[hint]) return { id: hint, method: 'text-model', score: 1 };
    var n = normalize(rawName);
    if (!n) return null;
    if (ALIAS_INDEX[n]) return { id: ALIAS_INDEX[n], method: 'exact-alias', score: 1 };

    // 包含匹配只在别名够长时做：两三个字母的代号（PT、TT、K）当子串用会串项，
    // 比如 "APTT" 里就含着一个 "PT"。
    var best = null;
    Object.keys(ALIAS_INDEX).forEach(function (k) {
      if (k.length < 3) return;
      if (n.indexOf(k) !== -1 || k.indexOf(n) !== -1) {
        var score = Math.min(k.length, n.length) / Math.max(k.length, n.length);
        if (!best || score > best.score) best = { id: ALIAS_INDEX[k], method: 'contains', score: score };
      }
    });
    return best && best.score >= 0.45 ? best : null;
  }

  /* ---------------- 指标增删改 ---------------- */

  function parseRange(ref) {
    var m = String(ref || '').match(/(-?\d+(?:\.\d+)?)\s*[–\-~—至]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return { low: null, high: null };
    return { low: parseFloat(m[1]), high: parseFloat(m[2]) };
  }

  function cleanIndicator(raw) {
    var id = String(raw.id || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    var name = String(raw.name || '').trim();
    if (!id) throw new Error('代号不能为空（只能用字母、数字、下划线）');
    if (!name) throw new Error('名称不能为空');

    var type = String(raw.type || 'num');
    if (['num', 'text', 'date'].indexOf(type) === -1) type = 'num';

    var aliases = String(raw.aliases || '')
      .split(/[,，、;；\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    // 名称和代号永远算同义词，省得用户自己再输一遍
    [id, name].forEach(function (n) {
      if (aliases.indexOf(n) === -1) aliases.unshift(n);
    });

    if (type !== 'num') {
      return { id: id, name: name, group: String(raw.group || '自定义').trim() || '自定义', type: type, unit: '', ref: '', low: null, high: null, aliases: aliases };
    }
    var r = parseRange(raw.ref);
    return {
      id: id,
      name: name,
      group: String(raw.group || '自定义').trim() || '自定义',
      type: 'num',
      unit: String(raw.unit || '').trim(),
      ref: String(raw.ref || '').trim(),
      low: r.low,
      high: r.high,
      aliases: aliases
    };
  }

  function addIndicator(raw) {
    var ind = cleanIndicator(raw);
    if (BY_ID[ind.id]) throw new Error('代号 ' + ind.id + ' 已经有了，换个代号');
    state.indicators.push(ind);
    rebuild(); save();
    return ind;
  }

  function updateIndicator(oldId, raw) {
    var ind = cleanIndicator(raw);
    var i = state.indicators.map(function (x) { return x.id; }).indexOf(oldId);
    if (i === -1) throw new Error('这个指标已经不在了');
    if (ind.id !== oldId && BY_ID[ind.id]) throw new Error('代号 ' + ind.id + ' 已经被占用');
    state.indicators[i] = ind;
    if (ind.id !== oldId) {
      // 页面引用和已有结果一起改名，否则旧数据会变成孤儿
      state.pages.forEach(function (p) {
        p.ids = p.ids.map(function (id) { return id === oldId ? ind.id : id; });
      });
      RENAMED.push([oldId, ind.id]);
    }
    rebuild(); save();
    return ind;
  }

  function removeIndicator(id) {
    state.indicators = state.indicators.filter(function (x) { return x.id !== id; });
    state.pages.forEach(function (p) {
      p.ids = p.ids.filter(function (x) { return x !== id; });
    });
    rebuild(); save();
  }

  /* ---------------- 页面增删改 ---------------- */

  function cleanPage(raw) {
    var name = String(raw.name || '').trim();
    if (!name) throw new Error('页面名称不能为空');
    var ids = (raw.ids || []).filter(function (id) { return !!BY_ID[id]; });
    if (!ids.length) throw new Error('至少选一个指标');
    var id = String(raw.id || '').trim() || 'p' + Date.now().toString(36);
    return { id: id, name: name, ids: ids };
  }

  function addPage(raw) {
    var p = cleanPage(raw);
    if (pageById(p.id)) p.id = p.id + '_' + Date.now().toString(36);
    state.pages.push(p);
    save();
    return p;
  }

  function updatePage(id, raw) {
    var i = state.pages.map(function (x) { return x.id; }).indexOf(id);
    if (i === -1) throw new Error('这个页面已经不在了');
    var p = cleanPage({ id: id, name: raw.name, ids: raw.ids });
    state.pages[i] = p;
    save();
    return p;
  }

  function removePage(id) {
    state.pages = state.pages.filter(function (p) { return p.id !== id; });
    save();
  }

  function resetAll() {
    state = { indicators: clone(DEFAULT_INDICATORS), pages: clone(DEFAULT_PAGES) };
    rebuild(); save();
  }

  function takeRenames() {
    var r = RENAMED.slice();
    RENAMED.length = 0;
    return r;
  }

  load();

  global.Library = {
    indicators: indicators,
    pages: pages,
    byId: byId,
    pageById: pageById,
    match: match,
    normalize: normalize,
    addIndicator: addIndicator,
    updateIndicator: updateIndicator,
    removeIndicator: removeIndicator,
    addPage: addPage,
    updatePage: updatePage,
    removePage: removePage,
    resetAll: resetAll,
    takeRenames: takeRenames,
    parseRange: parseRange
  };

  // 兼容旧引用
  global.IndicatorLib = { byId: byId, match: match, normalize: normalize };
})(window);
