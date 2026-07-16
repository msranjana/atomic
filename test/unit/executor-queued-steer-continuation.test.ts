import { describe } from "bun:test";
import {
    assert, createStageControlRegistry, createStore, deferred, makeSmartSession,
    mockSession, RESUME_CONTINUATION_PROMPT, run, test, waitForPromptCall, workflow,
    type StageSessionRuntime, type WorkflowDefinition,
} from "./executor-shared.js";

interface QueuedMessageRecorder {
    readonly promptCalls: string[];
    readonly steerCalls: string[];
    readonly followUpCalls: string[];
}

type StreamingTurnSession = StageSessionRuntime & { finishTurn(): void };

function newRecorder(): QueuedMessageRecorder {
    return { promptCalls: [], steerCalls: [], followUpCalls: [] };
}

/**
 * A stage session whose non-continuation prompts stay "streaming" until the
 * test resolves them via finishTurn() (or rejects them via abort()).
 */
function streamingTurnSession(recorder: QueuedMessageRecorder): StreamingTurnSession {
    let streaming = false;
    let resolveTurn: (() => void) | undefined;
    let rejectTurn: ((error: Error) => void) | undefined;
    return {
        ...mockSession(),
        get isStreaming() { return streaming; },
        async prompt(text: string) {
            recorder.promptCalls.push(text);
            if (text === RESUME_CONTINUATION_PROMPT) return;
            streaming = true;
            try {
                await new Promise<void>((resolve, reject) => {
                    resolveTurn = resolve;
                    rejectTurn = reject;
                });
            } finally {
                streaming = false;
            }
        },
        async steer(text: string) { recorder.steerCalls.push(text); },
        async followUp(text: string) { recorder.followUpCalls.push(text); },
        async abort() {
            const reject = rejectTurn;
            resolveTurn = undefined;
            rejectTurn = undefined;
            reject?.(new Error("AbortError"));
        },
        getLastAssistantText() { return "assistant"; },
        finishTurn() {
            const resolve = resolveTurn;
            resolveTurn = undefined;
            rejectTurn = undefined;
            resolve?.();
        },
    };
}

function singleStageWorkflow(name: string): WorkflowDefinition {
    return workflow({
        name,
        description: "",
        inputs: {},
        outputs: {},
        run: async (ctx) => {
            await ctx.stage("worker").prompt("go");
            return {};
        },
    });
}

