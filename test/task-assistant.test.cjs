/* 一句话质控任务：离线断言（不联网、不调模型）
 * 只证明"白名单校验、必填过滤、组预设 drop、提示词内容"这几条逻辑，
 * 不代表模型准确率——真实模型另在浏览器里跑。
 */
const assert = require('node:assert/strict');
const Assistant = require('../app/js/task-assistant.js');

const indicators = [
  { id: 'NAME', name: '姓名' },
  { id: 'HGB', name: '血红蛋白' },
  { id: 'CREA', name: '肌酐' },
  { id: 'UA', name: '尿酸' }
];
const pages = [
  { id: 'course', name: '病案首页', docType: '病案首页', ids: ['NAME'] },
  { id: 'cbc', name: '血常规', docType: '血常规', ids: ['HGB'] },
  { id: 'renal', name: '肾功能', docType: '生化', ids: ['CREA', 'UA'] }
];
const Library = {
  pages: () => pages,
  groups: () => [{ id: 'g1', pageIds: ['course', 'cbc'], reqIds: ['NAME', 'HGB'] }],
  pageById: id => pages.find(page => page.id === id) || null,
  byId: id => indicators.find(ind => ind.id === id) || null
};

/* 1. 编造的 id 被剔除并留警告；合法项保留 */
const plan = Assistant.sanitizePlan({
  pageIds: ['cbc', 'renal', 'NOT_A_PAGE'],
  requiredIndicatorIds: ['HGB', 'CREA', 'NOT_AN_INDICATOR'],
  summary: '血常规和肾功能',
  unmatched: [{ text: '自动判断病情', reason: '不属于录入质控配置' }]
}, Library);
assert.deepEqual(plan.pageIds, ['cbc', 'renal']);
assert.deepEqual(plan.requiredIndicatorIds, ['HGB', 'CREA']);
assert.equal(plan.warnings.length, 2);
assert.equal(plan.unmatched.length, 1);

/* 2. 一页都没选出来 → 必须报可读错误，让用户回退手动配置 */
assert.throws(() => Assistant.sanitizePlan({ pageIds: ['BAD'] }, Library), /有效页面/);

/* 3. 必填不在已选页面里 → 剔除并警告 */
const outside = Assistant.sanitizePlan({ pageIds: ['cbc'], requiredIndicatorIds: ['CREA'] }, Library);
assert.deepEqual(outside.requiredIndicatorIds, []);
assert.match(outside.warnings[0], /不在已选页面/);

/* 4. 应用时要把"组预设里、但这次没要求"的必填 drop 掉 */
const selection = Assistant.toSelection({
  pageIds: ['course', 'cbc'], requiredIndicatorIds: ['HGB']
}, Library);
assert.deepEqual(selection, { ids: ['course', 'cbc'], add: ['HGB'], drop: ['NAME'] });

/* 5. 提示词必须带页面 id 与输出契约，且明确"可选"不设必填 */
const prompt = Assistant.buildPrompt('血常规必填，肌酐可选', Library);
assert.match(prompt, /cbc/);
assert.match(prompt, /requiredIndicatorIds/);
assert.match(prompt, /有就录/);

/* 6. propose 走 Model.text，并把模型输出过一遍本地校验 */
(async () => {
  const result = await Assistant.propose('血常规必填，肌酐可选', Library, {
    text: async text => {
      assert.match(text, /cbc/);
      return { text: '{"pageIds":["cbc","renal"],"requiredIndicatorIds":["HGB","CREA"],"summary":"测试"}' };
    }
  });
  assert.deepEqual(result.pageIds, ['cbc', 'renal']);
  assert.deepEqual(result.requiredIndicatorIds, ['HGB', 'CREA']);
  console.log('task-assistant: 6 组离线断言通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
