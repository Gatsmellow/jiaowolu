/* 交我录 · 一句话质控任务
 *
 * 模型只负责"听懂这句话要哪些页面、哪些必填"，剩下的事都在本地：
 *   1. 只认指标库里已有的页面 id 和指标 id（白名单，模型编的 id 一律丢弃并记警告）；
 *   2. 必填项必须属于已选页面，否则剔除；
 *   3. 结果先给用户看，点"确认"才写进本批规则。
 *
 * 不创建指标、不生成医学规则、不自动应用模型输出。
 */
(function (global) {
  'use strict';

  /* 可关联的文书类型：取指标库的定义，去掉"其他"——
   * 把自定义页面挂到"其他"上，等于任何没认出来的文书都往这一页抽，没有意义。 */
  function docTypes() {
    var all = (global.Library && global.Library.DOC_TYPES) || [];
    return all.filter(function (type) { return type && type !== '其他'; });
  }

  function strings(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    value.forEach(function (item) {
      var text = String(item == null ? '' : item).trim();
      if (text && out.indexOf(text) === -1) out.push(text);
    });
    return out;
  }

  function pageIdsOf(Library) {
    return Library.pages().map(function (page) { return page.id; });
  }

  function targetIdsOf(Library, pageIds) {
    var target = [];
    pageIds.forEach(function (pageId) {
      var page = Library.pageById(pageId);
      if (!page) return;
      (page.ids || []).forEach(function (id) {
        if (Library.byId(id) && target.indexOf(id) === -1) target.push(id);
      });
    });
    return target;
  }

  /* 给模型的目录：页面 id｜页面名｜文书类型｜该页指标（id=名称） */
  function buildCatalog(Library) {
    return Library.pages().map(function (page) {
      var items = (page.ids || []).map(function (id) {
        var ind = Library.byId(id);
        return ind ? id + '=' + ind.name : '';
      }).filter(Boolean).join('；');
      var type = page.docType ? '｜' + page.docType : '';
      return page.id + '｜' + page.name + type + '｜' + items;
    }).join('\n');
  }

  function buildPrompt(requirement, Library) {
    return [
      '你是医疗数据录入工具的“质控任务配置器”，不是医生，也不做医学判断。',
      '把用户要求转换成"这一批要看哪些页面、哪些指标必须齐全"。只能使用下面目录里已有的 ID。',
      '',
      '用户要求：' + requirement,
      '',
      '页面与指标目录（页面ID｜页面名｜文书类型｜该页指标）：',
      buildCatalog(Library),
      '',
      '只输出 JSON，不要 Markdown、不要解释：',
      '{"pageIds":["页面ID"],"requiredIndicatorIds":["指标ID"],',
      ' "summary":"用一句中文概括这次要整理哪些页面、哪些必填",',
      ' "unmatched":[{"text":"无法落实的原始要求","reason":"为什么无法落实"}]}',
      '',
      '规则：',
      '1. pageIds 至少一项；requiredIndicatorIds 必须属于已选页面，可以为空。',
      '2. 只有"必须、必填、缺了要打回"才放进 requiredIndicatorIds；"有就录、可选、有结果就整理"一律不放。',
      '3. 不得创造页面或指标；不得补充用户没有提出的医学要求。',
      '4. 涉及诊断、病情判断、治疗建议、预后、用药、风险预测等超出录入质控的要求，放进 unmatched，不要回答。',
      '5. 拿不准的也放进 unmatched，不要猜。'
    ].join('\n');
  }

  function parseJson(text) {
    var raw = String(text || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(raw);
    } catch (e) {
      var a = raw.indexOf('{');
      var b = raw.lastIndexOf('}');
      if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1));
      throw new Error('模型返回的不是可解析的 JSON。');
    }
  }

  /* 本地校验：不信任模型。返回 {pageIds, requiredIndicatorIds, summary, unmatched, warnings} */
  function sanitizePlan(raw, Library) {
    if (!raw || typeof raw !== 'object') throw new Error('模型没有返回任务配置对象。');

    var validPages = pageIdsOf(Library);
    var warnings = [];

    var pages = strings(raw.pageIds).filter(function (id) {
      var ok = validPages.indexOf(id) !== -1;
      if (!ok) warnings.push('已忽略不存在的页面：' + id);
      return ok;
    });
    if (!pages.length) throw new Error('模型没有选出有效页面，请改用页面组手动配置。');

    var target = targetIdsOf(Library, pages);
    var required = strings(raw.requiredIndicatorIds).filter(function (id) {
      if (!Library.byId(id)) {
        warnings.push('已忽略不存在的指标：' + id);
        return false;
      }
      if (target.indexOf(id) === -1) {
        warnings.push('必填项不在已选页面中，未应用：' + id);
        return false;
      }
      return true;
    });

    var unmatched = Array.isArray(raw.unmatched) ? raw.unmatched.slice(0, 20).map(function (item) {
      return {
        text: String((item && item.text) || '').slice(0, 200),
        reason: String((item && item.reason) || '').slice(0, 200)
      };
    }).filter(function (item) { return item.text; }) : [];

    return {
      pageIds: pages,
      requiredIndicatorIds: required,
      summary: String(raw.summary || '').trim().slice(0, 200),
      unmatched: unmatched,
      warnings: warnings
    };
  }

  /* 当前生效必填 = 激活页面组预设 ∪ add − drop。
   * 所以应用任务时，必须把"因为页面组合被激活、但不在这次任务里"的组预设显式 drop 掉，
   * 否则用户会看到一堆没要求过的红项。 */
  function toSelection(plan, Library) {
    var required = plan.requiredIndicatorIds.slice();
    var drop = [];
    Library.groups().forEach(function (group) {
      var pageIds = group.pageIds || [];
      var active = pageIds.length && pageIds.every(function (id) {
        return plan.pageIds.indexOf(id) !== -1;
      });
      if (!active) return;
      (group.reqIds || []).forEach(function (id) {
        if (required.indexOf(id) === -1 && drop.indexOf(id) === -1) drop.push(id);
      });
    });
    return { ids: plan.pageIds.slice(), add: required, drop: drop };
  }

  async function propose(requirement, Library, Model) {
    var text = String(requirement || '').trim();
    if (text.length < 2 || text.length > 500) throw new Error('任务要求请填写 2～500 个字符。');
    if (!Model || typeof Model.text !== 'function') throw new Error('当前模型客户端还不支持文本任务配置。');
    var response = await Model.text(buildPrompt(text, Library), { maxTokens: 3000, json: true });
    return sanitizePlan(parseJson(response.text), Library);
  }

  var api = {
    DOC_TYPES: docTypes,
    buildCatalog: buildCatalog,
    buildPrompt: buildPrompt,
    parseJson: parseJson,
    sanitizePlan: sanitizePlan,
    toSelection: toSelection,
    propose: propose
  };
  global.TaskAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
