import { FACTIONS, type GamePlayer, type GameRosterSeat } from '@werewolf/shared';
import { Crown, Skull, UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { deathCauseName, roleName } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** 两侧镜像排布，头像、座次与身份始终靠近中央消息区。 */
export function PlayerCard({
  player,
  seat,
  side,
  active = false,
}: {
  player: GamePlayer;
  seat: GameRosterSeat | null;
  side: 'left' | 'right';
  active?: boolean;
}) {
  const dead = !player.isAlive;
  return (
    <Card
      className={cn(
        'h-full min-h-0 gap-0 py-3',
        dead && 'border-dashed',
        active && 'ring-2 ring-primary',
      )}
    >
      <CardContent
        className={cn(
          'flex h-full min-w-0 items-center gap-2 px-3',
          side === 'right' && 'flex-row-reverse',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col gap-1',
            side === 'left' ? 'items-end text-right' : 'items-start text-left',
          )}
        >
          <span
            className="max-w-full truncate text-lg font-semibold 2xl:text-xl"
            title={seat?.name}
          >
            {seat?.name ?? `${player.seatNo} 号`}
          </span>
          {seat ? (
            <span
              className="max-w-full truncate font-mono text-sm text-muted-foreground"
              title={seat.modelName}
            >
              {seat.modelName}
            </span>
          ) : null}
          {dead ? (
            <span className="text-xs text-muted-foreground">
              第 {player.deathDay} 天出局
              {player.deathCause ? ` · ${deathCauseName(player.deathCause)}` : ''}
            </span>
          ) : null}
          {active ? <span className="text-xs text-muted-foreground">正在行动</span> : null}
        </div>
        <div className="relative aspect-square h-full max-h-28 min-h-12 shrink-0">
          <Avatar
            className={cn('size-full border-2 border-primary', dead && 'border-muted-foreground')}
            aria-label={`${player.seatNo} 号头像`}
          >
            <AvatarFallback>
              <UserRound className="size-1/2" />
            </AvatarFallback>
          </Avatar>
          <span
            className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-card px-1 text-2xl leading-tight font-semibold tabular-nums"
            aria-label={`${player.seatNo} 号座位`}
          >
            {player.seatNo}
          </span>
          {player.isSheriff ? (
            <Crown
              aria-label="警长"
              className={cn(
                'absolute -top-2 size-5 text-amber-500',
                side === 'left' ? '-left-1' : '-right-1',
              )}
            />
          ) : null}
          {dead ? (
            <Skull
              aria-label={player.deathCause ? deathCauseName(player.deathCause) : '已出局'}
              className="absolute -right-1 -bottom-1 size-5 text-muted-foreground"
            />
          ) : null}
        </div>
        <span
          className={cn(
            'shrink-0 text-lg font-semibold tracking-widest [writing-mode:vertical-rl]',
            player.faction === FACTIONS.WEREWOLF
              ? 'text-red-600 dark:text-red-400'
              : player.role === 'villager'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {roleName(player.role)}
        </span>
      </CardContent>
    </Card>
  );
}
