/* 指标库与页面（可编辑、会保存）。
 *
 * 为什么是"页面"而不是"模板"：临床上看一份报告，看的是"这一页要录哪几项"，
 * 而不是"套用哪个模板"。一个页面 = 一组指标。
 *
 * 默认的页面结构按科室真实在用的登记表来（病程首页 / 血常规 / 出凝血 / 肝功能 /
 * 肾功能 / 电解质 / 综合生化），不是按检验科的开单习惯来。
 *
 * 身份证、电话、住址这些直接标识符**收进来了**，因为医院的登记表本来就有，
 * 而且这些字段确实要"照着报告录"。我们的立场是：它们只留在本机浏览器里，
 * 不上传、不经过开发者；导出时可以用「隐藏身份信息」一键抹掉。
 *
 * 页面分两类（page.kind）：
 *   common  常规页面——每个病人都会做的检查，默认勾选；
 *   special 特殊页面——某个病种才做的专项检查，默认不勾。
 * 以后做"页面组"时，组就是这两类页面的组合。
 *
 * 数据存在浏览器 localStorage 里，换电脑就没了——这是刻意的：
 * 这是科室自己维护的一份表，不该由我们托管。
 *
 * 同义词表是这个项目最值钱的东西之一：同一项检查在不同医院有不同叫法
 * （血红蛋白 / 血色素 / HGB / Hb），先把能对上的对上，对不上的才交给模型。
 */
