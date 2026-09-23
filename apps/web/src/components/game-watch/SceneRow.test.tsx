import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionRow } from './ActionRow';
import { SceneRow } from './SceneRow';

describe('行动正文与过程', () => {
  it('先显示身份和计时展开栏，再显示唯一的正式正文', () => {
    render(
      <SceneRow
        event={{
          seq: 1,
          day: 1,
          kind: 'public_speech',
          text: '3 号发言：正式发言',
          audience: ['p3'],
        }}
        speakerName="阿六"
      >
        <ActionRow
          gameId="g1"
          inline
          action={{
            actionKey: 'a1',
            day: 1,
            seatNo: 3,
            actionType: 'speech',
            role: '预言家',
            task: '发言',
            decision: '正式发言',
            ledgerSeq: 0,
            hasReasoning: true,
            phase: 'day',
            eventSeq: 1,
            thinkingMs: 59000,
          }}
        />
      </SceneRow>,
    );
    expect(screen.getByText('阿六 · 3 号 · 公开发言')).toBeInTheDocument();
    const process = screen.getByRole('button', { name: /思考用时 59 秒/ });
    const content = screen.getByText('正式发言');
    expect(
      process.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText('正式发言')).toHaveLength(1);
    expect(screen.queryByText(/3 号发言：/)).toBeNull();
  });
});
