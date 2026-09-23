import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    // 控件在调用处，靠 htmlFor 关联，静态规则看不出这层关系
    // eslint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
