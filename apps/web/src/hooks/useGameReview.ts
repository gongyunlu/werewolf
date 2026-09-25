import type { ReviewPreview, ReviewResponse } from '@werewolf/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchReview, fetchReviewPreview, startReview } from '@/lib/api-client';
import { errorMessage } from '@/lib/http';

export const reviewIsRunning = (status: string) =>
  ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'].includes(status);

export function useGameReview(gameId: string) {
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [revision, setRevision] = useState(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchReviewPreview(gameId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setPreview(value);
        setPreviewError(null);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setPreviewError(errorMessage(failure));
      });
    return () => controller.abort();
    // revision 由刷新按钮递增，需要重新读取覆盖范围。
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [gameId, revision]);

  useEffect(() => {
    if (submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      let poll = false;
      try {
        const value = await fetchReview(gameId, controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setReadError(null);
        poll = reviewIsRunning(value.status);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setReadError(errorMessage(failure));
        poll = true;
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (poll) timer = setTimeout(() => void load(), 5000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // 提交结束和手动刷新都会重新向服务端确认状态。
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [gameId, revision, submitting]);

  const canStart =
    !!preview &&
    !previewError &&
    !readError &&
    !loading &&
    !submitting &&
    !!data &&
    ['not_started', 'failed', 'interrupted'].includes(data.status);

  const start = async () => {
    if (submittingRef.current || !canStart) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await startReview(gameId);
      setData((current) =>
        current ? { ...current, status: result.status, failure: null } : current,
      );
    } catch (failure) {
      setSubmitError(errorMessage(failure));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return {
    preview,
    data,
    loading,
    submitting,
    canStart,
    readError,
    previewError,
    submitError,
    start,
    refresh: () => setRevision((current) => current + 1),
  };
}
