import type { LangfuseClient } from '@langfuse/client';

type Api = LangfuseClient['api']['unstable'];
type Widget = Parameters<Api['dashboardWidgets']['create']>[0];
const metadata = (key: string, value: string) => ({
  column: 'metadata',
  type: 'stringObject',
  key,
  operator: '=',
  value,
});
const requests = [
  { column: 'name', type: 'string', operator: 'starts with', value: 'model.request.' },
  { column: 'type', type: 'stringOptions', operator: 'any of', value: ['GENERATION', 'EMBEDDING'] },
];
export const DASHBOARD_FILTERS = [
  metadata('accountingVersion', 'requests-v1'),
  { column: 'environment', type: 'stringOptions', operator: 'none of', value: ['test'] },
];
const counter = (name: string, description: string, filters = requests): Widget => ({
  name: `狼人杀 · ${name}`,
  description,
  view: 'observations',
  dimensions: [],
  metrics: [{ measure: 'count', agg: 'count' }],
  filters,
  chartType: 'NUMBER',
});
export const DASHBOARD_WIDGETS: Widget[] = [
  counter('物理请求数', '仅实际发出的聊天和向量请求；不重复统计父节点。'),
  counter('传输重试数', '同一逻辑调用的第 2 次及以后实际请求。', [
    ...requests,
    metadata('transportRetry', 'true'),
  ]),
  counter('格式重问数', '按逻辑调用计数，重问内的传输重试不再重复计入。', [
    { column: 'name', type: 'string', operator: '=', value: 'model.call' },
    metadata('formatReask', 'true'),
  ]),
  counter('请求失败数', '物理请求失败；不包含主动取消或格式不合格。', [
    ...requests,
    metadata('status', 'failed'),
  ]),
  counter('取消请求数', '已发出后取消的请求；不能据此认为供应商未计费。', [
    ...requests,
    metadata('status', 'cancelled'),
  ]),
  counter(
    '费用未知请求数',
    '套餐无法按次分摊、未核对价格、用量缺失或冲突均记为未知；不是零费用。',
    [...requests, metadata('costStatus', 'unknown')],
  ),
  {
    name: '狼人杀 · 模型用量',
    description:
      '缓存属于输入子集，推理属于输出子集；合计仅覆盖已报告用量，请同时查看用量不完整请求数。',
    view: 'observations',
    dimensions: [{ field: 'providedModelName' }],
    metrics: [
      { measure: 'inputTokens', agg: 'sum' },
      { measure: 'outputTokens', agg: 'sum' },
      { measure: 'totalTokens', agg: 'sum' },
    ],
    filters: requests,
    chartType: 'PIVOT_TABLE',
  },
  {
    name: '狼人杀 · 步骤用量与延迟',
    description:
      '按请求步骤汇总；延迟是单次请求耗时，不是整局墙钟时间。可添加 Session ID 筛选单局。',
    view: 'observations',
    dimensions: [{ field: 'name' }],
    metrics: [
      { measure: 'count', agg: 'count' },
      { measure: 'totalTokens', agg: 'sum' },
      { measure: 'latency', agg: 'p50' },
      { measure: 'latency', agg: 'p95' },
    ],
    filters: requests,
    chartType: 'PIVOT_TABLE',
  },
  {
    name: '狼人杀 · 已知部分估算成本 USD',
    description:
      '仅 costStatus=estimated；官方美元刊例价，非账单，未包含套餐分摊和费用未知请求。空结果不表示免费。',
    view: 'observations',
    dimensions: [{ field: 'providedModelName' }],
    metrics: [{ measure: 'totalCost', agg: 'sum' }],
    filters: [...requests, metadata('costStatus', 'estimated')],
    chartType: 'HORIZONTAL_BAR',
  },
  counter('用量不完整请求数', '供应商未完整返回用量；token 合计仅覆盖已收到的部分。', [
    ...requests,
    metadata('usageComplete', 'false'),
  ]),
];

/** 重复执行只更新这一组同名配置；不删除用户另建的图表。 */
export async function setupDashboard(
  api: Api,
): Promise<Awaited<ReturnType<Api['dashboards']['create']>>> {
  const widgets = [];
  for (let page = 1; ; page++) {
    const result = await api.dashboardWidgets.list({ page, limit: 100 });
    widgets.push(...result.data);
    if (page >= result.meta.totalPages) break;
  }
  const placements = [];
  for (const [index, definition] of DASHBOARD_WIDGETS.entries()) {
    const matches = widgets.filter((widget) => widget.name === definition.name);
    if (matches.length > 1) throw new Error(`Langfuse 图表重名：${definition.name}`);
    const widget = matches[0]
      ? await api.dashboardWidgets.update(matches[0].id, definition)
      : await api.dashboardWidgets.create(definition);
    placements.push({
      type: 'widget' as const,
      id: widget.id,
      widgetId: widget.id,
      x: (index % 2) * 6,
      y: Math.floor(index / 2) * 6,
      width: 6,
      height: 6,
    });
  }
  const dashboards = [];
  for (let page = 1; ; page++) {
    const result = await api.dashboards.list({ page, limit: 100 });
    dashboards.push(...result.data);
    if (page >= result.meta.totalPages) break;
  }
  const definition = {
    name: '狼人杀 · 请求与成本',
    description:
      '应用记录的模型请求；不含平台托管复盘。只统计 requests-v1 新记录，排除 test。按 Session ID 筛选单局；费用未知与已知部分估算成本需一起查看。',
    filters: DASHBOARD_FILTERS,
    definition: { widgets: placements },
  };
  const matches = dashboards.filter((dashboard) => dashboard.name === definition.name);
  if (matches.length > 1) throw new Error('Langfuse 仪表盘重名');
  return matches[0]
    ? api.dashboards.update(matches[0].id, definition)
    : api.dashboards.create(definition);
}
