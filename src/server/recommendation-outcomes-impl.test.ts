import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DailyNutrition,
  RecommendationOutcome,
  UserProfile,
  WorkoutSession,
} from "@/lib/domain";
import { stableRecommendationId } from "@/lib/recommendation-id";

type HealthPayload = { events: RecommendationOutcome[] };

const state = vi.hoisted(() => ({
  legacy: [] as RecommendationOutcome[],
  healthByDate: new Map<string, HealthPayload>(),
  nutrition: null as DailyNutrition | null,
  sessions: [] as WorkoutSession[],
  plans: [] as any[],
  profile: {} as UserProfile,
  updateQueue: Promise.resolve() as Promise<unknown>,
}));

vi.mock("@/server/store", () => ({
  getDomainStore: vi.fn(async () => ({
    log: {
      read: vi.fn(async (_domain: string, date: string) =>
        state.legacy.filter((record) => record.date === date),
      ),
      append: vi.fn(async (_domain: string, _date: string, record: RecommendationOutcome) => {
        state.legacy.push(record);
      }),
    },
    daily: {
      get: vi.fn(async (domain: string, date: string) =>
        domain === "recommendation-outcomes-v2"
          ? (state.healthByDate.get(date) ?? null)
          : state.nutrition,
      ),
      update: vi.fn(
        async (
          _domain: string,
          date: string,
          mutate: (current: HealthPayload | null) => HealthPayload,
        ) => {
          const run = state.updateQueue.then(() => {
            const next = mutate(state.healthByDate.get(date) ?? null);
            state.healthByDate.set(date, next);
            return next;
          });
          state.updateQueue = run.catch(() => undefined);
          return run;
        },
      ),
    },
    ref: {
      get: vi.fn(async (name: string) => {
        if (name === "workout-sessions.json") return { sessions: state.sessions };
        if (name === "workout-plans.json") return { plans: state.plans };
        return state.profile;
      }),
    },
  })),
}));

import {
  completeHealthRecommendationImpl,
  loadRecommendationOutcomesImpl,
  recordRecommendationOutcomeImpl,
  transitionHealthRecommendationImpl,
} from "@/server/recommendation-outcomes-impl";

const DATE = "2026-07-15";
const TEXT = "Choose today’s workout";
const ID = stableRecommendationId(DATE, "health-next-action", TEXT);

function accepted(overrides: Partial<RecommendationOutcome> = {}): RecommendationOutcome {
  return {
    id: ID,
    date: DATE,
    source: "health-next-action",
    text: TEXT,
    status: "accepted",
    health: { actionType: "choose-workout", criterion: "choose-workout" },
    recordedAt: 1,
    ...overrides,
  };
}

function transitionInput() {
  return {
    id: ID,
    date: DATE,
    text: TEXT,
    status: "accepted" as const,
    actionType: "choose-workout" as const,
    criterion: "choose-workout" as const,
  };
}

function session(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: "session-1",
    createdAt: Date.now() + 1,
    performedAt: Date.now() + 1,
    notes: "Quick workout",
    exercises: [],
    ...overrides,
  };
}

