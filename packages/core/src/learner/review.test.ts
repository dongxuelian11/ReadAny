import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  createLearnerScheduler,
  newConceptCard,
  retrievabilityOf,
  reviewConceptCard,
} from "./review";
import type { LearnerReviewCardData } from "./types";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function at(dayOffset: number): Date {
  return new Date(NOW.getTime() + dayOffset * DAY_MS);
}

describe("FSRS review wrapper (ts-fsrs 5.4.1, fuzz disabled)", () => {
  it("creates a fresh New card", () => {
    const card = newConceptCard("concept-1", NOW);
    expect(card.conceptId).toBe("concept-1");
    expect(card.state).toBe(State.New);
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.due).toBe(NOW.getTime());
    expect(card.lastReview).toBeNull();
  });

  it("schedules a future due date after a correct review and appends a Good log", () => {
    const scheduler = createLearnerScheduler();
    const card = newConceptCard("concept-1", NOW);
    const { card: reviewed, log } = reviewConceptCard(scheduler, card, NOW, true);
    expect(log.rating).toBe(3); // Rating.Good
    expect(log.review).toBe(NOW.getTime());
    expect(reviewed.reps).toBe(1);
    expect(reviewed.lastReview).toBe(NOW.getTime());
    expect(reviewed.due).toBeGreaterThan(NOW.getTime());
    expect(reviewed.state).toBe(State.Review);
    expect(reviewed.stability).toBeGreaterThan(0);
  });

  it("maps incorrect evidence to an Again review with a lapse-capable schedule", () => {
    const scheduler = createLearnerScheduler();
    const card = newConceptCard("concept-1", NOW);
    const { card: reviewed, log } = reviewConceptCard(scheduler, card, NOW, false);
    expect(log.rating).toBe(1); // Rating.Again
    expect(reviewed.due).toBeGreaterThanOrEqual(NOW.getTime());
    expect(reviewed.due).toBeGreaterThan(NOW.getTime());
  });

  it("is deterministic for identical inputs (fuzz disabled)", () => {
    const schedulerA = createLearnerScheduler();
    const schedulerB = createLearnerScheduler();
    const a = reviewConceptCard(schedulerA, newConceptCard("c", NOW), NOW, true);
    const b = reviewConceptCard(schedulerB, newConceptCard("c", NOW), NOW, true);
    expect(a.card).toEqual(b.card);
    expect(a.log).toEqual(b.log);

    // A second review at a fixed later date is also deterministic.
    const a2 = reviewConceptCard(schedulerA, a.card, at(3), true);
    const b2 = reviewConceptCard(schedulerB, b.card, at(3), true);
    expect(a2.card).toEqual(b2.card);
  });

  it("round-trips through the storage shape without changing scheduling", () => {
    const scheduler = createLearnerScheduler();
    const first = reviewConceptCard(scheduler, newConceptCard("c", NOW), NOW, true);
    // Simulate real persistence: the card goes to storage as plain JSON.
    const stored = JSON.parse(JSON.stringify(first.card)) as LearnerReviewCardData;
    const secondDirect = reviewConceptCard(scheduler, first.card, at(2), true);
    const secondRoundTrip = reviewConceptCard(scheduler, stored, at(2), true);
    expect(secondRoundTrip.card).toEqual(secondDirect.card);
    expect(secondRoundTrip.log).toEqual(secondDirect.log);
  });

  it("pins the FSRS-6 golden first-review schedule at 0.9 retention (long-term mode)", () => {
    const scheduler = createLearnerScheduler();
    const { card, log } = reviewConceptCard(scheduler, newConceptCard("c", NOW), NOW, true);
    const scheduledDays = Math.round((card.due - NOW.getTime()) / DAY_MS);
    // FSRS-6 default weights, request_retention 0.9, Good grade, long-term
    // scheduler: first stable interval is 3 days.
    expect(scheduledDays).toBe(3);
    expect(card.state).toBe(State.Review);
    expect(card.stability).toBeCloseTo(2.3065, 4);
    expect(card.difficulty).toBeCloseTo(2.1181, 4);
    // ts-fsrs ReviewLog records the card state BEFORE the review.
    expect(log.state).toBe(State.New);
    expect(log.stability).toBe(0);
    expect(log.rating).toBe(3);
  });

  it("decays retrievability as time passes since the last review", () => {
    const scheduler = createLearnerScheduler();
    const { card } = reviewConceptCard(scheduler, newConceptCard("c", NOW), NOW, true);
    const fresh = retrievabilityOf(scheduler, card, at(0));
    const later = retrievabilityOf(scheduler, card, at(30));
    expect(fresh).not.toBeNull();
    expect(later).not.toBeNull();
    expect(later as number).toBeLessThan(fresh as number);
    expect(retrievabilityOf(scheduler, newConceptCard("c", NOW), NOW)).toBeNull();
  });

  it("rejects an out-of-range request retention (fail closed)", () => {
    expect(() => createLearnerScheduler({ requestRetention: 0 })).toThrow();
    expect(() => createLearnerScheduler({ requestRetention: 1 })).toThrow();
  });
});
