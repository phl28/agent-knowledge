import { anyApi, cronJobs } from "convex/server";

const crons = cronJobs();

// See graph.ts: reference through `anyApi` (untyped) to avoid the component's
// generated api referencing itself.
const ref = anyApi as any;

// Safety net for the graph sync queue: re-drain due and stale jobs so retries
// fire even when no new writes are arriving to trigger the post-write drain.
// Referenced through `anyApi` (rather than the typed `internal`) to avoid a
// circular type reference through this module's generated api.
crons.interval("agentKnowledge graph sync retry", { minutes: 1 }, ref.graph.processPendingJobs, {
  limit: 25,
});

export default crons;