(function (global) {
  'use strict';

  // v4：按医院真实后台的登记表重建（病案首页 14 项、病毒学/FISH/病理/骨髓流式/增强CT/免疫学/出院小结）
  var STORE_KEY = 'jiaowolu.library.v5';
  var PREV_KEY = 'jiaowolu.library.v4';
  var OLD_KEY = 'jiaowolu.library.v3';

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
    // ---- 病案首页：几乎没有数值，全是文本与日期（照医院真实登记表的 14 项） ----
    txt('NAME',      '姓名',       '病案首页', ['姓名', '患者姓名', '名字', '姓 名']),
    txt('SEX',       '性别',       '病案首页', ['性别', '性 别']),
    txt('ADMNO',     '住院号',     '病案首页', ['住院号', '住院号/门诊号', '病案号']),
    num('VISITAGE',  '就诊年龄',   '病案首页', '岁', '', null, null, ['就诊年龄', '入院年龄']),
    dat('VISITDATE', '就诊日期',   '病案首页', ['就诊日期', '入院日期', '入院时间']),
    txt('DIAGTYPE',  '诊断分型',   '病案首页', ['诊断分型', '诊断结果', '诊断', '出院诊断', '入院诊断']),
    num('AGE',       '年龄',       '病案首页', '岁', '', null, null, ['年龄']),
    txt('ETHNIC',    '民族',       '病案首页', ['民族']),
    txt('HUKOU',     '户籍',       '病案首页', ['户籍', '户籍地址', '户口', '户口所在地']),
    txt('IDNO',      '身份证',     '病案首页', ['身份证', '身份证号', '证件号码']),
    txt('PHONE',     '电话',       '病案首页', ['电话', '联系电话', '手机', '手机号']),
    txt('PHONE2',    '其他联系方式', '病案首页', ['其他联系方式', '其他电话', '联系人电话']),
    txt('ADDR',      '地址',       '病案首页', ['地址', '家庭住址', '住址', '现住址']),
    txt('HOSP',      '就诊医院',   '病案首页', ['就诊医院', '医院名称', '医疗机构']),

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
    num('ALP',   '碱性磷酸酶',       '肝功能', 'U/L',     '45–125',   45,  125,  ['碱性磷酸酶', 'ALP', 'AKP', 'ALKP']),
    num('GGT',   'γ-谷氨酰转肽酶',   '肝功能', 'U/L',     '10–60',    10,  60,   ['γ-谷氨酰转肽酶', '谷氨酰转肽酶', 'GGT', 'γ-GT', 'r-GT']),
    num('LDH',   '乳酸脱氢酶',       '肝功能', 'U/L',     '120–250',  120, 250,  ['乳酸脱氢酶', 'LDH', 'LD']),
    num('TBIL',  '总胆红素',         '肝功能', 'μmol/L',  '3.4–26.0', 3.4, 26.0, ['总胆红素', 'TBIL', 'T-BIL', 'TBil']),
    num('DBIL',  '直接胆红素',       '肝功能', 'μmol/L',  '0–8.0',    0,   8.0,  ['直接胆红素', 'DBIL', 'D-BIL', '结合胆红素']),
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

    // 病毒学报告（定性为主，照抄原文，不判读临床意义）
    txt('HBSAG',      '乙肝病毒表面抗原',   '病毒学报告', ['乙肝病毒表面抗原', '乙肝表面抗原', 'HBsAg', '表面抗原']),
    txt('HBSAB',      '乙肝病毒表面抗体',   '病毒学报告', ['乙肝病毒表面抗体', '乙肝表面抗体', 'HBsAb', '表面抗体']),
    txt('HBEAG',      '乙肝病毒e抗原',      '病毒学报告', ['乙肝病毒e抗原', '乙肝e抗原', 'HBeAg', 'e抗原']),
    txt('HBEAB',      '乙肝病毒e抗体',      '病毒学报告', ['乙肝病毒e抗体', '乙肝e抗体', 'HBeAb', 'e抗体']),
    txt('HBCAB',      '乙肝病毒核心抗体',   '病毒学报告', ['乙肝病毒核心抗体', '乙肝核心抗体', 'HBcAb', '核心抗体']),
    txt('HBCAB_IGM',  '乙肝病毒核心抗体IgM','病毒学报告', ['乙肝病毒核心抗体IgM', '核心抗体IgM', 'HBcAb-IgM', 'IgM核心抗体']),
    txt('HCVAB',      '丙肝病毒抗体 HCV_Ab','病毒学报告', ['丙肝病毒抗体', '丙型肝炎抗体', '抗-HCV', 'HCV_Ab', 'HCVAb']),
    num('HBV_DNA',    '乙肝病毒核酸定量_PCR', '病毒学报告', 'IU/mL', '', null, null, ['乙肝病毒核酸定量', 'HBV-DNA', 'HBV_DNA', '乙肝DNA']),
    num('EBV_DNA',    'EBV病毒DNA定量',      '病毒学报告', 'copies/mL', '', null, null, ['EBV病毒DNA定量', 'EBV-DNA', 'EBV_DNA', 'EB病毒DNA']),

    // 免疫学报告（截图里的 11 个框；β2-微球蛋白与肾功能是同一个指标，复用 B2MG）
    num('IGG', '免疫球蛋白IgG', '免疫学报告', 'g/L', '7.0–16.0', 7, 16, ['免疫球蛋白IgG', 'IgG', 'IGG', '免疫球蛋白G']),
    num('IGA', '免疫球蛋白IgA', '免疫学报告', 'g/L', '0.7–4.0', 0.7, 4.0, ['免疫球蛋白IgA', 'IgA', 'IGA', '免疫球蛋白A']),
    num('IGM', '免疫球蛋白IgM', '免疫学报告', 'g/L', '0.4–2.3', 0.4, 2.3, ['免疫球蛋白IgM', 'IgM', 'IGM', '免疫球蛋白M']),
    num('SF',  '铁蛋白',       '免疫学报告', 'ng/mL', '30–400', 30, 400, ['铁蛋白', '血清铁蛋白', 'SF', 'FERR', '铁蛋白_ng/mL']),
    num('ESR', '红细胞沉降率', '免疫学报告', 'mm/h', '0–15', 0, 15, ['红细胞沉降率', '血沉', 'ESR', '红细胞沉降率_mm_h']),
    txt('IFFE', '血免疫固定电泳', '免疫学报告', ['血免疫固定电泳', '免疫固定电泳', 'IFE', 'IFFE']),
    txt('CIMU', '结论描述',       '免疫学报告', ['结论描述', '结论', '免疫学结论']),

    // FISH 报告：都是"重排/扩增/缺失"的定性结果
    txt('FISH_BCL2',  'BCL2（FISH）',  'FISH报告', ['BCL2', 'BCL-2', 'FISH-BCL2', 'BCL2基因重排']),
    txt('FISH_BCL6',  'BCL6（FISH）',  'FISH报告', ['BCL6', 'BCL-6', 'FISH-BCL6']),
    txt('FISH_CMYC',  'C_MYC（FISH）', 'FISH报告', ['C_MYC', 'C-MYC', 'CMYC', 'MYC']),
    txt('FISH_TP53',  'TP53（FISH）',  'FISH报告', ['TP53', 'P53基因', 'FISH-TP53']),
    txt('FISH_IRF4',  'IRF4',          'FISH报告', ['IRF4']),
    txt('FISH_MALT1', 'MALT1',         'FISH报告', ['MALT1']),
    txt('FISH_CCND1', 'CCND1',         'FISH报告', ['CCND1', 'CyclinD1基因']),
    txt('FISH_9P24',  '9p24_PD_L1',    'FISH报告', ['9p24_PD_L1', '9p24', 'PD-L1扩增']),
    txt('FISH_6Q21',  '6q21',          'FISH报告', ['6q21']),
    txt('FISH_ALK',   'ALK（FISH）',   'FISH报告', ['ALK', 'FISH-ALK', 'ALK重排']),
    txt('FISH_DUSP22','DUSP22',        'FISH报告', ['DUSP22']),
    txt('FISH_TP63',  'TP63',          'FISH报告', ['TP63']),
    txt('FISH_11Q23', '11q23_3扩增',   'FISH报告', ['11q23_3扩增', '11q23', '11q23扩增']),
    txt('FISH_11Q24', '11q24_3缺失',   'FISH报告', ['11q24_3缺失', '11q24', '11q24缺失']),
    txt('FISH_IGHV',  'IGHV高频突变',  'FISH报告', ['IGHV高频突变', 'IGHV', 'IGHV突变']),
    txt('FISH_NOTE',  '备注（FISH）',  'FISH报告', ['备注']),

    /* 病理报告：40 项免疫组化 + 三个描述项。
       免疫组化取 +/−/±，是"蛋白有没有表达"；FISH 是"基因有没有重排"，两回事。
       所以同名的几项（BCL-2/BCL-6/C-MYC/ALK/TP53）名字后面带（病理）/（FISH）区分。 */
    dat('PDATE', '诊断时间',   '病理报告', ['诊断时间', '报告日期', '病理日期']),
    txt('PCONC', '诊断结论',   '病理报告', ['诊断结论', '病理诊断', '诊断意见']),
    txt('PIMMU', '免疫结果',   '病理报告', ['免疫结果', '免疫组化结果', '免疫表型']),
    txt('IHC_CD20',   'CD20',   '病理报告', ['CD20']),
    txt('IHC_CD22',   'CD22',   '病理报告', ['CD22']),
    txt('IHC_CD19',   'CD19',   '病理报告', ['CD19']),
    txt('IHC_CD79A',  'CD79a',  '病理报告', ['CD79a', 'CD79α']),
    txt('IHC_CD79B',  'CD79b',  '病理报告', ['CD79b', 'CD79β']),
    txt('IHC_CD3',    'CD3',    '病理报告', ['CD3']),
    txt('IHC_CD5',    'CD5',    '病理报告', ['CD5']),
    txt('IHC_CD21',   'CD21',   '病理报告', ['CD21']),
    txt('IHC_CD23',   'CD23',   '病理报告', ['CD23']),
    txt('IHC_CD10',   'CD10',   '病理报告', ['CD10']),
    txt('IHC_CMYC',   'C-MYC（病理）', '病理报告', ['C-MYC', 'C-MYC蛋白', 'CMYC']),
    txt('IHC_CYCLIN', 'CyclinD1', '病理报告', ['CyclinD1', 'Cyclin D1', '细胞周期蛋白D1']),
    txt('IHC_BCL2',   'BCL-2（病理）', '病理报告', ['BCL-2', 'BCL2', 'BCL-2蛋白']),
    txt('IHC_BCL6',   'BCL-6（病理）', '病理报告', ['BCL-6', 'BCL6', 'BCL-6蛋白']),
    txt('IHC_MUM1',   'MUM-1',  '病理报告', ['MUM-1', 'MUM1']),
    txt('IHC_CD30',   'CD30',   '病理报告', ['CD30']),
    txt('IHC_CD37',   'CD37',   '病理报告', ['CD37']),
    txt('IHC_CD38',   'CD38',   '病理报告', ['CD38']),
    txt('IHC_CD47',   'CD47',   '病理报告', ['CD47']),
    txt('IHC_P53',    'P53',    '病理报告', ['P53', 'p53']),
    txt('IHC_PD1',    'PD-1',   '病理报告', ['PD-1', 'PD1']),
    num('IHC_KI67',   'Ki67',   '病理报告', '%', '', null, null, ['Ki67', 'KI67', 'Ki-67', '增殖指数']),
    txt('IHC_CD68',   'CD68',   '病理报告', ['CD68']),
    txt('IHC_GATA3',  'GATA3',  '病理报告', ['GATA3']),
    txt('IHC_CD8',    'CD8',    '病理报告', ['CD8']),
    txt('IHC_CD2',    'CD2',    '病理报告', ['CD2']),
    txt('IHC_CD7',    'CD7',    '病理报告', ['CD7']),
    txt('IHC_CD4',    'CD4',    '病理报告', ['CD4']),
    txt('IHC_CD56',   'CD56',   '病理报告', ['CD56']),
    txt('IHC_PDL1',   'PD-L1',  '病理报告', ['PD-L1', 'PDL1']),
    txt('IHC_EBER',   'EBER',   '病理报告', ['EBER', 'EBER原位杂交']),
    txt('IHC_ICOS',   'ICOS',   '病理报告', ['ICOS']),
    txt('IHC_CXCL13', 'CXCL-13','病理报告', ['CXCL-13', 'CXCL13']),
    txt('IHC_TIA1',   'TIA-1',  '病理报告', ['TIA-1', 'TIA1']),
    txt('IHC_PERF',   'Perforin',  '病理报告', ['Perforin', '穿孔素']),
    txt('IHC_GZMB',   'GranzymeB', '病理报告', ['GranzymeB', 'Granzyme B', '粒酶B']),
    txt('IHC_ALK',    'ALK（病理）', '病理报告', ['ALK', 'ALK蛋白', '间变性淋巴瘤激酶']),
    txt('IHC_TBX21',  'TBX21',  '病理报告', ['TBX21']),
    txt('IHC_EGFR',   'EGFR',   '病理报告', ['EGFR']),
    txt('IHC_SOX11',  'SOX11',  '病理报告', ['SOX11']),

    // 骨髓流式报告
    txt('FLOW_INV', '骨髓是否受累',        '骨髓流式报告', ['骨髓是否受累', '骨髓受累', '骨髓侵犯']),
    num('FLOW_PCT', '异常细胞占白细胞比例', '骨髓流式报告', '%', '', null, null, ['异常细胞占白细胞比例', '异常细胞比例', '流式异常细胞比例']),

    // 增强CT报告（整段照抄，不做结构化）
    txt('CT_RPT',  'PET_CT报告内容', '增强CT报告', ['PET_CT报告内容', 'CT报告内容', '影像学报告', '报告内容']),
    txt('CT_TYPE', '影像学报告类型', '增强CT报告', ['影像学报告类型', '检查类型', '报告类型']),

    // 出院小结（首次与最新同一套字段）
    dat('DDATE',      '诊断时间',         '出院小结', ['诊断时间', '出院诊断时间']),
    txt('GRADEUP',    '是否向高级别转化', '出院小结', ['是否向高级别转化', '向高级别转化', '转化']),
    txt('DIED',       '是否死亡',         '出院小结', ['是否死亡', '死亡']),
    dat('DEATHDATE',  '死亡时间',         '出院小结', ['死亡时间', '死亡日期']),
    txt('DEATHCAUSE', '死亡原因',         '出院小结', ['死亡原因', '死因']),
    dat('LASTFUP',    '末次随访时间',     '出院小结', ['末次随访时间', '末次随访', '随访日期']),
    dat('LOSTFUP',    '失访时间',         '出院小结', ['失访时间', '失访日期']),
    txt('FUPNOTE',    '随访情况说明',     '出院小结', ['随访情况说明', '随访情况', '随访记录'])
  ];

  var LIVER = ['ALT', 'AST', 'ALP', 'GGT', 'LDH', 'TBIL', 'DBIL', 'IBIL', 'ALB', 'TP', 'GLB'];
  var RENAL = ['BUN', 'CREA', 'UA', 'CYSC', 'B2MG'];
  var ELEC = ['NA', 'K', 'CL', 'CA', 'P', 'MG'];

  /* on:false 的页面默认不勾选——库可以大，但默认打开的表不该有上百行。
     需要哪一页，在左侧勾上就行。 */
  var DEFAULT_PAGES = [
    /* 常规页面：每个病人都会做的检查，默认勾选 */
    { id: 'course', kind: 'common', name: '病案首页', ids: ['NAME', 'SEX', 'ADMNO', 'VISITAGE', 'VISITDATE', 'DIAGTYPE', 'AGE', 'ETHNIC', 'HUKOU', 'IDNO', 'PHONE', 'PHONE2', 'ADDR', 'HOSP'] },
    { id: 'cbc',    kind: 'common', name: '血常规',   ids: ['WBC', 'RBC', 'HGB', 'PLT', 'LYMPH_C', 'NEUT_C', 'MONO_C', 'HCT', 'MCV', 'MCH'] },
    { id: 'liver',  kind: 'common', name: '肝功能',   ids: LIVER },
    { id: 'renal',  kind: 'common', name: '肾功能',   ids: RENAL },
    { id: 'elec',   kind: 'common', name: '电解质',   ids: ELEC },
    // 综合生化 = 肝功 + 肾功 + 电解质（+ 血糖）合并成一页的报告，
    // 和上面三页是"填一个或填三个"的关系。指标是同一批，不会重复计数。
    { id: 'bio',    kind: 'common', name: '综合生化', ids: LIVER.concat(RENAL, ELEC, ['GLU']) },
    { id: 'discharge', kind: 'common', name: '出院小结', ids: ['DDATE', 'GRADEUP', 'DIED', 'DEATHDATE', 'DEATHCAUSE', 'LASTFUP', 'LOSTFUP', 'FUPNOTE'] },

    /* 特殊页面：某个病种才做的专项检查，默认不勾——库可以大，默认打开的表不该几百行 */
    { id: 'coag',   kind: 'special', on: false, name: '出凝血',       ids: ['APTT', 'PT', 'TT', 'FIB', 'FDP', 'DDIMER', 'INR'] },
    { id: 'immu',   kind: 'special', on: false, name: '免疫学报告',   ids: ['IGG', 'IGA', 'IGM', 'B2MG', 'SF', 'ESR', 'IFFE', 'CIMU'] },
    { id: 'infect', kind: 'special', on: false, name: '病毒学报告',   ids: ['HBSAG', 'HBSAB', 'HBEAG', 'HBEAB', 'HBCAB', 'HBCAB_IGM', 'HCVAB', 'HBV_DNA', 'EBV_DNA'] },
    { id: 'fish',   kind: 'special', on: false, name: 'FISH报告',     ids: ['FISH_BCL2', 'FISH_BCL6', 'FISH_CMYC', 'FISH_TP53', 'FISH_IRF4', 'FISH_MALT1', 'FISH_CCND1', 'FISH_9P24', 'FISH_6Q21', 'FISH_ALK', 'FISH_DUSP22', 'FISH_TP63', 'FISH_11Q23', 'FISH_11Q24', 'FISH_IGHV', 'FISH_NOTE'] },
    { id: 'patho',  kind: 'special', on: false, name: '病理报告',     ids: ['PDATE', 'PCONC', 'PIMMU', 'IHC_CD20', 'IHC_CD22', 'IHC_CD19', 'IHC_CD79A', 'IHC_CD79B', 'IHC_CD3', 'IHC_CD5', 'IHC_CD21', 'IHC_CD23', 'IHC_CD10', 'IHC_CMYC', 'IHC_CYCLIN', 'IHC_BCL2', 'IHC_BCL6', 'IHC_MUM1', 'IHC_CD30', 'IHC_CD37', 'IHC_CD38', 'IHC_CD47', 'IHC_P53', 'IHC_PD1', 'IHC_KI67', 'IHC_CD68', 'IHC_GATA3', 'IHC_CD8', 'IHC_CD2', 'IHC_CD7', 'IHC_CD4', 'IHC_CD56', 'IHC_PDL1', 'IHC_EBER', 'IHC_ICOS', 'IHC_CXCL13', 'IHC_TIA1', 'IHC_PERF', 'IHC_GZMB', 'IHC_ALK', 'IHC_TBX21', 'IHC_EGFR', 'IHC_SOX11'] },
    { id: 'flow',   kind: 'special', on: false, name: '骨髓流式报告', ids: ['FLOW_INV', 'FLOW_PCT'] },
    { id: 'ct',     kind: 'special', on: false, name: '增强CT报告',   ids: ['CT_RPT', 'CT_TYPE'] }
  ];

  /* 默认页面归属哪种文书。老存档里的页面没有 docType，按这张表补上；
   * 用户新建的页面自己选，选"其他"或不选就不参与定向抽取。 */
  var DEFAULT_DOC_TYPE = {
    course: '病案首页', cbc: '血常规',
    liver: '生化', renal: '生化', elec: '生化', bio: '生化',
    discharge: '出院小结', coag: '出凝血', immu: '免疫', infect: '病毒学',
    fish: 'FISH', patho: '病理', flow: '骨髓流式', ct: '影像'
  };
  DEFAULT_PAGES.forEach(function (p) { if (!p.docType) p.docType = DEFAULT_DOC_TYPE[p.id] || ''; });
  function backfillDocType(p) {
    if (!p || typeof p !== 'object') return p;
    if (p.docType === undefined || p.docType === null || p.docType === '') {
      p.docType = DEFAULT_DOC_TYPE[p.id] || '';
    }
    return p;
  }

  /* 页面组：把一批页面打成一包，勾组等于"把组里这些页面一起勾上"。
     组里还可以预设"这一组里哪些指标算必填"——淋巴瘤质控和常规随访要盯的项不一样，
     但不必每次重建一遍页面。页面可以同时属于多个组。 */
  var DEFAULT_GROUPS = [
    {
      id: 'common', name: '常规页面组', reqIds: [],
      pageIds: ['course', 'cbc', 'liver', 'renal', 'elec', 'bio', 'discharge']
    },
    {
      id: 'lymphoma', name: '淋巴瘤专项检查', reqIds: [],
      pageIds: ['course', 'cbc', 'liver', 'renal', 'elec', 'bio', 'discharge',
        'coag', 'immu', 'infect', 'fish', 'patho', 'flow', 'ct']
    }
  ];

  var state = { indicators: [], pages: [], groups: [] };
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
    var seed = { indicators: clone(DEFAULT_INDICATORS), pages: clone(DEFAULT_PAGES), groups: clone(DEFAULT_GROUPS) };
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
            // 这一版的默认页面是照医院真实后台的登记表重建的，字段变化很大：
            // 默认页的定义以新版为准，只保留用户自己的"勾没勾"。
            old.pages.forEach(function (p) {
              var def = DEFAULT_PAGES.filter(function (d) { return d.id === p.id; })[0];
              if (!def) return;                    // 用户自建的页面原样保留
              var same = p.ids.length === def.ids.length &&
                p.ids.every(function (id, i) { return id === def.ids[i]; });
              if (!same) p.ids = def.ids.slice();
              p.name = def.name;
              p.kind = def.kind;
              p.docType = def.docType;
            });
            old.pages.forEach(backfillDocType);
            state = { indicators: old.indicators, pages: old.pages, groups: clone(DEFAULT_GROUPS) };
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
      // 上一版没有页面组，补一份默认的；已有的组原样保留
      var gs = Array.isArray(got.groups) && got.groups.length ? got.groups : clone(DEFAULT_GROUPS);
      // 上一版页面没有 docType：按默认归属补齐，老配置照常能用
      got.pages.forEach(backfillDocType);
      state = { indicators: got.indicators, pages: got.pages, groups: gs };
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

  /* ---------------- 页面组 ---------------- */

  function groups() { return state.groups.slice(); }

  function groupById(id) {
    return state.groups.filter(function (g) { return g.id === id; })[0] || null;
  }

  // 组里引用的页面或指标可能已经被删了，校验时顺手剔掉，别把脏引用带进存档
  function cleanGroup(raw) {
    var src = raw || {};
    var name = String(src.name || '').trim();
    if (!name) throw new Error('组名不能为空');
    var pageIds = [];
    (src.pageIds || []).forEach(function (pid) {
      if (pageById(pid) && pageIds.indexOf(pid) === -1) pageIds.push(pid);
    });
    if (!pageIds.length) throw new Error('至少选一个页面');
    var reqIds = [];
    (src.reqIds || []).forEach(function (id) {
      if (BY_ID[id] && reqIds.indexOf(id) === -1) reqIds.push(id);
    });
    return {
      id: src.id || ('g' + Date.now().toString(36)),
      name: name,
      pageIds: pageIds,
      reqIds: reqIds
    };
  }

  function addGroup(raw) {
    var g = cleanGroup(raw);
    state.groups.push(g);
    save();
    return g;
  }

  function updateGroup(raw) {
    var g = cleanGroup(raw);
    var i = state.groups.map(function (x) { return x.id; }).indexOf(g.id);
    if (i < 0) throw new Error('这个组不在了');
    state.groups[i] = g;
    save();
    return g;
  }

  function removeGroup(id) {
    state.groups = state.groups.filter(function (g) { return g.id !== id; });
    save();
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

  /* 文书类型：模型第一批只需判断"这一页是哪一种"，判完才知道该问它要哪些指标。
   * 这个列表是固定的分类（判断结果只有这几种），但"哪种类型对应哪些页面"是可配置的：
   * 每个页面记着自己的 docType，新建页面时选一个类型，它就参与那一类的抽取。 */
  var DOC_TYPES = ['血常规', '生化', '出凝血', '免疫', '病毒学', 'FISH', '病理', '骨髓流式', '影像', '病案首页', '出院小结', '其他'];

  function cleanPage(raw) {
    var name = String(raw.name || '').trim();
    if (!name) throw new Error('页面名称不能为空');
    var ids = (raw.ids || []).filter(function (id) { return !!BY_ID[id]; });
    if (!ids.length) throw new Error('至少选一个指标');
    var id = String(raw.id || '').trim() || 'p' + Date.now().toString(36);
    var page = { id: id, name: name, ids: ids };
    page.kind = raw.kind === 'special' ? 'special' : 'common';
    var docType = String(raw.docType || '').trim();
    page.docType = DOC_TYPES.indexOf(docType) >= 0 ? docType : '';
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
    var p = cleanPage({ id: id, name: raw.name, ids: raw.ids, on: raw.on, docType: raw.docType, kind: raw.kind });
    state.pages[i] = p;
    save();
    return p;
  }

  function removePage(id) {
    state.pages = state.pages.filter(function (p) { return p.id !== id; });
    save();
  }

  function resetAll() {
    state = { indicators: clone(DEFAULT_INDICATORS), pages: clone(DEFAULT_PAGES), groups: clone(DEFAULT_GROUPS) };
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
    DOC_TYPES: DOC_TYPES,
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
    groups: groups,
    groupById: groupById,
    addGroup: addGroup,
    updateGroup: updateGroup,
    removeGroup: removeGroup,
    resetAll: resetAll,
    takeRenames: takeRenames,
    parseRange: parseRange
  };

  // 兼容旧引用
  global.IndicatorLib = { byId: byId, match: match, normalize: normalize };
})(window);
