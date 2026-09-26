import type {
  ExperienceSnapshot,
  ExperienceSource,
  ExperienceGenerationResponse,
} from '@werewolf/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { fetchExperienceSources } from '@/lib/experience-api';
import { errorMessage } from '@/lib/http';
import { roleName } from '@/lib/labels';

export function ExperienceCard({
  experience,
  children,
}: {
  experience: ExperienceSnapshot;
  children?: ReactNode;
}) {
  const [sources, setSources] = useState<ExperienceSource[] | null>(null);
  const [generation, setGeneration] = useState<ExperienceGenerationResponse['generation']>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchExperienceSources(experience.generationId);
      setGeneration(data.generation);
      setSources(
        data.generation?.sources.filter((item) => experience.sourceIds.includes(item.id)) ?? [],
      );
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {experience.title}{' '}
          <span className="text-xs text-muted-foreground">v{experience.version}</span>
        </CardTitle>
        <CardDescription>
          {experience.boardId} · {roleName(experience.role)}
          <br />
          来源参赛者：{experience.agentName ?? experience.agentId}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="whitespace-pre-wrap wrap-anywhere">{experience.body}</p>
        <p className="text-sm text-muted-foreground">适用条件：{experience.conditions}</p>
        {sources?.map((source) => (
          <div key={source.id} className="text-xs text-muted-foreground">
            <p>
              {source.perspective === 'at_action'
                ? '对应行动当时的记录，不代表更早已知'
                : '赛后材料，不代表当时或出局后已知'}
            </p>
            <pre className="whitespace-pre-wrap wrap-anywhere">
              {JSON.stringify(source.value, null, 2)}
            </pre>
          </div>
        ))}
        {sources && generation ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p>
              生成记录：{generation.id} · 复盘版本：{generation.reviewVersion}
            </p>
            {generation.prompts?.map((prompt) => (
              <p key={prompt.name}>
                {prompt.name} ·{' '}
                {prompt.source === 'platform' ? `平台 v${prompt.version}` : '本地模板'}
              </p>
            ))}
            {generation.calls.map((call) => (
              <p key={call.callId}>
                调用 {call.callId} · {call.status}
              </p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        <Link className="text-sm underline" to={`/games/${experience.sourceGameId}?view=review`}>
          来源对局与复盘
        </Link>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => (sources ? setSources(null) : void load())}
        >
          {loading ? '读取来源…' : sources ? '收起来源证据' : '来源证据'}
        </Button>
        {children}
      </CardFooter>
    </Card>
  );
}
