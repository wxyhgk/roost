import type { ResumePlan } from '../../shared/api/session';
import { ApiError } from '../../shared/api/errors';

export type ResumePlanState = {
  plan: ResumePlan | null;
  loading: boolean;
  failed: boolean;
  retrying: boolean;
};
const empty: ResumePlanState = { plan: null, loading: false, failed: false, retrying: false };
const delays = [2000, 4000, 8000];
const transient = new Set(['identity_syncing', 'source_unavailable', 'no_conversation']);

/** Only reads are retried. Each activation/manual check has a finite budget. */
export function createResumePlanQuery(read: (signal: AbortSignal) => Promise<ResumePlan>) {
  let state = empty, active = false, generation = 0, attempt = 0;
  let flight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ResumePlanState) => { state = next; for (const listener of listeners) listener(); };
  const cancel = () => {
    generation++;
    clearTimeout(timer); clearTimeout(deadline);
    flight?.abort(); flight = null;
  };
  const check = () => {
    if (!active || flight) return;
    clearTimeout(timer);
    const token = ++generation, abort = new AbortController();
    flight = abort;
    attempt++;
    publish({ ...state, plan: state.plan?.available ? null : state.plan, loading: true, retrying: false });
    const finish = (plan: ResumePlan | null, failed: boolean, canRetry: boolean) => {
      if (!active || token !== generation) return;
      // Fence even transports that resolve after abort/timeout.
      generation++;
      clearTimeout(deadline); flight = null;
      const retrying = canRetry && attempt <= delays.length;
      publish({ plan, failed, loading: false, retrying });
      if (retrying) timer = setTimeout(check, delays[attempt - 1]);
    };
    deadline = setTimeout(() => { finish(null, true, true); abort.abort(); }, 15000);
    void Promise.resolve().then(() => read(abort.signal)).then(
      plan => finish(plan, false, !plan.available && transient.has(plan.reason)),
      error => finish(null, true, !(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429),
    );
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setActive(next: boolean) {
      if (active === next) return;
      active = next; cancel(); attempt = 0; publish(empty);
      if (active) check();
    },
    refresh() {
      if (!active || flight) return;
      cancel(); attempt = 0; publish(empty); check();
    },
  };
}
