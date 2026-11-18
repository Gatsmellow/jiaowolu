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

  // v3：指标与页面扩到 90 项 / 15 页；从 v2 升级时把新默认项并进去，不丢用户自己加的
  var STORE_KEY = 'jiaowolu.library.v3';
  var PREV_KEY = 'jiaowolu.library.v2';
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
    num('NA', '钠',   '电解质', 'mmol/L', '137–147',   137,  147,  ['钠', '血钠', '钠离子', 'Na', 'Na+']),
    num('K',  '钾',   '电解质', 'mmol/L', '3.5–5.3',   3.5,  5.3,  ['钾', '血钾', '钾离子', 'K', 'K+']),
    num('CL', '氯',   '电解质', 'mmol/L', '99–110',    99,   110,  ['氯', '血氯', '氯离子', 'Cl', 'Cl-']),
    num('CA', '钙',   '电解质', 'mmol/L', '2.11–2.52', 2.11, 2.52, ['钙', '血钙', '钙离子', 'Ca', 'Ca2+']),

    // ---- 血糖（综合生化里常见，单独成项） ----
    num('GLU', '葡萄糖', '生化', 'mmol/L', '3.9–6.1', 3.9, 6.1, ['葡萄糖', '血糖', '空腹血糖', 'GLU', 'Glu', 'FPG']),

    /* ---- 以下是第二批：按真实报告常见的成套项目补的 ----
       原则：只收"一张报告上会成组出现"的项目。孤立的、病种太专的（如基因测序、
       病理分型）不往里塞——那些更适合现场用「新建指标」按需加。 */

    // 血常规五分类里最常被登记的四项 + 红细胞指数
    num('NEUT_C', '中性粒细胞计数', '血常规', '10^9/L', '1.8–6.3', 1.8, 6.3, ['中性粒细胞计数', '中性粒细胞绝对值', 'NEUT#', 'NEUT', '中性粒细胞']),
    num('MONO_C', '单核细胞计数', '血常规', '10^9/L', '0.1–0.6', 0.1, 0.6, ['单核细胞计数', '单核细胞绝对值', 'MONO#', 'MONO', '单核细胞']),
    num('HCT', '红细胞压积', '血常规', '%', '40–50', 40, 50, ['红细胞压积', '红细胞比容', '红细胞比积', 'HCT', 'Hct']),
    num('MCV', '平均红细胞体积', '血常规', 'fL', '82–100', 82, 100, ['平均红细胞体积', 'MCV']),
    num('MCH', '平均血红蛋白量', '血常规', 'pg', '27–34', 27, 34, ['平均血红蛋白量', '平均血红蛋白含量', 'MCH']),

    // 出凝血补充
    num('INR', '国际标准化比值', '出凝血', '', '0.8–1.2', 0.8, 1.2, ['国际标准化比值', 'INR']),

    // 肝功能补充
    num('TP', '总蛋白', '肝功能', 'g/L', '65–85', 65, 85, ['总蛋白', '血清总蛋白', 'TP']),
    num('GLB', '球蛋白', '肝功能', 'g/L', '20–40', 20, 40, ['球蛋白', 'GLB']),
    num('IBIL', '间接胆红素', '肝功能', 'μmol/L', '1.7–13.7', 1.7, 13.7, ['间接胆红素', '非结合胆红素', 'IBIL', 'I-BIL']),

    // 肾功能补充
    num('CYSC', '胱抑素C', '肾功能', 'mg/L', '0.51–1.09', 0.51, 1.09, ['胱抑素C', '半胱氨酸蛋白酶抑制剂C', 'CysC', 'CYSC']),
    num('B2MG', 'β2-微球蛋白', '肾功能', 'mg/L', '1.0–3.0', 1.0, 3.0, ['β2-微球蛋白', 'β2微球蛋白', 'B2MG', 'β2-MG']),

    // 电解质补充
    num('P', '磷', '电解质', 'mmol/L', '0.85–1.51', 0.85, 1.51, ['磷', '血磷', '无机磷', 'P', 'PHOS']),
    num('MG', '镁', '电解质', 'mmol/L', '0.75–1.02', 0.75, 1.02, ['镁', '血镁', '镁离子', 'MG', 'Mg']),

    // 心肌酶
    num('CK', '肌酸激酶', '心肌酶', 'U/L', '40–200', 40, 200, ['肌酸激酶', 'CK', 'CPK']),
    num('CKMB', '肌酸激酶同工酶', '心肌酶', 'U/L', '0–25', 0, 25, ['肌酸激酶同工酶', 'CK-MB', 'CKMB', 'MB']),
    num('HBDH', 'α-羟丁酸脱氢酶', '心肌酶', 'U/L', '72–182', 72, 182, ['α-羟丁酸脱氢酶', '羟丁酸脱氢酶', 'HBDH', 'α-HBDH']),
    num('CTNI', '肌钙蛋白I', '心肌酶', 'ng/mL', '0–0.04', 0, 0.04, ['肌钙蛋白I', '肌钙蛋白', 'cTnI', 'TNI']),

    // 血脂
    num('TC', '总胆固醇', '血脂', 'mmol/L', '2.8–5.18', 2.8, 5.18, ['总胆固醇', '胆固醇', 'TC', 'CHOL']),
    num('TG', '甘油三酯', '血脂', 'mmol/L', '0.56–1.70', 0.56, 1.70, ['甘油三酯', '三酰甘油', 'TG']),
    num('HDLC', '高密度脂蛋白胆固醇', '血脂', 'mmol/L', '1.04–1.55', 1.04, 1.55, ['高密度脂蛋白胆固醇', '高密度脂蛋白', 'HDL-C', 'HDLC']),
    num('LDLC', '低密度脂蛋白胆固醇', '血脂', 'mmol/L', '1.5–3.37', 1.5, 3.37, ['低密度脂蛋白胆固醇', '低密度脂蛋白', 'LDL-C', 'LDLC']),

    // 甲功
    num('TSH', '促甲状腺激素', '甲功', 'mIU/L', '0.27–4.2', 0.27, 4.2, ['促甲状腺激素', 'TSH']),
    num('FT3', '游离三碘甲状腺原氨酸', '甲功', 'pmol/L', '3.1–6.8', 3.1, 6.8, ['游离三碘甲状腺原氨酸', '游离T3', 'FT3']),
    num('FT4', '游离甲状腺素', '甲功', 'pmol/L', '12–22', 12, 22, ['游离甲状腺素', '游离T4', 'FT4']),
    num('TT3', '总三碘甲状腺原氨酸', '甲功', 'nmol/L', '1.3–3.1', 1.3, 3.1, ['总三碘甲状腺原氨酸', '总T3', 'TT3']),
    num('TT4', '总甲状腺素', '甲功', 'nmol/L', '66–181', 66, 181, ['总甲状腺素', '总T4', 'TT4']),

    // 肿瘤标志物
    num('CEA', '癌胚抗原', '肿瘤标志物', 'ng/mL', '0–5', 0, 5, ['癌胚抗原', 'CEA']),
    num('AFP', '甲胎蛋白', '肿瘤标志物', 'ng/mL', '0–7', 0, 7, ['甲胎蛋白', 'AFP']),
    num('CA125', '糖类抗原125', '肿瘤标志物', 'U/mL', '0–35', 0, 35, ['糖类抗原125', 'CA125', 'CA-125']),
    num('CA199', '糖类抗原19-9', '肿瘤标志物', 'U/mL', '0–27', 0, 27, ['糖类抗原199', '糖类抗原19-9', 'CA199', 'CA19-9']),
    num('CA153', '糖类抗原15-3', '肿瘤标志物', 'U/mL', '0–25', 0, 25, ['糖类抗原153', '糖类抗原15-3', 'CA153', 'CA15-3']),
    num('SF', '铁蛋白', '肿瘤标志物', 'ng/mL', '30–400', 30, 400, ['铁蛋白', '血清铁蛋白', 'SF', 'FERR']),

    // 免疫球蛋白与补体
    num('IGG', '免疫球蛋白G', '免疫球蛋白', 'g/L', '7.0–16.0', 7, 16, ['免疫球蛋白G', 'IgG', 'IGG']),
    num('IGA', '免疫球蛋白A', '免疫球蛋白', 'g/L', '0.7–4.0', 0.7, 4.0, ['免疫球蛋白A', 'IgA', 'IGA']),
    num('IGM', '免疫球蛋白M', '免疫球蛋白', 'g/L', '0.4–2.3', 0.4, 2.3, ['免疫球蛋白M', 'IgM', 'IGM']),
    num('IGE', '免疫球蛋白E', '免疫球蛋白', 'IU/mL', '0–100', 0, 100, ['免疫球蛋白E', 'IgE', 'IGE']),
    num('C3', '补体C3', '免疫球蛋白', 'g/L', '0.9–1.8', 0.9, 1.8, ['补体C3', 'C3']),
    num('C4', '补体C4', '免疫球蛋白', 'g/L', '0.1–0.4', 0.1, 0.4, ['补体C4', 'C4']),

    // 淋巴细胞亚群（绝对值）
    num('CD3', 'T淋巴细胞', '淋巴细胞亚群', '10^9/L', '0.96–2.86', 0.96, 2.86, ['T淋巴细胞', 'CD3+', 'CD3']),
    num('CD4', '辅助T淋巴细胞', '淋巴细胞亚群', '10^9/L', '0.45–1.44', 0.45, 1.44, ['辅助T淋巴细胞', 'CD4+', 'CD4']),
    num('CD8', '抑制T淋巴细胞', '淋巴细胞亚群', '10^9/L', '0.32–1.25', 0.32, 1.25, ['抑制T淋巴细胞', 'CD8+', 'CD8']),
    num('CD4CD8', 'CD4/CD8比值', '淋巴细胞亚群', '', '0.70–2.00', 0.7, 2.0, ['CD4/CD8', 'CD4CD8', 'CD4与CD8比值']),
    num('CD19', 'B淋巴细胞', '淋巴细胞亚群', '10^9/L', '0.09–0.56', 0.09, 0.56, ['B淋巴细胞', 'CD19+', 'CD19']),
    num('NK', '自然杀伤细胞', '淋巴细胞亚群', '10^9/L', '0.15–1.10', 0.15, 1.10, ['自然杀伤细胞', 'NK细胞', 'NK']),

    // 感染筛查（定性，只看阳性/阴性，不判断临床意义）
    txt('HBSAG', '乙肝表面抗原', '感染筛查', ['乙肝表面抗原', 'HBsAg', '表面抗原']),
    txt('HBSAB', '乙肝表面抗体', '感染筛查', ['乙肝表面抗体', 'HBsAb', '表面抗体']),
    txt('HBEAG', '乙肝e抗原', '感染筛查', ['乙肝e抗原', 'HBeAg']),
    txt('HBEAB', '乙肝e抗体', '感染筛查', ['乙肝e抗体', 'HBeAb']),
    txt('HBCAB', '乙肝核心抗体', '感染筛查', ['乙肝核心抗体', 'HBcAb', '核心抗体']),
    txt('HCVAB', '丙肝抗体', '感染筛查', ['丙肝抗体', '丙型肝炎抗体', '抗-HCV', 'HCVAb']),
    txt('TRUST', '梅毒螺旋体抗体', '感染筛查', ['梅毒螺旋体抗体', '梅毒抗体', 'TRUST', 'TPPA']),
    txt('HIVAB', 'HIV抗体', '感染筛查', ['HIV抗体', '艾滋病抗体', '抗-HIV', 'HIVAb']),

    // 铁代谢
    num('FE', '血清铁', '铁代谢', 'μmol/L', '9–30', 9, 30, ['血清铁', '铁', 'FE', 'SI']),
    num('TIBC', '总铁结合力', '铁代谢', 'μmol/L', '45–75', 45, 75, ['总铁结合力', 'TIBC']),
    num('TSAT', '转铁蛋白饱和度', '铁代谢', '%', '20–50', 20, 50, ['转铁蛋白饱和度', 'TSAT', '铁饱和度'])
  ];

  var LIVER = ['ALT', 'AST', 'ALP', 'GGT', 'LDH', 'TBIL', 'DBIL', 'IBIL', 'ALB', 'TP', 'GLB'];
  var RENAL = ['BUN', 'CREA', 'UA', 'CYSC', 'B2MG'];
  var ELEC = ['NA', 'K', 'CL', 'CA', 'P', 'MG'];

  /* on:false 的页面默认不勾选——库可以大，但默认打开的表不该有上百行。
     需要哪一页，在左侧勾上就行。 */
  var DEFAULT_PAGES = [
    { id: 'course', name: '病程首页', ids: ['NAME', 'SEX', 'ADMNO', 'AGE', 'VISITDATE', 'DIAG', 'ETHNIC', 'HOSP'] },
    { id: 'cbc',    name: '血常规',   ids: ['WBC', 'RBC', 'HGB', 'PLT', 'LYMPH_C', 'NEUT_C', 'MONO_C', 'HCT', 'MCV', 'MCH'] },
    { id: 'coag',   name: '出凝血',   ids: ['APTT', 'PT', 'TT', 'FIB', 'FDP', 'DDIMER', 'INR'] },
    { id: 'liver',  name: '肝功能',   ids: LIVER },
    { id: 'renal',  name: '肾功能',   ids: RENAL },
    { id: 'elec',   name: '电解质',   ids: ELEC },
    // 综合生化 = 肝功 + 肾功 + 电解质（+ 血糖）合并成一页的报告，
    // 和上面三页是"填一个或填三个"的关系。指标是同一批，不会重复计费也不会重复计数。
    { id: 'bio',    name: '综合生化', ids: LIVER.concat(RENAL, ELEC, ['GLU']) },

    { id: 'cardiac', name: '心肌酶',       on: false, ids: ['CK', 'CKMB', 'HBDH', 'LDH', 'CTNI'] },
    { id: 'lipid',   name: '血脂',         on: false, ids: ['TC', 'TG', 'HDLC', 'LDLC'] },
    { id: 'thyroid', name: '甲功',         on: false, ids: ['TSH', 'FT3', 'FT4', 'TT3', 'TT4'] },
    { id: 'tumor',   name: '肿瘤标志物',   on: false, ids: ['CEA', 'AFP', 'CA125', 'CA199', 'CA153', 'SF'] },
    { id: 'immune',  name: '免疫球蛋白',   on: false, ids: ['IGG', 'IGA', 'IGM', 'IGE', 'C3', 'C4'] },
    { id: 'lymph',   name: '淋巴细胞亚群', on: false, ids: ['CD3', 'CD4', 'CD8', 'CD4CD8', 'CD19', 'NK'] },
    { id: 'infect',  name: '感染筛查',     on: false, ids: ['HBSAG', 'HBSAB', 'HBEAG', 'HBEAB', 'HBCAB', 'HCVAB', 'TRUST', 'HIVAB'] },
    { id: 'iron',    name: '铁代谢',       on: false, ids: ['FE', 'TIBC', 'TSAT'] }
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
      // 从上一版升级：保留用户自己加的指标，把新的默认项并进来
      var prev = null;
      try { prev = global.localStorage.getItem(PREV_KEY); } catch (e) { /* ignore */ }
      if (prev) {
        try {
          var old = JSON.parse(prev);
          if (old && Array.isArray(old.indicators) && Array.isArray(old.pages)) {
            var haveI = {};
            old.indicators.forEach(function (i) { haveI[i.id] = 1; if (!i.type) i.type = 'num'; });
            DEFAULT_INDICATORS.forEach(function (d) { if (!haveI[d.id]) old.indicators.push(clone(d)); });
            var haveP = {};
            old.pages.forEach(function (p) { haveP[p.id] = 1; });
            DEFAULT_PAGES.forEach(function (d) { if (!haveP[d.id]) old.pages.push(clone(d)); });
            // 老页面若只是默认页的子集（说明当时没改过），扩到默认的那一版
            old.pages.forEach(function (p) {
              var def = DEFAULT_PAGES.filter(function (d) { return d.id === p.id; })[0];
              if (!def || p.ids.length >= def.ids.length) return;
              var subset = p.ids.every(function (id) { return def.ids.indexOf(id) >= 0; });
              if (subset) p.ids = def.ids.slice();
            });
            state = { indicators: old.indicators, pages: old.pages };
            rebuild(); save();
            try { global.localStorage.removeItem(PREV_KEY); } catch (e2) { /* ignore */ }
            return;
          }
        } catch (e) { /* 升级失败就走种子 */ }
      }
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

  /* 报告上的项目名常带方法学后缀，如「肌酐（酶法）」「葡萄糖(干化学)」。
     先剥掉括号里的方法学说明，再做匹配——这一步能消掉大部分对不上的情况。 */
  var METHOD_HINT = /法|酶|化学|免疫|比色|速率|终点|电极|干片|荧光|散射|层析|仪器/;

  function stripMethod(s) {
    return String(s == null ? '' : s)
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, function (m) {
        return METHOD_HINT.test(m) ? '' : m;
      })
      .replace(/(测定|检测|定量|定性)$/g, '');
  }

  /* 把名字切成"词"，只在完整的词上比较，绝不用子串。
   * 为什么不能用子串：APTT 里含着 PT、hs-CRP 里含着 CRP、FIB-4 里含着 FIB、
   * 氨基转移酶同时出现在 ALT 和 AST 的全名里。子串匹配会把它们对错，
   * 而且是悄悄对错——错配的值会显示成绿色，没人会去查。
   * 连字符保留在词内，所以 "FIB-4" 是一个词，不会被拆出 "FIB"。 */
  function words(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5\-]+/)
      .filter(function (w) { return w && !/^[0-9\-]+$/.test(w); });
  }

  /* 单位只做"量纲"级别的粗比对，不比具体写法（10^9/L 与 ×10^9/L 视为同一类）。 */
  function unitFamily(u) {
    var s = String(u == null ? '' : u)
      .toLowerCase().replace(/[\s\u3000]/g, '').replace(/[μµ]/g, 'u').replace(/×/g, '');
    if (!s) return '';
    if (s.indexOf('%') >= 0) return 'pct';
    if (/mol\/l/.test(s)) return 'molar';
    if (/(g|mg|ug|ng)\/(d)?l/.test(s)) return 'mass';
    if (/10\^?[0-9]*\/l/.test(s) || /\/ul/.test(s)) return 'count';
    if (/^(u|iu|mu|miu)\/(ml|l|dl)$/.test(s)) return 'activity';
    if (/\/(min|s|h)$/.test(s)) return 'time';
    return '';
  }

  /* 量纲对不上就不认。这是最便宜的一道校验：血钙是 mmol/L，CA125 是 U/mL，
     单位一挡，这类错配根本到不了界面上。两边有一边认不出量纲就放行。 */
  function unitFits(ind, unit) {
    if (!ind || (ind.type || 'num') !== 'num') return true;
    var a = unitFamily(unit);
    var b = unitFamily(ind.unit);
    if (!a || !b) return true;
    return a === b;
  }

  /* 把报告上的原文项目名对到标准指标。对不上就返回 null —— 宁可漏，不可猜。 */
  function match(rawName, hint, unit) {
    var raw = stripMethod(rawName);

    // 第一优先：模型给的代号。模型看得到单位、参考范围和同一页的相邻项目，
    // 比字符串可靠得多。但名字对不上的时候，单位是唯一还能验的一道关：
    // 它说这是"钙"（mmol/L），报告上写的却是 U/mL，那多半是把 CA125 认成钙了。
    if (hint && BY_ID[hint]) {
      var hf = unitFamily(unit), wf = unitFamily(BY_ID[hint].unit);
      if (hf && wf && hf !== wf) return null;
      return { id: hint, method: 'text-model', score: 1 };
    }

    var n = normalize(raw);
    if (!n) return null;

    var hits = [];
    if (ALIAS_INDEX[n]) hits.push({ id: ALIAS_INDEX[n], method: 'exact-alias', score: 1 });

    if (!hits.length) {
      words(raw).forEach(function (w) {
        if (w.length < 2) return;
        if (ALIAS_INDEX[w]) hits.push({ id: ALIAS_INDEX[w], method: 'token', score: 0.9 });
      });
    }

    // 命中两个以上不同指标 = 有歧义，一个都不认，交给人。
    var seen = {};
    hits.forEach(function (h) { seen[h.id] = 1; });
    if (Object.keys(seen).length !== 1) return null;

    var hit = hits[0];
    // 名字对得上、单位对不上：项目是对的，但可能换了单位（mg/dL 与 mmol/L）。
    // 这种情况不丢值，只降级成"存疑"，让人看一眼。
    if (!unitFits(BY_ID[hit.id], unit)) hit.warn = 'unit';
    return hit;
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
    var page = { id: id, name: name, ids: ids };
    if (raw.on === false) page.on = false;   // 默认不勾选的页（库大、默认表要小）
    return page;
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
    var p = cleanPage({ id: id, name: raw.name, ids: raw.ids, on: raw.on });
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
