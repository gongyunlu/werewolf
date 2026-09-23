import type { GameEvent } from '@werewolf/shared';
import type { ReactNode } from 'react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { eventKindName } from '@/lib/labels';
import { RadioIcon } from 'lucide-react';
import { SpeakerLabel } from './SpeakerLabel';

export function SceneRow({
  event,
  children,
  speakerName,
  privateResult = false,
}: {
  event: GameEvent;
  children?: ReactNode;
  speakerName?: string;
  privateResult?: boolean;
}) {
  // 台账正文用于模型上下文，观战把系统添加的说话人前缀移到气泡标题。
  const speech = ['public_speech', 'wolf_speech'].includes(event.kind)
    ? /^(\d+) 号(?:商议)?发言：([\s\S]*)$/.exec(event.text)
    : null;
  if (event.kind === 'system')
    return (
      <div
        className="flex gap-2.5 rounded-lg border border-dashed bg-muted/25 px-3 py-2.5 text-sm leading-relaxed"
        role="note"
      >
        <RadioIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <span className="mr-2 text-xs font-medium text-muted-foreground">
            {privateResult ? '技能信息' : '法官'}
          </span>
          {event.text}
        </div>
      </div>
    );
  return (
    <Message>
      <MessageContent>
        <MessageHeader>
          {speech ? (
            <SpeakerLabel
              seatNo={Number(speech[1])}
              name={speakerName}
              action={eventKindName(event.kind)}
            />
          ) : (
            eventKindName(event.kind)
          )}
        </MessageHeader>
        {children}
        <Bubble variant="secondary" className="max-w-full">
          <BubbleContent className="whitespace-pre-wrap wrap-anywhere">
            {speech ? speech[2] : event.text}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
