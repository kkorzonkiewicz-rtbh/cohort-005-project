import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getHoursWatched } from "./hours-watched.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function addLesson(courseId: number) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  return testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function watch(learnerId: number, lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: learnerId,
      lessonId,
      eventType: "pause",
      positionSeconds,
    })
    .run();
}

describe("getHoursWatched", () => {
  it("is zero when the learner has not watched anything", () => {
    expect(getHoursWatched(testDb, base.user.id, base.course.id)).toBe(0);
  });

  it("counts only the furthest position reached in a lesson", () => {
    const lesson = addLesson(base.course.id);
    watch(base.user.id, lesson.id, 1800);
    watch(base.user.id, lesson.id, 3600);
    watch(base.user.id, lesson.id, 900);

    expect(getHoursWatched(testDb, base.user.id, base.course.id)).toBe(1);
  });

  it("adds up the furthest positions across the course's lessons", () => {
    const first = addLesson(base.course.id);
    const second = addLesson(base.course.id);
    watch(base.user.id, first.id, 3600);
    watch(base.user.id, second.id, 1800);

    expect(getHoursWatched(testDb, base.user.id, base.course.id)).toBe(1.5);
  });

  it("ignores what other learners watched", () => {
    const lesson = addLesson(base.course.id);
    watch(base.user.id, lesson.id, 1800);
    watch(base.instructor.id, lesson.id, 7200);

    expect(getHoursWatched(testDb, base.user.id, base.course.id)).toBe(0.5);
  });

  it("ignores lessons from another course", () => {
    const otherCourse = testDb
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "Another course",
        salesCopy: "## Other Course",
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const lesson = addLesson(base.course.id);
    const otherLesson = addLesson(otherCourse.id);
    watch(base.user.id, lesson.id, 1800);
    watch(base.user.id, otherLesson.id, 7200);

    expect(getHoursWatched(testDb, base.user.id, base.course.id)).toBe(0.5);
  });
});
