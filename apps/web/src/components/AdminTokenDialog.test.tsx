import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { storedAdminToken } from '@/lib/admin-token';
import { AdminTokenDialog } from './AdminTokenDialog';

describe('管理令牌弹窗', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('填了令牌保存就落在本机，下次打开带出来', async () => {
    const view = render(<AdminTokenDialog open onOpenChange={() => {}} />);

    await userEvent.type(screen.getByLabelText('令牌'), 'sk-admin');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(storedAdminToken()).toBe('sk-admin');
    expect(screen.getByText('已存在本机。')).toBeInTheDocument();

    // 关掉再开一份新的：填过的值还在，不必每次重敲。
    view.rerender(<AdminTokenDialog open={false} onOpenChange={() => {}} />);
    view.rerender(<AdminTokenDialog open onOpenChange={() => {}} />);

    expect(screen.getByLabelText('令牌')).toHaveValue('sk-admin');
  });

  it('清空再保存就是把本机那把撤掉', async () => {
    localStorage.setItem('werewolf:admin-token', 'sk-admin');
    render(<AdminTokenDialog open onOpenChange={() => {}} />);

    await userEvent.clear(screen.getByLabelText('令牌'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(storedAdminToken()).toBe('');
    // 撤掉了就不能再说「已存在本机」，跟实际正好相反。
    expect(screen.getByText('已从本机撤掉。')).toBeInTheDocument();
  });
});
