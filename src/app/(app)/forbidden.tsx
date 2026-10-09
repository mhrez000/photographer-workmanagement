/**
 * 403 inside the app shell (sidebar + topbar stay visible). Pages and segment
 * layouts call forbidden() via guard(); src/app/forbidden.tsx remains the
 * fallback for anything outside the (app) group.
 */
export { default, metadata } from "../forbidden";
