import assert from 'node:assert/strict';

const noTools = '请直接用中文回答，不用任何工具，也不要读取或修改文件。';
const scenarios = [
  {
    id: 'quick-dinner', title: '下班后的简单晚饭',
    prompt: `下班到家有点饿，冰箱里有番茄、鸡蛋和剩米饭。我想在20分钟内做好一个人的晚饭，请推荐一个简单做法，用三四句话说明顺序。${noTools}`,
    checks: [
      ['番茄和鸡蛋', /(?:番茄|西红柿)/u, /(?:鸡蛋|蛋)/u],
      ['米饭', /(?:米饭|剩饭|饭)/u],
      ['具体烹饪步骤', /(?:炒|煎|煮|蒸|加热|热锅|打散)/u],
    ],
  },
  {
    id: 'reschedule-coffee', title: '给朋友礼貌改约',
    prompt: `帮我写一条发给朋友的微信：我们原定周六下午喝咖啡，但我临时有事，想改到周日上午十点。语气自然友好，稍微表达歉意，最后问对方是否方便，两三句话就好。不要替我发送。${noTools}`,
    checks: [
      ['原约定时间', /(?:周六|星期六|礼拜六)/u],
      ['新的周日时间', /(?:周日|周天|星期日|星期天|礼拜日|礼拜天)/u, /(?:十|10)/u],
      ['礼貌询问', /(?:不好意思|抱歉|歉意|对不起)/u, /(?:方便|可以|能否|好不好|好吗|行吗|怎么样)/u],
    ],
  },
  {
    id: 'desk-reset', title: '二十分钟整理书桌',
    prompt: `我有20分钟想整理书桌，上面堆着纸张、充电线和几个杯子。请给我一个容易执行的三步顺序，每一步一句话，不用买收纳用品。${noTools}`,
    checks: [
      ['处理纸张', /(?:纸|文件)/u],
      ['整理充电线', /(?:线|充电)/u],
      ['收走杯子', /(?:杯)/u],
      ['有执行顺序', /(?:先|然后|接着|最后|步骤|[123一二三][.、）)])/u],
    ],
  },
  {
    id: 'rainy-hour', title: '雨天在家放松一小时',
    prompt: `外面下雨，我想在家安静放松一小时，不买东西，也不开电视。请帮我安排两项简单活动，给出大致时间分配，用温和自然的语气写三四句话。${noTools}`,
    checks: [
      ['具体室内活动', /(?:读|阅读|书|画|写|音乐|伸展|拉伸|收拾|整理|拼图|手工|冥想|烘|咖啡|茶|呼吸|盆栽|纸牌)/u],
      ['时间分配', /(?:\d+\s*分钟|[一二三四五六十两半]+(?:分钟|小时))/u],
      ['活动安排顺序', /(?:先|然后|接着|再|最后|[12一二][.、）)]|前\s*(?:\d+|[一二三四五六十两半]+)\s*(?:分钟|小时)[\s\S]*后\s*(?:\d+|[一二三四五六十两半]+)\s*(?:分钟|小时))/u],
    ],
  },
];

export const nativeScenarioIds = Object.freeze(scenarios.map(scenario => scenario.id));

/** Deterministic defaults differ by script; repeated trust turns rotate scenarios. */
export function selectNativeScenario(suite = 'native', index = 0, override = process.env.LECTERN_TEST_SCENARIO) {
  assert.ok(Number.isSafeInteger(index) && index >= 0, 'Scenario index must be a nonnegative integer');
  const offsets = { native: 0, settings: 1, trust: 2 };
  assert.ok(Object.hasOwn(offsets, suite), `Unknown native test suite: ${suite}`);
  const scenario = override ? scenarios.find(value => value.id === override) : scenarios[(offsets[suite] + index) % scenarios.length];
  assert.ok(scenario, `Unknown LECTERN_TEST_SCENARIO; choose ${nativeScenarioIds.join(', ')}`);
  return { id: scenario.id, title: scenario.title, prompt: scenario.prompt };
}

/** Validate a completed canonical reply, not merely bytes received from an endpoint. */
export function validateNativeAnswer(scenario, answer, snapshot) {
  const definition = scenarios.find(value => value.id === scenario.id);
  assert.ok(definition, `Unknown dialogue scenario: ${scenario.id}`);
  assert.ok(answer && answer.role === 'assistant', 'A real assistant message is required');
  assert.equal(answer.source, 'jsonl', 'Reply must be reconciled with authoritative JSONL');
  assert.equal(answer.status, 'complete', 'Reply must have completed before validation');
  assert.ok(Array.isArray(answer.tools) && answer.tools.length === 0, 'Every scenario forbids tool calls');
  if (snapshot) {
    assert.equal(snapshot.status, 'idle', `Native conversation failed or remains busy: ${snapshot.error || snapshot.status}`);
    assert.equal(snapshot.error, undefined, 'No transport or controller error may be present');
  }
  const text = answer.text?.trim();
  assert.ok(text && text.length >= 16 && /[\p{L}]/u.test(text), 'Expected a nonempty natural-language reply');
  assert.doesNotMatch(text, /(?:^|\n)\s*(?:[⏺●⎿]\s*)?(?:API Error\s*:|Error\s*:|Unsupported model\s*:|Authentication failed\b|Not logged in\b|Invalid API key\b|Request failed\b|Connection error\b)/iu,
    'An endpoint, authentication or transport error is not a successful dialogue');
  assert.notEqual(text.replace(/\s+/gu, ''), scenario.prompt.replace(/\s+/gu, ''), 'Echoing the request is not answering it');
  const checks = [];
  for (const [label, ...patterns] of definition.checks) {
    assert.ok(patterns.every(pattern => pattern.test(text)), `Reply is missing scenario evidence: ${label}\n${text}`);
    checks.push(label);
  }
  return { scenarioId: definition.id, checks, characters: text.length, source: answer.source, noToolCalls: true };
}
