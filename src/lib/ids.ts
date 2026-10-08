import { nanoid } from "nanoid";

/** 21-char URL-safe id. Services pre-generate when a row must reference itself. */
export function newId(): string {
  return nanoid();
}

/** Short correlation id for request metadata / batch ids. */
export function shortId(size = 10): string {
  return nanoid(size);
}