async function runStreamingStage(input: {
    readonly workflowName: string;
    readonly session: StreamingTurnSession;
    readonly recorder: QueuedMessageRecorder;
    readonly signal?: AbortSignal;
}): Promise<{
    runPromise: ReturnType<typeof run>;
    handle: NonNullable<ReturnType<ReturnType<typeof createStageControlRegistry>["get"]>>;
}> {
    const registry = createStageControlRegistry();
    const sawStage = deferred<{ runId: string; stageId: string }>();
    let sawStageResolved = false;
    const runPromise = run(singleStageWorkflow(input.workflowName), {}, {
        adapters: {
            agentSession: {
                async create() { return input.session; },
            },
        },
        store: createStore(),
        stageControlRegistry: registry,
        onStageStart: (runId, stage) => {
            if (!sawStageResolved) {
                sawStageResolved = true;
                sawStage.resolve({ runId, stageId: stage.id });
            }
        },
        confirmStageReadiness: async () => true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    const { runId, stageId } = await sawStage.promise;
    await waitForPromptCall(input.recorder.promptCalls, "go");
    const handle = registry.get(runId, stageId);
    assert.ok(handle, "stage handle should be registered");
    assert.equal(handle.isStreaming, true);
    return { runPromise, handle };
}

describe("executor — queued steer/follow-up resume continuation", () => {
    test("steer during a streaming turn injects exactly one continuation prompt after the turn ends", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-steer-continuation-wf",
            session,
            recorder,
        });

        await handle.steer("focus on the tests");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.steerCalls, ["focus on the tests"]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("follow-up during a streaming turn injects exactly one continuation prompt after the turn ends", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-follow-up-continuation-wf",
            session,
            recorder,
        });

        await handle.followUp("also update the changelog");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.followUpCalls, ["also update the changelog"]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("multiple queued messages in one turn still inject exactly one continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-multiple-continuation-wf",
            session,
            recorder,
        });

        await handle.steer("first correction");
        await handle.steer("second correction");
        await handle.followUp("and a follow-up");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.steerCalls, ["first correction", "second correction"]);
        assert.deepEqual(recorder.followUpCalls, ["and a follow-up"]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("no queued message means no continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise } = await runStreamingStage({
            workflowName: "queued-none-continuation-wf",
            session,
            recorder,
        });

        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.promptCalls, ["go"]);
    });

    test("aborted run suppresses the queued-steer continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const controller = new AbortController();
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-steer-aborted-wf",
            session,
            recorder,
            signal: controller.signal,
        });

        await handle.steer("steer before kill");
        controller.abort();

        const result = await runPromise;
        assert.equal(result.status, "killed");
        assert.deepEqual(recorder.steerCalls, ["steer before kill"]);
        assert.equal(recorder.promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
    });

    test("steering an idle stage between turns does not arm a continuation", async () => {
        const events: string[] = [];
        const steerCalls: string[] = [];
        const registry = createStageControlRegistry();
        const def = workflow({
            name: "queued-idle-steer-wf",
            description: "",
            inputs: {},
            outputs: {},
            run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                return {};
            },
        });
        const decisions = [false]; // first gate: stay, hand control to the user
        let gi = 0;
        const result = await run(def, {}, {
            adapters: {
                agentSession: {
                    async create() {
                        return {
                            ...makeSmartSession(events)(),
                            async steer(text: string) { steerCalls.push(text); },
                        };
                    },
                },
            },
            store: createStore(),
            stageControlRegistry: registry,
            confirmStageReadiness: async ({ runId, stageId }) => {
                const advance = decisions[gi++] ?? true;
                if (!advance) {
                    // The user steers the idle stage while the readiness gate
                    // holds it, then sends a fresh composer turn.
                    setTimeout(() => {
                        void (async () => {
                            const handle = registry.get(runId, stageId);
                            if (!handle) return;
                            await handle.steer("idle steer");
                            await handle.prompt("follow-up");
                        })();
                    }, 0);
                }
                return advance;
            },
        });

        assert.equal(result.status, "completed");
        assert.deepEqual(steerCalls, ["idle steer"]);
        // No `turn:${RESUME_CONTINUATION_PROMPT}` entry: an idle steer must not
        // arm the continuation flag that drains after the user's next turn.
        assert.deepEqual(events, ["ask", "turn:follow-up"]);
    });

    test("fail-fast finalized stage suppresses the queued-steer continuation prompt", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawSlowStage = deferred<{ runId: string; stageId: string }>();
        let sawSlowStageResolved = false;
        const releaseFailure = deferred();
        const promptCalls: string[] = [];
        const steerCalls: string[] = [];
        const makeSession = (): StageSessionRuntime => {
            let currentResolve: (() => void) | undefined;
            let currentIdle = Promise.resolve();
            let streaming = false;
            return {
                ...mockSession(),
                get isStreaming() { return streaming; },
                async prompt(text: string) {
                    promptCalls.push(text);
                    if (text === "fail") {
                        await releaseFailure.promise;
                        throw new Error("boom");
                    }
                    if (text === RESUME_CONTINUATION_PROMPT) return;
                    streaming = true;
                    currentIdle = new Promise<void>((resolve) => { currentResolve = resolve; });
                    try {
                        await currentIdle;
                    } finally {
                        streaming = false;
                    }
                },
                async steer(text: string) { steerCalls.push(text); },
                async closeWorkflowStageGeneration() { await currentIdle; },
                async abort() {
                    const resolve = currentResolve;
                    currentResolve = undefined;
                    resolve?.();
                },
                getLastAssistantText() { return "assistant"; },
            };
        };
        const def = workflow({
            name: "queued-steer-fail-fast-wf",
            description: "",
            inputs: {},
            outputs: {},
            run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "slow", prompt: "slow" },
                        { name: "fail", prompt: "fail" },
                    ],
                    { concurrency: 2, failFast: true },
                );
                return {};
            },
        });

        const runPromise = run(def, {}, {
            adapters: {
                agentSession: {
                    async create() { return makeSession(); },
                },
            },
            store,
            stageControlRegistry: registry,
            onStageStart: (runId, stage) => {
                if (stage.name === "slow" && !sawSlowStageResolved) {
                    sawSlowStageResolved = true;
                    sawSlowStage.resolve({ runId, stageId: stage.id });
                }
            },
            confirmStageReadiness: async () => true,
        });

        const { runId, stageId } = await sawSlowStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "slow stage handle should be registered");
        await waitForPromptCall(promptCalls, "slow");
        await handle.steer("steer before fail-fast");
        releaseFailure.resolve();

        const result = await runPromise;
        assert.equal(result.status, "failed");
        assert.deepEqual(steerCalls, ["steer before fail-fast"]);
        assert.equal(promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
        const slow = store.runs()[0]?.stages.find((stage) => stage.name === "slow");
        assert.equal(slow?.status, "skipped");
        assert.equal(slow?.skippedReason, "fail-fast");
    });
});
