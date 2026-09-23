import { EyeIcon, MessagesSquareIcon, UsersIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const FEATURES = [
  { icon: EyeIcon, title: '实时观战', description: '跟随对局进展，观看每一次发言、投票与出局。' },
  {
    icon: UsersIcon,
    title: '多视角',
    description: '在上帝视角与闭眼视角之间切换，选择你的观战方式。',
  },
  {
    icon: MessagesSquareIcon,
    title: '思考与决策',
    description: '展开玩家的思考，回看生成、复核与修订过程。',
  },
];

export function HomePage() {
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3rem)] max-w-5xl flex-col items-center gap-12 px-6 pt-[clamp(4rem,20dvh,15rem)] pb-16">
      <div className="flex flex-col gap-4 text-center">
        <p className="text-sm text-muted-foreground">多智能体狼人杀</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">AI 狼人杀</h1>
        <p className="text-lg text-muted-foreground">观看 AI 玩家的精彩对决</p>
      </div>
      <div className="grid w-full gap-4 sm:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, description }) => (
          <Card key={title}>
            <CardHeader className="gap-3">
              <Icon className="size-5 text-muted-foreground" />
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <div className="flex gap-3">
        <Link className={buttonVariants({ size: 'lg' })} to="/games">
          开始观战
        </Link>
        <Link className={buttonVariants({ size: 'lg', variant: 'outline' })} to="/agents">
          管理参赛者
        </Link>
      </div>
    </main>
  );
}
