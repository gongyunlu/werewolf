import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentMemories, replaceAgentMemories } from '@/lib/api-client';
import { PersonaStrategyPanel } from './PersonaStrategyPanel';

vi.mock('@/lib/api-client', () => ({ fetchAgentMemories: vi.fn(), replaceAgentMemories: vi.fn() }));

const memories = { persona: [{ title: '谨慎', body: '先听再说' }], strategy: [] };

describe('人设与策略编辑', () => {
  afterEach(() => vi.resetAllMocks());

  it('加载失败时禁止保存，避免把现有内容覆盖为空', async () => {
    vi.mocked(fetchAgentMemories).mockRejectedValue(new Error('读取失败'));
    render(<PersonaStrategyPanel agentId="a1" />);
    expect(await screen.findByText('读取失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(replaceAgentMemories).not.toHaveBeenCalled();
  });

  it('已有条目改成不完整时提示错误并保留草稿，不静默删除', async () => {
    vi.mocked(fetchAgentMemories).mockResolvedValue({ memories });
    render(<PersonaStrategyPanel agentId="a1" />);
    const title = await screen.findByDisplayValue('谨慎');
    await userEvent.clear(title);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('标题不能为空')).toBeInTheDocument();
    expect(screen.getByLabelText('人设正文')).toHaveValue('先听再说');
    expect(replaceAgentMemories).not.toHaveBeenCalled();
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();
  });

  it('完整内容按原顺序保存', async () => {
    vi.mocked(fetchAgentMemories).mockResolvedValue({ memories });
    vi.mocked(replaceAgentMemories).mockResolvedValue({ memories });
    render(<PersonaStrategyPanel agentId="a1" />);
    await screen.findByDisplayValue('谨慎');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(replaceAgentMemories).toHaveBeenCalledWith('a1', memories));
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });
});