describe("recommendation outcome health contract", () => {
  beforeEach(() => {
    state.legacy = [];
    state.healthByDate = new Map();
    state.nutrition = null;
    state.sessions = [];
    state.plans = [];
    state.profile = {} as UserProfile;
    state.updateQueue = Promise.resolve();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("stores Health transitions in v2 while generic outcomes remain legacy", async () => {
    await transitionHealthRecommendationImpl(transitionInput());
    expect(state.legacy).toEqual([]);
    expect(state.healthByDate.get(DATE)?.events).toHaveLength(1);

    await recordRecommendationOutcomeImpl({
      id: "generic-1",
      date: DATE,
      source: "coach-daily",
      text: "Take a walk",
      status: "dismissed",
    });
    expect(state.legacy).toHaveLength(1);
  });

  it("merges legacy and v2 records and dedupes exact events", async () => {
    const event = accepted();
    state.legacy = [event];
    state.healthByDate.set(DATE, { events: [event, accepted({ recordedAt: 2 })] });
    await expect(loadRecommendationOutcomesImpl([DATE])).resolves.toEqual([
      event,
      accepted({ recordedAt: 2 }),
    ]);
  });

  it("serializes concurrent initial transitions inside CAS", async () => {
    const [first, second] = await Promise.all([
      transitionHealthRecommendationImpl(transitionInput()),
      transitionHealthRecommendationImpl(transitionInput()),
    ]);
    expect(second).toEqual(first);
    expect(state.healthByDate.get(DATE)?.events).toHaveLength(1);
  });

  it("enforces legacy latest state and terminal lifecycle inside CAS", async () => {
    state.legacy = [accepted()];
    await expect(transitionHealthRecommendationImpl(transitionInput())).resolves.toEqual(
      state.legacy[0],
    );
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), status: "dismissed" }),
    ).rejects.toThrow("not allowed");

    state.legacy = [accepted({ status: "snoozed" })];
    await expect(transitionHealthRecommendationImpl(transitionInput())).rejects.toThrow(
      "not allowed",
    );
  });

  it("rejects forged initial transition identity and metadata", async () => {
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), id: "forged" }),
    ).rejects.toThrow("does not match");
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), text: "Forged text" }),
    ).rejects.toThrow("does not match");
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), actionType: "log-meal" }),
    ).rejects.toThrow("does not match");
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), criterion: "hydration" }),
    ).rejects.toThrow("does not match");
    await expect(
      transitionHealthRecommendationImpl({ ...transitionInput(), targetTitle: "Forged target" }),
    ).rejects.toThrow("does not match");
  });

  it("keeps generic outcome writes from bypassing the Health lifecycle", async () => {
    await expect(recordRecommendationOutcomeImpl(accepted())).rejects.toThrow(
      "specialized transition endpoint",
    );
  });

  it("serializes concurrent completion and repeats idempotently", async () => {
    state.healthByDate.set(DATE, { events: [accepted()] });
    state.sessions = [session()];
    const input = {
      id: ID,
      date: DATE,
      actionType: "choose-workout" as const,
      evidence: { kind: "workout-session" as const, sessionId: "session-1" },
    };
    const [first, second] = await Promise.all([
      completeHealthRecommendationImpl(input),
      completeHealthRecommendationImpl(input),
    ]);
    expect(first.status).toBe("completed");
    expect(second).toEqual(first);
    expect(state.healthByDate.get(DATE)?.events).toHaveLength(2);
  });

  it("rejects workout evidence recorded before acceptance", async () => {
    state.healthByDate.set(DATE, { events: [accepted({ recordedAt: Date.now() })] });
    state.sessions = [session({ performedAt: Date.now() - 1 })];
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "choose-workout",
        evidence: { kind: "workout-session", sessionId: "session-1" },
      }),
    ).rejects.toThrow("workout evidence");
  });

  it("rejects meal evidence recorded before acceptance", async () => {
    state.healthByDate.set(DATE, {
      events: [
        accepted({
          health: { actionType: "log-meal", criterion: "protein-gap" },
          recordedAt: Date.now(),
        }),
      ],
    });
    state.nutrition = {
      id: "nutrition",
      createdAt: 1,
      date: DATE,
      totals: { calories: 100, protein: 10, carbs: 10, fat: 1 },
      mealLogs: [
        {
          id: "meal-1",
          createdAt: 1,
          timestamp: Date.now() - 1,
          foodItems: [
            {
              id: "food-1",
              name: "Eggs",
              quantity: 1,
              unit: "serving",
              source: "user",
              macros: { calories: 100, protein: 10, carbs: 1, fat: 6 },
            },
          ],
        },
      ],
    };
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "log-meal",
        evidence: { kind: "meal", mealId: "meal-1" },
      }),
    ).rejects.toThrow("meal evidence");
  });

  it("accepts a post-acceptance meal without protein for meal timing", async () => {
    const acceptedAt = Date.now();
    state.healthByDate.set(DATE, {
      events: [
        accepted({
          text: "Log your latest meal",
          health: { actionType: "log-meal", criterion: "meal-timing" },
          recordedAt: acceptedAt,
        }),
      ],
    });
    state.nutrition = {
      id: "nutrition",
      createdAt: 1,
      date: DATE,
      totals: { calories: 50, protein: 0, carbs: 12, fat: 0 },
      mealLogs: [
        {
          id: "meal-1",
          createdAt: acceptedAt + 1,
          timestamp: acceptedAt + 1,
          foodItems: [
            {
              id: "food-1",
              name: "Fruit",
              quantity: 1,
              unit: "serving",
              source: "user",
              macros: { calories: 50, protein: 0, carbs: 12, fat: 0 },
            },
          ],
        },
      ],
    };
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "log-meal",
        evidence: { kind: "meal", mealId: "meal-1" },
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects cross-intent evidence and yesterday workout sessions", async () => {
    state.healthByDate.set(DATE, {
      events: [accepted({ health: { actionType: "log-meal", criterion: "protein-gap" } })],
    });
    state.sessions = [session()];
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "log-meal",
        evidence: { kind: "workout-session", sessionId: "session-1" },
      }),
    ).rejects.toThrow("does not match");

    state.healthByDate.set(DATE, { events: [accepted()] });
    state.sessions = [session({ performedAt: new Date("2026-07-14T16:00:00Z").getTime() })];
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "choose-workout",
        evidence: { kind: "workout-session", sessionId: "session-1" },
      }),
    ).rejects.toThrow("today");
  });

  it("requires planned title match for start-workout", async () => {
    state.healthByDate.set(DATE, {
      events: [
        accepted({
          text: "Upper body",
          health: {
            actionType: "start-workout",
            criterion: "planned-workout",
            targetTitle: "Upper body",
          },
        }),
      ],
    });
    state.sessions = [session()];
    await expect(
      completeHealthRecommendationImpl({
        id: ID,
        date: DATE,
        actionType: "start-workout",
        evidence: { kind: "workout-session", sessionId: "session-1" },
      }),
    ).rejects.toThrow("planned target");
  });
});
