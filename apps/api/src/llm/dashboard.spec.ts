import { randomUUID } from 'node:crypto';
import { DASHBOARD_WIDGETS, setupDashboard } from './dashboard';

it('配置中断后可补齐图表，重复执行复用仪表盘，不改动其他配置', async () => {
  type Api = Parameters<typeof setupDashboard>[0];
  type Widget = Awaited<ReturnType<Api['dashboardWidgets']['create']>>;
  type Dashboard = Awaited<ReturnType<Api['dashboards']['create']>>;
  const widgets = [
    { id: 'other', name: '其他看板图表' },
    { id: 'existing', ...DASHBOARD_WIDGETS[0] },
  ] as Widget[];
  const dashboards: Dashboard[] = [];
  const api = {
    dashboardWidgets: {
      list: jest.fn(async () => ({ data: [...widgets], meta: { totalPages: 1 } })),
      create: jest.fn(async (definition) => {
        const widget = { id: randomUUID(), ...definition };
        widgets.push(widget);
        return widget;
      }),
      update: jest.fn(async (id, definition) =>
        Object.assign(
          widgets.find((item) => item.id === id)!,
          definition,
        ),
      ),
    },
    dashboards: {
      list: jest.fn(async () => ({ data: [...dashboards], meta: { totalPages: 1 } })),
      create: jest.fn(async (definition) => {
        const dashboard = { id: randomUUID(), ...definition };
        dashboards.push(dashboard);
        return dashboard;
      }),
      update: jest.fn(async (id, definition) =>
        Object.assign(
          dashboards.find((item) => item.id === id)!,
          definition,
        ),
      ),
    },
  };
  const first = await setupDashboard(api as unknown as Api);
  const second = await setupDashboard(api as unknown as Api);
  expect(second.id).toBe(first.id);
  expect(second.definition.widgets).toHaveLength(10);
  expect(api.dashboards.create).toHaveBeenCalledTimes(1);
  expect(api.dashboardWidgets.create).toHaveBeenCalledTimes(9);
  expect(widgets[0]).toEqual({ id: 'other', name: '其他看板图表' });
  expect(api.dashboardWidgets.update.mock.calls.some(([id]) => id === 'other')).toBe(false);
});
