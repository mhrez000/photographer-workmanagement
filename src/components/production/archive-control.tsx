"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api-client";

export interface ArchiveControlProps {
  entity: "client" | "project";
  id: string;
  name: string;
  version: number;
  archived: boolean;
  /** Open jobs (archiving is refused by the server while any are active). */
  openJobs: number;
  timeZone: string;
}

/** Archive / restore a client or project (O/M). Nothing is deleted; both are audited. */
export function ArchiveControl({ entity, id, name, version, archived, openJobs, timeZone }: ArchiveControlProps) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);
  const base = entity === "client" ? "/api/clients" : "/api/projects";
  const label = entity === "client" ? "client" : "project";

  const run = async (): Promise<boolean> => {
    try {
      await api.post(`${base}/${id}/${archived ? "restore" : "archive"}`, { expectedVersion: version });
      toast.success(archived ? `Restored “${name}”` : `Archived “${name}”`, archived ? undefined : "It's hidden from pickers and lists, and can be restored at any time.");
      router.refresh();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        setConflict(err);
        return true;
      }
      toast.error(archived ? `Couldn't restore the ${label}` : `Couldn't archive the ${label}`, errorMessage(err));
      return false;
    }
  };

  return (
    <>
      {archived ? (
        <Button variant="outline" size="sm" leadingIcon={<ArchiveRestore aria-hidden="true" />} onClick={() => setConfirm(true)}>
          Restore
        </Button>
      ) : (
        <Button variant="ghost" size="sm" leadingIcon={<Archive aria-hidden="true" />} onClick={() => setConfirm(true)}>
          Archive
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={archived ? `Restore ${label} “${name}”?` : `Archive ${label} “${name}”?`}
        description={
          archived
            ? `It will show up again in lists and when creating jobs.`
            : openJobs > 0
              ? `This ${label} still has ${openJobs} open job${openJobs === 1 ? "" : "s"}. Complete or cancel ${openJobs === 1 ? "it" : "them"} first — archiving will be refused until then.`
              : `It will be hidden from lists and pickers. Its jobs and history stay intact, and you can restore it at any time.`
        }
        confirmLabel={archived ? "Restore" : "Archive"}
        destructive={!archived}
        onConfirm={run}
      />
      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(o) => !o && setConflict(null)}
        error={conflict}
        entity={label}
        timeZone={timeZone}
        onReload={() => {
          setConflict(null);
          router.refresh();
        }}
      />
    </>
  );
}
