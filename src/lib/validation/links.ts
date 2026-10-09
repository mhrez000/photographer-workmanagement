/**
 * Zod schemas + pure helpers for external job links (ARCHITECTURE.md §2.4,
 * §3.3): http/https only, no embedded credentials, provider derived from the
 * hostname. Pure module (safe for client components).
 */
import { z } from "zod";
import { ALLOWED_URL_PROTOCOLS, LINK_KINDS, type LinkProvider } from "@/lib/constants";

export const LINK_URL_MAX = 2048;
export const LINK_LABEL_MAX = 200;
export const LINK_REASON_MAX = 500;

const Id = z.string().trim().min(1).max(64);

/** Parses `raw` as an absolute URL; null when invalid. */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** True for absolute http(s) URLs with a host and without embedded credentials. */
export function isAllowedLinkUrl(raw: string): boolean {
  const url = parseUrl(raw.trim());
  if (!url) return false;
  if (!(ALLOWED_URL_PROTOCOLS as readonly string[]).includes(url.protocol)) return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  return true;
}

const PROVIDER_HOSTS: readonly { provider: LinkProvider; hosts: readonly string[] }[] = [
  { provider: "drive", hosts: ["drive.google.com", "docs.google.com", "photos.google.com", "photos.app.goo.gl"] },
  { provider: "dropbox", hosts: ["dropbox.com", "db.tt", "dropboxusercontent.com"] },
  { provider: "onedrive", hosts: ["onedrive.live.com", "1drv.ms", "sharepoint.com", "onedrive.com"] },
  { provider: "frameio", hosts: ["frame.io", "f.io"] },
  { provider: "wetransfer", hosts: ["wetransfer.com", "we.tl"] },
  { provider: "lightroom", hosts: ["lightroom.adobe.com", "adobe.ly"] },
  { provider: "pixieset", hosts: ["pixieset.com"] },
];

/** True when `host` equals `domain` or is a subdomain of it. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Provider key for a URL, from its hostname (case-insensitive, subdomains
 * included). Unknown hosts and unparseable URLs → "other".
 */
export function deriveLinkProvider(raw: string): LinkProvider {
  const url = parseUrl(raw.trim());
  if (!url) return "other";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const entry of PROVIDER_HOSTS) {
    if (entry.hosts.some((d) => hostMatches(host, d))) return entry.provider;
  }
  return "other";
}

export const LinkUrlSchema = z
  .string({ error: "Enter a link" })
  .trim()
  .min(1, "Enter a link")
  .max(LINK_URL_MAX, `Keep links under ${LINK_URL_MAX} characters`)
  .refine(isAllowedLinkUrl, "Enter a full http:// or https:// link");

const LabelSchema = z
  .string()
  .trim()
  .max(LINK_LABEL_MAX, `Keep labels under ${LINK_LABEL_MAX} characters`)
  .transform((v) => (v.length === 0 ? null : v));

export const AddLinkInput = z.object({
  jobId: Id,
  kind: z.enum(LINK_KINDS),
  url: LinkUrlSchema,
  label: LabelSchema.nullish(),
});
export type AddLinkInput = z.input<typeof AddLinkInput>;

export const ReplaceLinkInput = z.object({
  linkId: Id,
  url: LinkUrlSchema,
  /** Omitted → keep the old label; null or "" → clear it. */
  label: LabelSchema.nullish(),
});
export type ReplaceLinkInput = z.input<typeof ReplaceLinkInput>;

/**
 * `PATCH /api/links/:id { kind?, label? }` — re-file a current link under
 * another kind and/or relabel it (same URL). At least one field required.
 */
export const UpdateLinkInput = z
  .object({
    linkId: Id,
    kind: z.enum(LINK_KINDS).optional(),
    /** Omitted → keep the old label; null or "" → clear it. */
    label: LabelSchema.nullish(),
  })
  .refine((v) => v.kind !== undefined || v.label !== undefined, { message: "Choose a new kind or label", path: ["kind"] });
export type UpdateLinkInput = z.input<typeof UpdateLinkInput>;

export const RemoveLinkInput = z.object({
  linkId: Id,
  reason: z
    .string()
    .trim()
    .max(LINK_REASON_MAX)
    .transform((v) => (v.length === 0 ? null : v))
    .nullish(),
});
export type RemoveLinkInput = z.input<typeof RemoveLinkInput>;
