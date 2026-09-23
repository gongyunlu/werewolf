import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LiveAction } from '@/lib/preview';
import { LiveActionRow } from './ActionRow';

describe('发言过程', () => {
  it('流式首稿明确标为未发布，复核时折叠首稿，修订仍属于草稿', async () => {
    const action: LiveAction = {
      actionKey: 'speech-1',
      day: 1,
      seatNo: 1,
      actionType: 'speech',
      steps: [
        { id: 'g1', name: 'generate', status: 'running', content: '首稿内容', reasoning: null },
      ],
    };
    const view = render(<LiveActionRow action={action} stopped={false} />);
    expect(screen.getByText('首稿内容')).toBeInTheDocument();
    expect(screen.getByText('发言草稿（未发布）')).toBeInTheDocument();

    view.rerender(
      <LiveActionRow
        action={{
          ...action,
          steps: [
            { ...action.steps[0], status: 'completed' },
            { id: 'c1', name: 'critique', status: 'running', content: '', reasoning: null },
          ],
        }}
        stopped={false}
      />,
    );
    expect(screen.queryByText('首稿内容')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '发言草稿（过程记录）' }));
    expect(screen.getByText('首稿内容')).toBeInTheDocument();

    view.rerender(
      <LiveActionRow
        action={{
          ...action,
          steps: [
            { id: 'r1', name: 'revise', status: 'running', content: '修订内容', reasoning: null },
          ],
        }}
        stopped={false}
      />,
    );
    expect(screen.getByText('修订稿（未发布）')).toBeInTheDocument();
    expect(screen.getByText('修订内容')).toBeInTheDocument();
  });
});
