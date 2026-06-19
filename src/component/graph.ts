import { v } from "convex/values";
import { anyApi } from "convex/server";
import { internalAction } from "./_generated/server.js";
import { MAX_ATTEMPTS, backoffMs, neo4jHttpFromEnv, runSyncJob } from "./neo4j.js";

// Cross-function references go through `anyApi` (what the generated `internal`
// resolves to at runtime) rather than the typed `internal` to avoid a circular
// type reference through this module's own generated api.
const ref = anyApi as any;

const DRAIN_BATCH = 25;

// Drain due graph sync jobs against Neo4j. Triggered after each write that
// enqueues a job, by a self-reschedule when a batch fills, and by the retry
// cron as a safety net. Retry/backoff and dead-lettering policy live in neo4j.ts.
export const processPendingJobs = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ succeeded: v.number(), failed: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? DRAIN_BATCH;
    const http = neo4jHttpFromEnv();
    const claimed = await ctx.runMutation(ref.mutations.claimGraphSyncJobs, { limit });

    let succeeded = 0;
    let failed = 0;
    for (const job of claimed) {
      try {
        await runSyncJob(http, job);
        await ctx.runMutation(ref.mutations.completeGraphSyncJob, { jobId: job.jobId });
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.runMutation(ref.mutations.completeGraphSyncJob, {
          jobId: job.jobId,
          error: message,
          ...(job.attempts >= MAX_ATTEMPTS
            ? {}
            : { retryAt: Date.now() + backoffMs(job.attempts) }),
        });
        failed += 1;
      }
    }

    if (claimed.length >= limit) {
      await ctx.scheduler.runAfter(0, ref.graph.processPendingJobs, { limit });
    }
    return { succeeded, failed };
  },
});
