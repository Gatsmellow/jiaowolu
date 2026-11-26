/**
 * 对照实验：视觉直读 vs OCR + 文本抽取。
 *
 * 两条臂用**同一个提示词、同一个模型、同一套候选指标**，唯一的差别是输入：
 *   V 臂：图片直接给 deepseek-flash（现在线上就是这么做的）
 *   O 臂：先调 /v1/tools/ocr 拿文本，再把文本给 deepseek-flash
 *
 * 打分只比"单据上真实印着的那些项目"：值对不对、单位对不对、有没有漏、有没有编。
 * 用法：node tools/ocr-compare.mjs [--refresh]
 *       --refresh 重新调 OCR（会再花一次钱），默认读 tmp/ocr-cache.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const KEY = readFileSync(join(ROOT, 'secrets', 'ark_api.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const OCR_PRICE_PER_PAGE = 0.225 / 1000;          // 美元，官方 OCR 计费
const REFRESH = process.argv.includes('--refresh');
const CACHE = join(ROOT, 'tmp', 'ocr-cache.json');
const DIR = join(ROOT, 'app', 'test', 'samples', 'demo');

// 每张单据上真实印着的项目（来自 tools/make_demo_set.py 的生成参数）
const CASES = [
  {
    file: 'A-01-course.jpg', doc: '病案首页',
    candidates: 'NAME=姓名, SEX=性别, ADMNO=住院号, AGE=年龄, VISITDATE=就诊日期, DIAGTYPE=诊断分型, ETHNIC=民族, HUKOU=户籍, HOSP=就诊医院, WBC=白细胞计数, HGB=血红蛋白',
    truth: { NAME: '赵明远', SEX: '男', ADMNO: '9000024680', AGE: '61', VISITDATE: '2026-11-05', DIAGTYPE: '弥漫大B细胞淋巴瘤', ETHNIC: '汉族', HOSP: '上海市某三甲医院' }
  },
  {
    file: 'A-02-cbc-20261105.jpg', doc: '血常规',
    candidates: 'WBC=白细胞计数, RBC=红细胞计数, HGB=血红蛋白, PLT=血小板计数, NEUT_C=中性粒细胞计数, LYMPH_C=淋巴细胞计数, MONO_C=单核细胞计数, HCT=红细胞压积, MCV=红细胞平均体积, MCH=平均血红蛋白量, ALT=丙氨酸氨基转移酶',
    truth: { WBC: '6.42', RBC: '4.71', PLT: '214', NEUT_C: '4.05', LYMPH_C: '1.73', MONO_C: '0.41', HCT: '42.8', MCV: '90.9', MCH: '30.7' }
  },
  {
    file: 'A-03-bio-20261105.jpg', doc: '生化',
    candidates: 'ALT=丙氨酸氨基转移酶, AST=天门冬氨酸氨基转移酶, ALB=白蛋白, TBIL=总胆红素, CREA=肌酐, BUN=尿素, K=钾, NA=钠, CL=氯, GLU=葡萄糖, UA=尿酸',
    truth: { ALT: '38', AST: '29', ALB: '43.6', TBIL: '13.8', CREA: '81', BUN: '5.2', K: '4.1', NA: '141', CL: '103', GLU: '5.4' }
  },
  {
    file: 'A-04-cbc-20261120.jpg', doc: '血常规',
    candidates: 'WBC=白细胞计数, RBC=红细胞计数, HGB=血红蛋白, PLT=血小板计数, NEUT_C=中性粒细胞计数, LYMPH_C=淋巴细胞计数, MONO_C=单核细胞计数, HCT=红细胞压积, MCV=红细胞平均体积, MCH=平均血红蛋白量',
    truth: { WBC: '9.87', RBC: '4.52', HGB: '104', PLT: '198', NEUT_C: '7.42', LYMPH_C: '1.52', MONO_C: '0.62', HCT: '40.1', MCV: '88.7', MCH: '23.0' }
  },
  {
    file: 'A-05-cbc-20261120b.jpg', doc: '血常规',
    candidates: 'WBC=白细胞计数, RBC=红细胞计数, HGB=血红蛋白, PLT=血小板计数, NEUT_C=中性粒细胞计数, LYMPH_C=淋巴细胞计数, MONO_C=单核细胞计数, HCT=红细胞压积, MCV=红细胞平均体积, MCH=平均血红蛋白量',
    truth: { WBC: '6.15', RBC: '4.52', HGB: '104', PLT: '198', NEUT_C: '7.42', LYMPH_C: '1.52', MONO_C: '0.62', HCT: '40.1', MCV: '88.7', MCH: '23.0' }
  },
  {
    file: 'A-06-discharge.jpg', doc: '出院小结',
    candidates: 'WBC=白细胞计数, HGB=血红蛋白, PLT=血小板计数, ALT=丙氨酸氨基转移酶, CREA=肌酐, NAME=姓名',
    truth: { WBC: '9.87', HGB: '104', PLT: '198', ALT: '41', CREA: '88' }
  },
  {
    file: 'B-01-course.jpg', doc: '病案首页',
    candidates: 'NAME=姓名, SEX=性别, ADMNO=住院号, AGE=年龄, VISITDATE=就诊日期, DIAGTYPE=诊断分型, ETHNIC=民族, HOSP=就诊医院',
    truth: { NAME: '孙禾', SEX: '女', ADMNO: '9000031572', AGE: '47', DIAGTYPE: '滤泡性淋巴瘤' }
  },
  {
    file: 'B-02-cbc-20261118.jpg', doc: '血常规',
    candidates: 'WBC=白细胞计数, RBC=红细胞计数, HGB=血红蛋白, PLT=血小板计数, NEUT_C=中性粒细胞计数, LYMPH_C=淋巴细胞计数, MONO_C=单核细胞计数, HCT=红细胞压积, MCV=红细胞平均体积, MCH=平均血红蛋白量',
    truth: { WBC: '5.31', RBC: '3.93', HGB: '118', PLT: '137', NEUT_C: '4.20', LYMPH_C: '0.68', MONO_C: '0.25', HCT: '36.5', MCV: '93.0', MCH: '30.0' }
  }
];

const norm = (v) => String(v == null ? '' : v)
  .replace(/[＊*]/g, '')
  .replace(/[\s,，]/g, '')
  .replace(/^\+/, '')
  .replace(/岁$/, '')
  .toLowerCase();

const PROMPT = (doc, candidates) => [
  '你是病历/检验单据的结构化抽取器。只输出 JSON，不要解释。',
  '这一页的文书类型是【' + doc + '】。',
  '候选指标（代号=名称）：' + candidates,
  '只抽这一页里真实印着的项目：raw_name 照抄原来的项目名，value 照抄数值或定性结果，unit 照抄单位，',
  'indicator 填候选里的代号；看不清或没有的项目不要输出，不要按常识补全。',
  '正文叙述段落里如果写着「项目名 + 数值 + 单位」，也算这一页的内容，raw_name 照抄原话。',
  '输出：{"items":[{"raw_name":"","value":"","unit":"","indicator":"","confidence":0.0}]}'
].join('\n');

async function ocr(file) {
  const buf = readFileSync(join(DIR, file));
  const form = new FormData();
  form.append('purpose', 'rich_layout_recognition');
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), file);
  const t0 = Date.now();
  const res = await fetch(BASE + '/v1/tools/ocr', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY },
    body: form
  });
  const text = await res.text();
  if (!res.ok) throw new Error('OCR ' + res.status + ' ' + text.slice(0, 200));
  const json = JSON.parse(text);
  if (json.error) throw new Error('OCR 失败：' + json.error.message);
  return {
    ms: Date.now() - t0,
    pageCount: json.page_count || (json.pages || []).length,
    text: (json.pages || []).map((p) => p.text).join('\n'),
    usage: json.usage || null
  };
}

async function extract(content, doc, candidates) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }]
    })
  });
  const json = await res.json();
  if (json.error) throw new Error('chat 失败：' + JSON.stringify(json.error).slice(0, 200));
  const body = json.choices[0].message.content || '';
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  let items = [];
  if (start >= 0 && end > start) {
    try { items = (JSON.parse(body.slice(start, end + 1)).items) || []; } catch { items = []; }
  }
  return { ms: Date.now() - t0, items, usage: json.usage || null };
}

function score(items, truth) {
  const got = new Map();
  items.forEach((it) => {
    const id = String(it.indicator || '').trim();
    if (!id) return;
    if (!got.has(id)) got.set(id, it);
  });
  // 值里混进单位（9.87×10^9/L）时，按"第一个数字"比；没有数字再按字符串比。
  const num = (v) => {
    const m = String(v == null ? '' : v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  let ok = 0, wrong = 0, missed = 0;
  const detail = [];
  Object.keys(truth).forEach((id) => {
    const want = truth[id];
    const it = got.get(id);
    if (!it) { missed++; detail.push(id + ' 漏'); return; }
    const a = num(want), b = num(it.value);
    if (a !== null && b !== null && a === b) { ok++; return; }
    if (a === null && norm(it.value) === norm(want)) { ok++; return; }
    wrong++;
    detail.push(id + ' 错(要 ' + want + ' 得 ' + String(it.value) + ')');
  });
  const truthNums = new Set(Object.keys(truth).map((k) => num(truth[k])).filter((v) => v !== null));
  const fabricated = items.filter((it) => {
    const v = num(it.value);
    return v !== null && !truthNums.has(v);
  }).length;
  return { ok, wrong, missed, fabricated, detail, total: Object.keys(truth).length };
}

function cleanOcr(raw) {
  // OCR 原始输出带 <｜ref｜>…<｜box｜>[[x1,y1,x2,y2]]<｜/box｜> 这类版面标记，
  // 而且中文常被拆成一字一行。这里去掉标记，再按"两侧都是汉字就拼回去"的规则合并。
  let text = String(raw || '')
    .replace(/<｜box｜>\[\[[^\]]*\]\]<｜\/box｜>/g, '')
    .replace(/<｜[^｜]*｜>/g, '')
    .replace(/\r/g, '');
  const isCjk = (ch) => /[\u4e00-\u9fa5]/.test(ch || '');
  const out = [];
  text.split('\n').map((s) => s.trim()).filter(Boolean).forEach((line) => {
    const prev = out.length ? out[out.length - 1] : '';
    if (prev && isCjk(prev.slice(-1)) && isCjk(line[0])) {
      out[out.length - 1] = prev + line;
    } else {
      out.push(line);
    }
  });
  return out.join('\n');
}

function fmt(n) { return String(n).padStart(3); }

async function main() {
  let cache = {};
  if (!REFRESH && existsSync(CACHE)) {
    cache = JSON.parse(readFileSync(CACHE, 'utf8'));
  } else {
    mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  }

  const rows = [];
  let visionTokens = 0, ocrTokens = 0, ocrPages = 0;

  for (const c of CASES) {
    const path = join(DIR, c.file);
    const b64 = readFileSync(path).toString('base64');
    const prompt = PROMPT(c.doc, c.candidates);

    // V 臂：图片直读
    const v = await extract([
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
    ], c.doc, c.candidates);
    visionTokens += (v.usage?.total_tokens || 0);
    const sv = score(v.items, c.truth);

    // O 臂：OCR → 文本抽取
    let ocrRes = cache[c.file];
    if (!ocrRes) {
      ocrRes = await ocr(c.file);
      cache[c.file] = ocrRes;
      writeFileSync(CACHE, JSON.stringify(cache, null, 2));
    }
    ocrPages += ocrRes.pageCount || 1;
    const ocrText = cleanOcr(ocrRes.text);
    const o = await extract(prompt + '\n\n【OCR 文本】\n' + ocrText.slice(0, 12000), c.doc, c.candidates);
    ocrTokens += (o.usage?.total_tokens || 0);
    const so = score(o.items, c.truth);

    rows.push({ file: c.file, doc: c.doc, n: sv.total, sv, so, vms: v.ms, oms: ocrRes.ms + o.ms, ocrChars: ocrText.length });
    console.log(`  ${c.file.padEnd(26)} 应识别 ${sv.total} 项  V臂 对${fmt(sv.ok)}错${fmt(sv.wrong)}漏${fmt(sv.missed)}编${fmt(sv.fabricated)}  O臂 对${fmt(so.ok)}错${fmt(so.wrong)}漏${fmt(so.missed)}编${fmt(so.fabricated)}  ${v.ms}ms / ${ocrRes.ms + o.ms}ms`);
  }

  const sum = (k, arm) => rows.reduce((n, r) => n + (arm === 'v' ? r.sv : r.so)[k], 0);
  const total = rows.reduce((n, r) => n + r.n, 0);
  console.log('\n应识别合计：' + total + ' 项');
  console.log('V 臂（图片直读）  对 ' + sum('ok', 'v') + ' / 错 ' + sum('wrong', 'v') + ' / 漏 ' + sum('missed', 'v') + ' / 编 ' + sum('fabricated', 'v'));
  console.log('O 臂（OCR+文本） 对 ' + sum('ok', 'o') + ' / 错 ' + sum('wrong', 'o') + ' / 漏 ' + sum('missed', 'o') + ' / 编 ' + sum('fabricated', 'o'));
  console.log('\n准确率：V ' + (100 * sum('ok', 'v') / total).toFixed(1) + '%  O ' + (100 * sum('ok', 'o') / total).toFixed(1) + '%');
  console.log('token：V ' + visionTokens + '  O ' + ocrTokens + '（OCR 本身按页计费，' + ocrPages + ' 页 ≈ $' + (ocrPages * OCR_PRICE_PER_PAGE).toFixed(5) + '）');
  const bad = rows.filter((r) => r.so.detail.length || r.sv.detail.length);
  if (bad.length) {
    console.log('\n逐项差异：');
    bad.forEach((r) => {
      if (r.sv.detail.length) console.log('  V ' + r.file + '：' + r.sv.detail.join('；'));
      if (r.so.detail.length) console.log('  O ' + r.file + '：' + r.so.detail.join('；'));
    });
  }
  writeFileSync(join(ROOT, 'tmp', 'ocr-compare.json'), JSON.stringify({ rows, visionTokens, ocrTokens, ocrPages }, null, 2));
  console.log('\n明细已写入 tmp/ocr-compare.json');
}

main().catch((e) => { console.error('出错：', e.message); process.exit(1); });
