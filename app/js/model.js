/* 模型客户端：从浏览器直接调用模型服务。
 *
 * 为什么直连：我们不做后端，也不替用户托管 Key。Key 存在本机 localStorage，
 * 请求从浏览器直接发往用户自己选择的模型服务，中途不经过任何第三方。
 *
 * 已验证：DeepSeek 官方接口允许浏览器跨域直连（预检返回 Access-Control-Allow-Origin）。
 * 换成别的服务商时，先在浏览器控制台确认没有 CORS 报错。
 */
(function (global) {
  'use strict';

  var KEY_STORE = 'jiaowolu.apiKey';
  var CFG_STORE = 'jiaowolu.modelConfig';
  var DEFAULT_BASE = 'https://api.deepseek.com';
  var DEFAULT_MODEL = 'deepseek-flash';

  var cfg = load();
  var usage = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, failures: 0 };

  function load() {
    var c = { base: DEFAULT_BASE, model: DEFAULT_MODEL, apiKey: '' };
    try {
      var raw = localStorage.getItem(CFG_STORE);
      if (raw) {
        var o = JSON.parse(raw);
        if (o.base) c.base = o.base;
        if (o.model) c.model = o.model;
      }
      c.apiKey = localStorage.getItem(KEY_STORE) || '';
    } catch (e) { /* localStorage 不可用时退回内存 */ }
    return c;
  }

  function save() {
    try {
      localStorage.setItem(KEY_STORE, cfg.apiKey || '');
      localStorage.setItem(CFG_STORE, JSON.stringify({ base: cfg.base, model: cfg.model }));
    } catch (e) { /* 隐私模式下可能失败，忽略 */ }
  }

  function getConfig() {
    return { base: cfg.base, model: cfg.model, hasKey: !!cfg.apiKey };
  }

  function setConfig(next) {
    if (next.base != null) cfg.base = String(next.base).trim().replace(/\/+$/, '') || DEFAULT_BASE;
    if (next.model != null) cfg.model = String(next.model).trim() || DEFAULT_MODEL;
    if (next.apiKey != null) cfg.apiKey = String(next.apiKey).trim();
    save();
  }

  // 把服务端错误翻成人话——大部分失败其实是 Key 或余额，不是"系统故障"
  function humanError(status, body) {
    var detail = '';
    try {
      var j = JSON.parse(body);
      detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
    } catch (e) { detail = String(body || '').slice(0, 120); }

    if (status === 401) return 'API Key 无效或已过期，请在"设置"里重新填写。';
    if (status === 402) return '账号余额不足。';
    if (status === 403) return '这个 Key 没有调用该模型的权限。';
    if (status === 404) return '接口地址或模型名不对：' + (detail || '404');
    if (status === 429) return '请求太频繁，被限流了，稍等几秒再试。';
    if (status >= 500) return '模型服务暂时不可用（HTTP ' + status + '）。';
    return '调用失败（HTTP ' + status + '）' + (detail ? '：' + detail : '');
  }

  /* 发一次带图片的对话请求。
   * @param {string} dataUrl  data:image/jpeg;base64,... 形式的页面图片
   * @param {string} prompt   抽取指令
   * @param {object} opt      {maxTokens, signal, json}
   * @returns {Promise<{text, usage, ms}>}
   */
  async function vision(dataUrl, prompt, opt) {
    opt = opt || {};
    if (!cfg.apiKey) throw new Error('还没有填写 API Key。点右上角"设置"填一个，只保存在这台电脑的浏览器里。');

    var body = {
      model: cfg.model,
      temperature: 0,
      max_tokens: opt.maxTokens || 2400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }]
    };
    if (opt.json !== false) body.response_format = { type: 'json_object' };

    var t0 = performance.now();
    var resp = null;
    // 电脑睡醒、切换网络之后，第一条请求经常直接失败（旧连接已经死了但浏览器还在复用）。
    // 重试一次就够了；不重试的话用户会以为程序坏了。
    for (var attempt = 0; attempt < 2 && !resp; attempt++) {
      try {
        resp = await fetch(cfg.base + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.apiKey
          },
          body: JSON.stringify(body),
          signal: opt.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (opt.signal && opt.signal.aborted) throw e;
        if (attempt === 0) await new Promise(function (r) { setTimeout(r, 700); });
        else {
          usage.failures++;
          throw new Error('连不上模型服务。可能是网络不通，或该服务未开放浏览器直连（CORS）。');
        }
      }
    }

    var ms = Math.round(performance.now() - t0);
    var raw = await resp.text();

    if (!resp.ok) {
      usage.failures++;
      throw new Error(humanError(resp.status, raw));
    }

    var data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error('模型返回的不是 JSON。'); }

    var choice = (data.choices && data.choices[0]) || {};
    var msg = choice.message;
    var text = (msg && (msg.content || '')) || '';
    var finish = choice.finish_reason || '';
    var u = data.usage || {};

    usage.calls++;
    usage.promptTokens += u.prompt_tokens || 0;
    usage.completionTokens += u.completion_tokens || 0;
    usage.ms += ms;

    if (!text.trim()) {
      var e1 = new Error(finish === 'length'
        ? '模型的输出额度在思考阶段就用完了（不是图片的问题），换更大的额度重试。'
        : '模型返回了空内容。图片可能太小或太模糊，也可能是这个模型不支持图片输入。');
      e1.code = finish === 'length' ? 'truncated' : 'empty';
      throw e1;
    }
    if (finish === 'length') {
      // 内容写到一半被截断：JSON 多半是残的，交给上层用更大额度重试
      var e2 = new Error('这一页要写的内容超过了模型单次输出上限，结果被截断了。');
      e2.code = 'truncated';
      e2.partial = text;
      throw e2;
    }
    return { text: text, usage: u, ms: ms };
  }

  function getUsage() {
    var u = Object.assign({}, usage);
    u.avgMs = u.calls ? Math.round(u.ms / u.calls) : 0;
    return u;
  }

  function resetUsage() {
    usage = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, failures: 0 };
  }

  global.Model = {
    getConfig: getConfig,
    setConfig: setConfig,
    vision: vision,
    getUsage: getUsage,
    resetUsage: resetUsage,
    DEFAULTS: { base: DEFAULT_BASE, model: DEFAULT_MODEL }
  };
})(window);
